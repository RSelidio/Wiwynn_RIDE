/**
 * Gate log — the security guard tablet at the Main Building gate
 * (design doc §4a).
 *
 * The guard's job is narrow: stamp a shuttle in when it stops, stamp it out
 * when it leaves, optionally record a head-count and a remark, and correct
 * their own mistakes. Everything reporting-shaped lives in the admin dashboard,
 * which reads these rows.
 */

import type {
  Gate,
  GateCheckInBody,
  GateCheckOutBody,
  GateLogView,
  ListGateLogsQuery,
  UpdateGateLogBody,
} from '@shuttle/shared-types';
import { toCsv } from '@shuttle/shared-utils';
import { query, queryOne } from '../db/pool';
import { GATE_LOG_VIEW_FROM, GATE_LOG_VIEW_SELECT, rowToGate, rowToGateLogView } from '../db/rows';
import { badRequest, conflict, notFound } from '../http/errors';
import { logger } from '../logger';
import { realtime } from '../realtime/bus';
import { record } from './audit.service';
import { getOpenShiftForShuttle } from './shifts.service';

export async function listGates(): Promise<Gate[]> {
  return rowToGate.many(await query(`SELECT * FROM gates WHERE is_active ORDER BY name`));
}

export async function getView(id: string): Promise<GateLogView> {
  const row = await queryOne(
    `SELECT ${GATE_LOG_VIEW_SELECT} ${GATE_LOG_VIEW_FROM} WHERE g.id = $1`,
    [id],
  );
  if (row == null) throw notFound('Gate log entry');
  return rowToGateLogView.one(row)!;
}

export async function list(
  filters: ListGateLogsQuery,
): Promise<{ items: GateLogView[]; total: number }> {
  const where: string[] = [];
  const values: unknown[] = [];

  const add = (clause: string, value: unknown) => {
    values.push(value);
    where.push(clause.replace('?', `$${values.length}`));
  };

  if (filters.gateId) add('g.gate_id = ?', filters.gateId);
  if (filters.shuttleId) add('g.shuttle_id = ?', filters.shuttleId);
  if (filters.from) add('g.checked_in_at >= ?', filters.from);
  if (filters.to) add("g.checked_in_at < (?::date + interval '1 day')", filters.to);
  if (filters.state === 'open') where.push('g.checked_out_at IS NULL');
  if (filters.state === 'closed') where.push('g.checked_out_at IS NOT NULL');

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  const countRow = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total ${GATE_LOG_VIEW_FROM} ${whereSql}`,
    values,
  );

  const rows = await query(
    `SELECT ${GATE_LOG_VIEW_SELECT} ${GATE_LOG_VIEW_FROM} ${whereSql}
     ORDER BY g.checked_in_at DESC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset],
  );

  return { items: rowToGateLogView.many(rows), total: countRow?.total ?? 0 };
}

/** Entries still open at a gate — the "at gate" cards on the tablet. */
export async function listOpenAtGate(gateId: string): Promise<GateLogView[]> {
  const rows = await query(
    `SELECT ${GATE_LOG_VIEW_SELECT} ${GATE_LOG_VIEW_FROM}
     WHERE g.gate_id = $1 AND g.checked_out_at IS NULL
     ORDER BY g.checked_in_at DESC`,
    [gateId],
  );
  return rowToGateLogView.many(rows);
}

/**
 * Stamp a shuttle in.
 *
 * The driver is taken from the open shift when the caller does not name one, so
 * the guard never has to pick a driver from a list — the dispatch system
 * already knows who is behind the wheel.
 */
