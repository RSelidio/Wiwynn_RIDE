/**
 * Pickup requests — the core workflow (spec §18).
 *
 * Every status change funnels through `transition`, which enforces the legal
 * move, stamps the matching timestamp, writes the audit row and broadcasts. A
 * route cannot skip a step or forget to notify, because there is no other way
 * to change a request's status.
 */

import type {
  CreateRequestBody,
  ListRequestsQuery,
  PickupRequest,
  PickupRequestView,
  RequestStatus,
  Role,
} from '@shuttle/shared-types';
import { distanceMeters, roleCanTransition, updateGeofenceCandidate, type GeofenceCandidate } from '@shuttle/shared-utils';
import { query, queryOne, withTransaction } from '../db/pool';
import {
  REQUEST_VIEW_FROM,
  REQUEST_VIEW_SELECT,
  rowToRequest,
  rowToRequestView,
} from '../db/rows';
import { badRequest, conflict, forbidden, notFound } from '../http/errors';
import { logger } from '../logger';
import { realtime } from '../realtime/bus';
import { record } from './audit.service';
import { getEta } from './eta.service';
import { notifyAdmins, notifyDriver, notifyEmployee } from './notifications.service';
import { getCommittedSeats, getShuttle } from './shuttles.service';
import { getPosition } from './gps.service';
import { getSettingsSync } from './settings.service';
import { getStop } from './routes.service';
import { getOpenShiftForDriver, getOpenShiftForShuttle, getOpenShifts } from './shifts.service';
import { attachPassenger, closeTripIfDone, openTripFor } from './trips.service';

export interface Actor {
  userId: string | null;
  role: Role | 'system';
  driverId?: string | null;
  employeeId?: string | null;
}

export const SYSTEM_ACTOR: Actor = { userId: null, role: 'system' };

/** In-memory debounce state; resets on backend restart and must be earned again with fresh GPS. */
const arrivalCandidates = new Map<string, GeofenceCandidate>();

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add the live fields the database does not hold: ETA to the pickup stop and
 * free seats on the assigned shuttle.
 */
async function enrich(views: PickupRequestView[]): Promise<PickupRequestView[]> {
  if (views.length === 0) return views;

  const [committed, shifts] = await Promise.all([getCommittedSeats(), getOpenShifts()]);
  const capacities = new Map<string, number>();
  for (const shift of shifts.values()) capacities.set(shift.shuttleId, shift.capacity);

  return Promise.all(
    views.map(async (view) => {
      if (view.shuttleId == null || view.status === 'completed' || view.status === 'cancelled') {
        return { ...view, etaSec: null, seatsAvailable: null };
      }

      const capacity = capacities.get(view.shuttleId);
      const seatsAvailable =
        capacity == null ? null : Math.max(0, capacity - (committed.get(view.shuttleId) ?? 0));

      // Once the shuttle has arrived the ETA is meaningless — the answer is "here".
      const etaSec =
        view.status === 'arrived' || view.status === 'boarding'
          ? 0
          : ((await getEta(view.shuttleId, view.pickupStopId))?.etaSec ?? null);

      return { ...view, etaSec, seatsAvailable };
    }),
  );
}

export async function getViewById(idOrCode: string): Promise<PickupRequestView> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrCode);

  const row = await queryOne(
    `SELECT ${REQUEST_VIEW_SELECT} ${REQUEST_VIEW_FROM}
     WHERE ${isUuid ? 'r.id = $1' : 'r.code = $1'}`,
    [idOrCode],
  );
  if (row == null) throw notFound('Request');

  const [view] = await enrich([rowToRequestView.one(row)!]);
  return view!;
}

export async function getRaw(id: string): Promise<PickupRequest> {
  const row = await queryOne(`SELECT * FROM pickup_requests WHERE id = $1`, [id]);
  if (row == null) throw notFound('Request');
  return rowToRequest.one(row)!;
}

