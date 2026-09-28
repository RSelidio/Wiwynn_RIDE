import type { OnboardPassenger, ScanPassengerBadgeResult } from '@shuttle/shared-types';
import { conflict, notFound } from '../http/errors';
import { query, withTransaction } from '../db/pool';

export async function countOnboard(shiftId: string): Promise<number> {
  const rows = await query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM shuttle_passenger_boardings
     WHERE shift_id = $1 AND alighted_at IS NULL`,
    [shiftId],
  );
  return rows[0]?.count ?? 0;
}

export async function listOnboard(shiftId: string): Promise<OnboardPassenger[]> {
  const rows = await query<{
    boarding_id: string;
    employee_id: string;
    display_name: string;
    badge_no: string;
    rfid_tag: string;
    boarded_at: Date;
  }>(
    `SELECT b.id AS boarding_id, e.id AS employee_id, e.display_name, e.badge_no,
            b.rfid_tag, b.boarded_at
     FROM shuttle_passenger_boardings b
     JOIN employees e ON e.id = b.employee_id
     WHERE b.shift_id = $1 AND b.alighted_at IS NULL
     ORDER BY b.boarded_at`,
    [shiftId],
  );
  return rows.map((row) => ({
    boardingId: row.boarding_id,
    employeeId: row.employee_id,
    displayName: row.display_name,
    badgeNo: row.badge_no,
    rfidTag: row.rfid_tag,
    boardedAt: row.boarded_at.toISOString(),
  }));
}

export async function clearOnboard(shiftId: string, driverId: string): Promise<number> {
  return withTransaction(async (client) => {
    const shift = await client.query<{ id: string }>(
      `SELECT id FROM driver_shifts
       WHERE id = $1 AND driver_id = $2 AND ended_at IS NULL
       FOR UPDATE`,
      [shiftId, driverId],
    );
    if (shift.rowCount === 0) throw notFound('Open driver shift');

    const result = await client.query(
      `UPDATE shuttle_passenger_boardings
       SET alighted_at = now(), alight_method = 'manual_clear'
       WHERE shift_id = $1 AND alighted_at IS NULL`,
      [shiftId],
    );
    return result.rowCount ?? 0;
  });
}

/**
 * An RFID scan toggles the employee between inside and outside this shuttle.
 * The shift row serializes scans for capacity checks; employee row locking and
 * a partial unique index prevent one employee being counted on two shuttles.
 */
export async function scanBadge(
  shiftId: string,
  driverId: string,
  scannedTag: string,
): Promise<ScanPassengerBadgeResult> {
  const rfidTag = scannedTag.trim();
  if (!rfidTag) throw notFound('RFID badge');

  return withTransaction(async (client) => {
    const shiftResult = await client.query<{
      id: string;
      shuttle_id: string;
      capacity: number;
    }>(
      `SELECT ds.id, ds.shuttle_id, s.capacity
       FROM driver_shifts ds
       JOIN shuttles s ON s.id = ds.shuttle_id
       WHERE ds.id = $1 AND ds.driver_id = $2 AND ds.ended_at IS NULL
       FOR UPDATE OF ds`,
      [shiftId, driverId],
    );
    const shift = shiftResult.rows[0];
    if (shift == null) throw notFound('Open driver shift');

    const employeeResult = await client.query<{
      id: string;
      display_name: string;
      badge_no: string;
      rfid_tag: string;
    }>(
      `SELECT e.id, e.display_name, e.badge_no, e.rfid_tag
       FROM employees e
       JOIN users u ON u.id = e.user_id
       WHERE lower(e.rfid_tag) = lower($1) AND e.is_active AND u.is_active
       FOR UPDATE OF e`,
      [rfidTag],
    );
    const employee = employeeResult.rows[0];
    if (employee == null) throw notFound('Active employee for RFID badge');

    const openResult = await client.query<{ id: string; shuttle_id: string; boarded_at: Date }>(
      `SELECT id, shuttle_id, boarded_at
       FROM shuttle_passenger_boardings
       WHERE employee_id = $1 AND alighted_at IS NULL
       FOR UPDATE`,
      [employee.id],
    );
    const open = openResult.rows[0];

    let action: 'in' | 'out';
    if (open != null) {
      if (open.shuttle_id !== shift.shuttle_id) {
        throw conflict('PASSENGER_ON_OTHER_SHUTTLE', 'This employee is already recorded inside another shuttle.');
      }
      if (Date.now() - new Date(open.boarded_at).getTime() < 2_000) {
        throw conflict('DUPLICATE_RFID_SCAN', 'Badge was just scanned. Wait briefly before scanning it again.');
      }
      await client.query(
        `UPDATE shuttle_passenger_boardings SET alighted_at = now(), alight_method = 'rfid' WHERE id = $1`,
        [open.id],
      );
      action = 'out';
    } else {
      const recent = await client.query<{ boarded_at: Date; alighted_at: Date }>(
        `SELECT boarded_at, alighted_at
         FROM shuttle_passenger_boardings
         WHERE employee_id = $1 AND shuttle_id = $2
         ORDER BY boarded_at DESC LIMIT 1`,
        [employee.id, shift.shuttle_id],
      );
      const latest = recent.rows[0];
      if (latest?.alighted_at != null && Date.now() - new Date(latest.alighted_at).getTime() < 2_000) {
        throw conflict('DUPLICATE_RFID_SCAN', 'Badge was just scanned. Wait briefly before scanning it again.');
      }

      const countResult = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM shuttle_passenger_boardings
         WHERE shift_id = $1 AND alighted_at IS NULL`,
        [shiftId],
      );
      const onboard = countResult.rows[0]?.count ?? 0;
      if (onboard >= shift.capacity) throw conflict('SHUTTLE_FULL', 'Shuttle is at capacity.');

      await client.query(
        `INSERT INTO shuttle_passenger_boardings
           (shuttle_id, shift_id, driver_id, employee_id, rfid_tag)
         VALUES ($1,$2,$3,$4,$5)`,
        [shift.shuttle_id, shiftId, driverId, employee.id, employee.rfid_tag],
      );
      action = 'in';
    }

    const countResult = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM shuttle_passenger_boardings
       WHERE shift_id = $1 AND alighted_at IS NULL`,
      [shiftId],
    );

    return {
      action,
      employeeId: employee.id,
      employeeName: employee.display_name,
      badgeNo: employee.badge_no,
      onboardCount: countResult.rows[0]?.count ?? 0,
      capacity: shift.capacity,
    };
  });
}