export async function checkIn(body: GateCheckInBody, guardUserId: string): Promise<GateLogView> {
  const alreadyIn = await queryOne<{ code: string }>(
    `SELECT code FROM gate_logs
     WHERE gate_id = $1 AND shuttle_id = $2 AND checked_out_at IS NULL`,
    [body.gateId, body.shuttleId],
  );
  if (alreadyIn != null) {
    throw conflict(
      'ALREADY_CHECKED_IN',
      `That shuttle is already checked in on ${alreadyIn.code}. Check it out first.`,
    );
  }

  const shift = await getOpenShiftForShuttle(body.shuttleId);
  const driverId = body.driverId ?? shift?.driverId ?? null;

  const row = await queryOne<{ id: string }>(
    `INSERT INTO gate_logs
       (gate_id, shuttle_id, driver_id, guard_user_id, checked_in_at)
     VALUES ($1,$2,$3,$4, COALESCE($5::timestamptz, now()))
     RETURNING id`,
    [body.gateId, body.shuttleId, driverId, guardUserId, body.checkedInAt ?? null],
  );

  const entry = await getView(row!.id);

  await record({
    actorUserId: guardUserId,
    action: 'gate.checked_in',
    entityType: 'gate_log',
    entityId: entry.id,
    changes: { shuttle: entry.shuttleName, at: entry.checkedInAt },
  });

  realtime.gateChanged({ entry, reason: 'checked_in' });
  logger.info({ code: entry.code, shuttle: entry.shuttleName }, 'gate check-in');
  return entry;
}

/** Stamp the open entry out, optionally recording the head-count and a remark. */
export async function checkOut(
  logId: string,
  body: GateCheckOutBody,
  guardUserId: string,
): Promise<GateLogView> {
  const row = await queryOne<{ id: string }>(
    `UPDATE gate_logs
     SET checked_out_at = COALESCE($2::timestamptz, now()),
         passenger_count = COALESCE($3, passenger_count),
         remark = COALESCE($4, remark)
     WHERE id = $1 AND checked_out_at IS NULL
     RETURNING id`,
    [logId, body.checkedOutAt ?? null, body.passengerCount ?? null, body.remark ?? null],
  );

  if (row == null) {
    throw conflict('NOT_CHECKED_IN', 'That entry is not open — it may already be checked out');
  }

  const entry = await getView(logId);

  await record({
    actorUserId: guardUserId,
    action: 'gate.checked_out',
    entityType: 'gate_log',
    entityId: logId,
    changes: { at: entry.checkedOutAt, passengers: entry.passengerCount },
  });

  realtime.gateChanged({ entry, reason: 'checked_out' });
  logger.info({ code: entry.code, shuttle: entry.shuttleName }, 'gate check-out');
  return entry;
}

/** Live passenger-count edit while the shuttle is still standing at the gate. */
export async function setPassengerCount(
  logId: string,
  passengerCount: number,
  guardUserId: string,
): Promise<GateLogView> {
  const row = await queryOne<{ id: string }>(
    `UPDATE gate_logs SET passenger_count = $2 WHERE id = $1 RETURNING id`,
    [logId, passengerCount],
  );
  if (row == null) throw notFound('Gate log entry');

  const entry = await getView(logId);
  realtime.gateChanged({ entry, reason: 'edited' });
  await record({
    actorUserId: guardUserId,
    action: 'gate.passengers_set',
    entityType: 'gate_log',
    entityId: logId,
    changes: { passengers: passengerCount },
  });
  return entry;
}

/**
 * Correct an entry.
 *
 * Marks `was_edited`, which both the tablet and the admin report show, so a
 * corrected time is never mistaken for an original stamp. Passing
 * `checkedOutAt: null` re-opens an entry that was closed by mistake.
 */