export async function list(
  filters: ListRequestsQuery,
): Promise<{ items: PickupRequestView[]; total: number }> {
  const where: string[] = [];
  const values: unknown[] = [];

  const add = (clause: string, value: unknown) => {
    values.push(value);
    where.push(clause.replace('?', `$${values.length}`));
  };

  if (filters.status != null) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    if (statuses.length > 0) add('r.status = ANY(?)', statuses);
  }
  if (filters.shuttleId) add('r.shuttle_id = ?', filters.shuttleId);
  if (filters.driverId) add('r.driver_id = ?', filters.driverId);
  if (filters.employeeId) add('r.employee_id = ?', filters.employeeId);
  if (filters.from) add('r.requested_at >= ?', filters.from);
  if (filters.to) add("r.requested_at < (?::date + interval '1 day')", filters.to);

  // One value, two placeholders — bind it once and reference the index twice.
  if (filters.stopId) {
    values.push(filters.stopId);
    const i = values.length;
    where.push(`(r.pickup_stop_id = $${i} OR r.destination_stop_id = $${i})`);
  }

  if (filters.q) {
    // Free-text across the fields the admin search box is expected to cover.
    values.push(`%${filters.q.toLowerCase()}%`);
    const p = `$${values.length}`;
    where.push(`(
      lower(r.code) LIKE ${p} OR lower(e.display_name) LIKE ${p} OR
      lower(e.badge_no) LIKE ${p} OR lower(ps.name) LIKE ${p} OR
      lower(ds.name) LIKE ${p} OR lower(COALESCE(sh.name, '')) LIKE ${p} OR
      lower(r.status) LIKE ${p}
    )`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const countRow = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total ${REQUEST_VIEW_FROM} ${whereSql}`,
    values,
  );

  const rows = await query(
    `SELECT ${REQUEST_VIEW_SELECT} ${REQUEST_VIEW_FROM} ${whereSql}
     ORDER BY r.requested_at DESC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset],
  );

  return {
    items: await enrich(rowToRequestView.many(rows)),
    total: countRow?.total ?? 0,
  };
}

/** Everything still needing attention, newest first — the dispatch feed. */
export async function listOpen(): Promise<PickupRequestView[]> {
  const rows = await query(
    `SELECT ${REQUEST_VIEW_SELECT} ${REQUEST_VIEW_FROM}
     WHERE r.status IN ('pending', 'accepted', 'arrived', 'boarding')
     ORDER BY r.requested_at ASC`,
  );
  return enrich(rowToRequestView.many(rows));
}

/** The employee's own live request, if they have one. */
export async function getActiveForEmployee(employeeId: string): Promise<PickupRequestView | null> {
  const row = await queryOne(
    `SELECT ${REQUEST_VIEW_SELECT} ${REQUEST_VIEW_FROM}
     WHERE r.employee_id = $1 AND r.status IN ('pending', 'accepted', 'arrived', 'boarding')
     ORDER BY r.requested_at DESC
     LIMIT 1`,
    [employeeId],
  );
  if (row == null) return null;
  const [view] = await enrich([rowToRequestView.one(row)!]);
  return view!;
}

/** A driver's queue: what they have accepted but not yet finished. */
export async function listForDriver(driverId: string): Promise<PickupRequestView[]> {
  const rows = await query(
    `SELECT ${REQUEST_VIEW_SELECT} ${REQUEST_VIEW_FROM}
     WHERE r.driver_id = $1 AND r.status IN ('accepted', 'arrived', 'boarding')
     ORDER BY r.requested_at ASC`,
    [driverId],
  );
  return enrich(rowToRequestView.many(rows));
}

/** Pending, unassigned requests — what a driver may accept. */
export async function listOffers(): Promise<PickupRequestView[]> {
  const rows = await query(
    `SELECT ${REQUEST_VIEW_SELECT} ${REQUEST_VIEW_FROM}
     WHERE r.status = 'pending'
     ORDER BY r.requested_at ASC`,
  );
  return enrich(rowToRequestView.many(rows));
}

// ─────────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────────

export async function create(
  employeeId: string,
  body: CreateRequestBody,
  actor: Actor,
): Promise<PickupRequestView> {
  if (body.pickupStopId === body.destinationStopId) {
    throw badRequest('Pickup and destination must differ', {
      destinationStopId: ['Choose a different destination'],
    });
  }

  // One live request per employee is enforced by a partial unique index; check
  // first so the employee gets a useful message rather than a raw conflict.
  const existing = await getActiveForEmployee(employeeId);
  if (existing != null) {
    throw conflict(
      'REQUEST_ALREADY_OPEN',
      `You already have a live request (${existing.code}). Cancel it before making another.`,
    );
  }

  const stops = await queryOne<{ pickup_active: boolean; dest_active: boolean }>(
    `SELECT
       (SELECT is_active FROM stops WHERE id = $1) AS pickup_active,
       (SELECT is_active FROM stops WHERE id = $2) AS dest_active`,
    [body.pickupStopId, body.destinationStopId],
  );
  if (stops?.pickup_active !== true || stops?.dest_active !== true) {
    throw badRequest('That stop is not in service');
  }

  const row = await queryOne(
    `INSERT INTO pickup_requests
       (employee_id, pickup_stop_id, destination_stop_id, passenger_count, source, note)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id`,
    [
      employeeId,
      body.pickupStopId,
      body.destinationStopId,
      body.passengerCount,
      body.source ?? 'pwa',
      body.note ?? null,
    ],
  );

  const view = await getViewById(row!.id as string);

  await record({
    actorUserId: actor.userId,
    action: 'request.created',
    entityType: 'pickup_request',
    entityId: view.id,
    changes: {
      pickup: view.pickupStopName,
      destination: view.destinationStopName,
      passengers: view.passengerCount,
    },
  });

  realtime.requestChanged({ request: view, reason: 'created', actorUserId: actor.userId });

  // Offer it to every driver currently online, so whoever is closest can take it.
  for (const shift of (await getOpenShifts()).values()) {
    if (shift.isOnline) {
      realtime.requestOffered(shift.driverId, {
        request: view,
        reason: 'created',
        actorUserId: actor.userId,
      });
    }
  }

  logger.info({ requestId: view.id, code: view.code }, 'pickup request created');
  return view;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transitions
// ─────────────────────────────────────────────────────────────────────────────

/** Which timestamp column a status change stamps. */
const STAMP: Partial<Record<RequestStatus, string>> = {
  accepted: 'accepted_at',
  arrived: 'arrived_at',
  boarding: 'boarded_at',
  completed: 'completed_at',
  cancelled: 'cancelled_at',
  rejected: 'cancelled_at',
  expired: 'cancelled_at',
};

interface TransitionOptions {
  shuttleId?: string | null;
  driverId?: string | null;
  passengerCount?: number;
  reason?: string | null;
  /** Skip the role check — for system actions such as expiry. */
  system?: boolean;
}

/**
 * Move a request to a new status.
 *
 * The UPDATE carries `AND status = $expected`, so two concurrent callers cannot
 * both succeed: the second updates zero rows and gets a conflict. This is the
 * guard against a driver double-tapping "Accept" on two devices.
 */
async function transition(
  requestId: string,
  to: RequestStatus,
  actor: Actor,
  options: TransitionOptions = {},
): Promise<PickupRequestView> {
  const before = await getRaw(requestId);
  const from = before.status;

  if (from === to) {
    throw conflict('ALREADY_IN_STATE', `Request is already ${to}`);
  }
  if (!options.system && actor.role !== 'system') {
    if (!roleCanTransition(actor.role as Role, from, to)) {
      throw forbidden(`A ${actor.role} cannot move a request from ${from} to ${to}`);
    }
  }

  const stampColumn = STAMP[to];
  const sets = [`status = $2`];
  const values: unknown[] = [requestId, to];

  if (stampColumn != null) sets.push(`${stampColumn} = now()`);

  if (options.shuttleId !== undefined) {
    values.push(options.shuttleId);
    sets.push(`shuttle_id = $${values.length}`);
  }
  if (options.driverId !== undefined) {
    values.push(options.driverId);
    sets.push(`driver_id = $${values.length}`);
  }
  if (options.passengerCount !== undefined) {
    values.push(options.passengerCount);
    sets.push(`passenger_count = $${values.length}`);
  }
  if (options.reason !== undefined) {
    values.push(options.reason);
    sets.push(`cancel_reason = $${values.length}`);
  }

  values.push(from);
  const expectedIndex = values.length;

  const updated = await queryOne<{ id: string }>(
    `UPDATE pickup_requests
     SET ${sets.join(', ')}
     WHERE id = $1 AND status = $${expectedIndex}
     RETURNING id`,
    values,
  );

  if (updated == null) {
    // Someone else moved it between our read and our write.
    const current = await getRaw(requestId);
    throw conflict(
      'REQUEST_CHANGED',
      `Request is now ${current.status}; it can no longer be moved to ${to}`,
    );
  }

  const view = await getViewById(requestId);

  await record({
    actorUserId: actor.userId,
    action: `request.${to}`,
    entityType: 'pickup_request',
    entityId: requestId,
    changes: { from, to, ...(options.reason ? { reason: options.reason } : {}) },
  });

  const reason = to === 'accepted' ? 'accepted'
    : to === 'rejected' ? 'rejected'
    : to === 'arrived' ? 'arrived'
    : to === 'boarding' ? 'boarding'
    : to === 'completed' ? 'completed'
    : to === 'expired' ? 'expired'
    : 'cancelled';

  realtime.requestChanged({ request: view, reason, actorUserId: actor.userId });
  logger.info({ requestId, code: view.code, from, to }, 'request transitioned');

  return view;
}

/** Assign a shuttle to a pending request (admin) or accept it (driver). */
export async function assign(
  requestId: string,
  shuttleId: string,
  actor: Actor,
  explicitDriverId?: string,
): Promise<PickupRequestView> {
  const request = await getRaw(requestId);
  if (request.status !== 'pending') {
    throw conflict('NOT_PENDING', `Request is ${request.status}, so it cannot be assigned`);
  }

  const shuttle = await getShuttle(shuttleId);
  if (!shuttle.isActive) throw conflict('SHUTTLE_INACTIVE', 'That shuttle is out of service');

  const shift = await getOpenShiftForShuttle(shuttleId);
  const driverId = explicitDriverId ?? shift?.driverId ?? null;

  if (driverId == null) {
    throw conflict('NO_DRIVER_ON_SHIFT', `${shuttle.name} has no driver on shift`);
  }

  // Refuse an assignment the shuttle cannot physically take.
  const committed = (await getCommittedSeats()).get(shuttleId) ?? 0;
  if (committed + request.passengerCount > shuttle.capacity) {
    throw conflict(
      'NOT_ENOUGH_SEATS',
      `${shuttle.name} has ${shuttle.capacity - committed} seats free but the request needs ${request.passengerCount}`,
    );
  }

  const view = await transition(requestId, 'accepted', actor, { shuttleId, driverId });

  await notifyEmployee(view.employeeId, {
    kind: 'request_accepted',
    title: `${view.shuttleName} accepted your pickup`,
    body: `Arriving at ${view.pickupStopName}`,
    link: `/?request=${view.code}`,
  });
  await notifyDriver(driverId, {
    kind: 'system',
    title: `${view.code} assigned to you`,
    body: `${view.employeeName} · ${view.pickupStopName} → ${view.destinationStopName}`,
  });

  return view;
}

/** Driver accepts a pending request onto their own shuttle. */
export async function acceptAsDriver(requestId: string, driverId: string, userId: string) {
  const shift = await getOpenShiftForDriver(driverId);
  if (shift == null) {
    throw conflict('NO_OPEN_SHIFT', 'Start your shift before accepting requests');
  }
  return assign(requestId, shift.shuttleId, { userId, role: 'driver', driverId }, driverId);
}

export async function reject(
  requestId: string,
  actor: Actor,
  reason?: string | null,
): Promise<PickupRequestView> {
  const view = await transition(requestId, 'rejected', actor, { reason: reason ?? null });

  await notifyEmployee(view.employeeId, {
    kind: 'request_rejected',
    title: 'No shuttle could take your pickup',
    body: reason ?? 'Please try again shortly.',
  });

  return view;
}

export async function markArrived(requestId: string, actor: Actor): Promise<PickupRequestView> {
  if (actor.role === 'driver') {
    const request = await getRaw(requestId);
    const position = request.shuttleId == null ? null : getPosition(request.shuttleId);
    if (position == null || position.isStale) {
      throw conflict('GPS_UNAVAILABLE', 'A fresh shuttle GPS fix is required to confirm arrival.');
    }
    const pickup = await getStop(request.pickupStopId);
    const radius = pickup.geofenceM ?? getSettingsSync().stopGeofenceM;
    const distanceM = distanceMeters(position, pickup);
    const candidate = arrivalCandidates.get(requestId);
    if ((position.accuracyM ?? Number.POSITIVE_INFINITY) > Math.min(40, radius)) {
      throw conflict('GPS_INACCURATE', 'GPS accuracy is too low to confirm arrival. Wait for a better fix.');
    }
    if (distanceM > radius) {
      throw conflict('NOT_AT_PICKUP_STOP', `Move within ${radius} m of ${pickup.name} before confirming arrival.`);
    }
    if (candidate?.confirmed !== true || candidate.lastRecordedAt !== position.recordedAt) {
      throw conflict('ARRIVAL_CONFIRMING', 'GPS sees the shuttle inside the stop radius. Hold there briefly while another accurate fix confirms arrival.');
    }
    arrivalCandidates.delete(requestId);
  }

  const view = await transition(requestId, 'arrived', actor);

  await notifyEmployee(view.employeeId, {
    kind: 'shuttle_arrived',
    title: `${view.shuttleName} has arrived`,
    body: `Board at ${view.pickupStopName}`,
  });

  return view;
}

/**
 * Automatically mark this driver's accepted pickups arrived when fresh GPS
 * enters their configured pickup geofence. It deliberately reuses
 * `markArrived`, so radius/accuracy checks, audit, realtime updates and
 * employee notifications stay identical to the driver's manual action.
 */
export async function autoArriveAtPickupStops(
  shuttleId: string,
  driverId: string,
  userId: string,
): Promise<number> {
  const requests = await query<{ id: string }>(
    `SELECT id FROM pickup_requests
     WHERE shuttle_id = $1 AND driver_id = $2 AND status = 'accepted'
     ORDER BY accepted_at ASC`,
    [shuttleId, driverId],
  );

  let arrivedCount = 0;
  for (const request of requests) {
    const raw = await getRaw(request.id);
    const position = getPosition(shuttleId);
    const stop = await getStop(raw.pickupStopId);
    const radius = stop.geofenceM ?? getSettingsSync().stopGeofenceM;
    const candidate = updateGeofenceCandidate(arrivalCandidates.get(request.id) ?? null, {
      recordedAt: position?.recordedAt ?? '',
      observedAtMs: Date.now(),
      distanceM: position == null ? Number.POSITIVE_INFINITY : distanceMeters(position, stop),
      radiusM: radius,
      accuracyM: position?.accuracyM ?? null,
      fresh: position != null && !position.isStale,
    });
    if (candidate == null) arrivalCandidates.delete(request.id);
    else arrivalCandidates.set(request.id, candidate);
    if (candidate?.confirmed !== true || candidate.lastRecordedAt !== position?.recordedAt) continue;

    try {
      await markArrived(request.id, { userId, role: 'driver', driverId });
      arrivedCount += 1;
    } catch (error) {
      // Most fixes are outside a pickup radius; that is normal until the
      // shuttle arrives. Ignore only the expected proximity/freshness errors.
      if (
        error instanceof Error &&
        'code' in error &&
        ['NOT_AT_PICKUP_STOP', 'GPS_UNAVAILABLE', 'GPS_INACCURATE', 'REQUEST_CHANGED', 'ALREADY_IN_STATE'].includes(String(error.code))
      ) continue;
      throw error;
    }
  }
  return arrivedCount;
}

/**
 * Passenger boarded: open or join a trip, and record them on it.
 *
 * Trips are per-shuttle-journey, not per-request, so two employees boarding the
 * same shuttle for the same destination share one trip rather than generating
 * two — which is what makes "trips today" a meaningful number.
 */
export async function board(
  requestId: string,
  actor: Actor,
  passengerCount?: number,
): Promise<PickupRequestView> {
  const request = await getRaw(requestId);
  if (request.shuttleId == null || request.driverId == null) {
    throw conflict('NOT_ASSIGNED', 'Request has no shuttle assigned');
  }

  const view = await transition(requestId, 'boarding', actor, {
    ...(passengerCount !== undefined ? { passengerCount } : {}),
  });

  const trip = await openTripFor({
    shuttleId: request.shuttleId,
    driverId: request.driverId,
    originStopId: request.pickupStopId,
    destinationStopId: request.destinationStopId,
  });

  await query(`UPDATE pickup_requests SET trip_id = $2 WHERE id = $1`, [requestId, trip.id]);
  await attachPassenger(trip.id, request.employeeId, requestId);

  return getViewById(requestId);
}

export async function complete(requestId: string, actor: Actor): Promise<PickupRequestView> {
  const request = await getRaw(requestId);
  const view = await transition(requestId, 'completed', actor);

  if (request.tripId != null) await closeTripIfDone(request.tripId);

  await notifyEmployee(view.employeeId, {
    kind: 'trip_completed',
    title: 'Trip completed',
    body: `${view.pickupStopName} → ${view.destinationStopName}`,
    link: '/trips',
  });

  return view;
}

export async function cancel(
  requestId: string,
  actor: Actor,
  reason?: string | null,
): Promise<PickupRequestView> {
  const request = await getRaw(requestId);

  // An employee may only cancel their own.
  if (actor.role === 'employee' && request.employeeId !== actor.employeeId) {
    throw forbidden('You can only cancel your own request');
  }

  const view = await transition(requestId, 'cancelled', actor, { reason: reason ?? null });

  if (request.driverId != null && actor.role !== 'driver') {
    await notifyDriver(request.driverId, {
      kind: 'request_cancelled',
      title: `${view.code} was cancelled`,
      body: `${view.employeeName} · ${view.pickupStopName}`,
    });
  }
  if (actor.role !== 'employee') {
    await notifyEmployee(view.employeeId, {
      kind: 'request_cancelled',
      title: 'Your pickup was cancelled',
      body: reason ?? undefined,
    });
  }

  return view;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled housekeeping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expire pending requests nobody took.
 *
 * Without this, an unassigned request sits in the dispatch list forever and
 * blocks the employee from raising a new one.
 */
export async function expireStalePending(afterMinutes: number): Promise<number> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM pickup_requests
     WHERE status = 'pending'
       AND requested_at < now() - ($1 || ' minutes')::interval`,
    [String(afterMinutes)],
  );

  let expired = 0;
  for (const row of rows) {
    try {
      const view = await transition(row.id, 'expired', SYSTEM_ACTOR, {
        system: true,
        reason: `No shuttle accepted within ${afterMinutes} minutes`,
      });
      await notifyEmployee(view.employeeId, {
        kind: 'request_rejected',
        title: 'Your pickup request expired',
        body: 'No shuttle was available. Please request again.',
      });
      expired += 1;
    } catch (err) {
      logger.warn({ err, requestId: row.id }, 'could not expire request');
    }
  }

  return expired;
}

/** Escalate requests an employee has been waiting on too long. */
export async function escalateLongWaits(afterMinutes: number): Promise<number> {
  const rows = await query<{ id: string; code: string; employee_name: string; stop_name: string }>(
    `SELECT r.id, r.code, e.display_name AS employee_name, s.name AS stop_name
     FROM pickup_requests r
     JOIN employees e ON e.id = r.employee_id
     JOIN stops s     ON s.id = r.pickup_stop_id
     WHERE r.status = 'pending'
       AND r.requested_at < now() - ($1 || ' minutes')::interval`,
    [String(afterMinutes)],
  );

  for (const row of rows) {
    await notifyAdmins({
      kind: 'system',
      title: `${row.code} unassigned for over ${afterMinutes} min`,
      body: `${row.employee_name} · ${row.stop_name}`,
      link: `/requests?open=${row.code}`,
    });
  }

  return rows.length;
}

/** Re-export for the dispatch service, which needs the same transaction helper. */
export { withTransaction };