export async function update(
  logId: string,
  body: UpdateGateLogBody,
  guardUserId: string,
): Promise<GateLogView> {
  const before = await getView(logId);

  const checkedInAt = body.checkedInAt ?? before.checkedInAt;
  const checkedOutAt =
    body.checkedOutAt === undefined ? before.checkedOutAt : body.checkedOutAt;

  if (checkedOutAt != null && new Date(checkedOutAt) < new Date(checkedInAt)) {
    throw badRequest('Check-out cannot be before check-in', {
      checkedOutAt: ['Must be at or after the check-in time'],
    });
  }

  const row = await queryOne<{ id: string }>(
    `UPDATE gate_logs
     SET checked_in_at = $2,
         checked_out_at = $3,
         passenger_count = COALESCE($4, passenger_count),
         remark = $5,
         was_edited = true
     WHERE id = $1
     RETURNING id`,
    [
      logId,
      checkedInAt,
      checkedOutAt,
      body.passengerCount ?? null,
      body.remark === undefined ? before.remark : body.remark,
    ],
  );
  if (row == null) throw notFound('Gate log entry');

  const entry = await getView(logId);

  await record({
    actorUserId: guardUserId,
    action: 'gate.edited',
    entityType: 'gate_log',
    entityId: logId,
    changes: {
      checkedInAt: { from: before.checkedInAt, to: entry.checkedInAt },
      checkedOutAt: { from: before.checkedOutAt, to: entry.checkedOutAt },
      passengerCount: { from: before.passengerCount, to: entry.passengerCount },
    },
  });

  realtime.gateChanged({ entry, reason: 'edited' });
  return entry;
}

/** Remove an entry stamped in error. Audited, because the row disappears. */
export async function remove(logId: string, guardUserId: string): Promise<void> {
  const entry = await getView(logId);

  await query(`DELETE FROM gate_logs WHERE id = $1`, [logId]);

  await record({
    actorUserId: guardUserId,
    action: 'gate.removed',
    entityType: 'gate_log',
    entityId: logId,
    changes: {
      code: entry.code,
      shuttle: entry.shuttleName,
      checkedInAt: entry.checkedInAt,
      passengers: entry.passengerCount,
    },
  });

  realtime.gateChanged({ entry, reason: 'removed' });
  logger.info({ code: entry.code }, 'gate log entry removed');
}

/** Today's summary for the admin reports KPI row. */
export async function todaySummary(gateId?: string): Promise<{
  checkIns: number;
  atGateNow: number;
  passengers: number;
  avgDwellSec: number | null;
  editedCount: number;
}> {
  const row = await queryOne<{
    check_ins: number;
    at_gate_now: number;
    passengers: number;
    avg_dwell_sec: number | null;
    edited_count: number;
  }>(
    `SELECT count(*)::int AS check_ins,
            count(*) FILTER (WHERE checked_out_at IS NULL)::int AS at_gate_now,
            COALESCE(SUM(passenger_count), 0)::int AS passengers,
            AVG(EXTRACT(EPOCH FROM (checked_out_at - checked_in_at)))
              FILTER (WHERE checked_out_at IS NOT NULL) AS avg_dwell_sec,
            count(*) FILTER (WHERE was_edited)::int AS edited_count
     FROM gate_logs
     WHERE checked_in_at >= date_trunc('day', now())
       AND ($1::uuid IS NULL OR gate_id = $1)`,
    [gateId ?? null],
  );

  return {
    checkIns: row?.check_ins ?? 0,
    atGateNow: row?.at_gate_now ?? 0,
    passengers: row?.passengers ?? 0,
    avgDwellSec: row?.avg_dwell_sec ?? null,
    editedCount: row?.edited_count ?? 0,
  };
}

/** CSV export, matching the column order the admin report shows. */
export async function exportCsv(filters: ListGateLogsQuery): Promise<string> {
  const { items } = await list({ ...filters, limit: 10_000, offset: 0 });

  return toCsv(
    ['log_id', 'gate', 'check_in', 'check_out', 'dwell_min', 'shuttle', 'plate', 'driver', 'passengers', 'remark', 'guard', 'edited'],
    items.map((e) => [
      e.code,
      e.gateName,
      e.checkedInAt,
      e.checkedOutAt ?? '',
      e.dwellSec == null ? '' : (e.dwellSec / 60).toFixed(1),
      e.shuttleName,
      e.shuttlePlateNo,
      e.driverName ?? '',
      e.passengerCount,
      e.remark ?? '',
      e.guardName,
      e.wasEdited ? 'yes' : 'no',
    ]),
  );
}
