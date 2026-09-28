/**
 * Trips — a shuttle's journey between two stops, carrying one or more
 * passengers.
 *
 * A trip is per-journey, not per-request: two employees boarding the same
 * shuttle for the same destination ride one trip. That is what makes "46 trips
 * today, 112 passengers" mean what a dispatcher expects it to mean.
 */

import type { ListRequestsQuery, Trip, TripView } from '@shuttle/shared-types';
import { query, queryOne } from '../db/pool';
import { TRIP_VIEW_FROM, TRIP_VIEW_SELECT, rowToTrip, rowToTripView } from '../db/rows';
import { notFound } from '../http/errors';
import { logger } from '../logger';
import { realtime } from '../realtime/bus';
import { getOdometerM } from './gps.service';
import { recordSegmentObservation } from './routes.service';
import { getOpenShiftForShuttle } from './shifts.service';

export async function getView(id: string): Promise<TripView> {
  const row = await queryOne(
    `SELECT ${TRIP_VIEW_SELECT} ${TRIP_VIEW_FROM} WHERE t.id = $1`,
    [id],
  );
  if (row == null) throw notFound('Trip');
  return rowToTripView.one(row)!;
}

export async function list(
  filters: Pick<ListRequestsQuery, 'limit' | 'offset' | 'shuttleId' | 'driverId' | 'from' | 'to' | 'q'>,
): Promise<{ items: TripView[]; total: number }> {
  const where: string[] = [];
  const values: unknown[] = [];

  const add = (clause: string, value: unknown) => {
    values.push(value);
    where.push(clause.replace('?', `$${values.length}`));
  };

  if (filters.shuttleId) add('t.shuttle_id = ?', filters.shuttleId);
  if (filters.driverId) add('t.driver_id = ?', filters.driverId);
  if (filters.from) add('t.departed_at >= ?', filters.from);
  if (filters.to) add("t.departed_at < (?::date + interval '1 day')", filters.to);

  if (filters.q) {
    values.push(`%${filters.q.toLowerCase()}%`);
    const p = `$${values.length}`;
    where.push(`(
      lower(t.code) LIKE ${p} OR lower(sh.name) LIKE ${p} OR
      lower(dr.display_name) LIKE ${p} OR lower(os.name) LIKE ${p} OR lower(ds.name) LIKE ${p}
    )`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const countRow = await queryOne<{ total: number }>(
    `SELECT count(*)::int AS total ${TRIP_VIEW_FROM} ${whereSql}`,
    values,
  );

  const rows = await query(
    `SELECT ${TRIP_VIEW_SELECT} ${TRIP_VIEW_FROM} ${whereSql}
     ORDER BY t.departed_at DESC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, offset],
  );

  return { items: rowToTripView.many(rows), total: countRow?.total ?? 0 };
}

/** An employee's own trip history, newest first. */
export async function listForEmployee(employeeId: string, limit = 20): Promise<TripView[]> {
  const rows = await query(
    `SELECT ${TRIP_VIEW_SELECT} ${TRIP_VIEW_FROM}
     JOIN trip_passengers tp ON tp.trip_id = t.id
     WHERE tp.employee_id = $1
     ORDER BY t.departed_at DESC
     LIMIT $2`,
    [employeeId, limit],
  );
  return rowToTripView.many(rows);
}

/**
 * Find the shuttle's open trip, or start one.
 *
 * Reuses an open trip only when it is heading to the same destination —
 * otherwise a second passenger with a different drop-off would be silently
 * folded into someone else's journey.
 */
export async function openTripFor(input: {
  shuttleId: string;
  driverId: string;
  originStopId: string;
  destinationStopId: string;
}): Promise<Trip> {
  const existing = await queryOne(
    `SELECT * FROM trips
     WHERE shuttle_id = $1 AND status = 'in_progress' AND destination_stop_id = $2
     ORDER BY departed_at DESC
     LIMIT 1`,
    [input.shuttleId, input.destinationStopId],
  );

  if (existing != null) return rowToTrip.one(existing)!;

  const shift = await getOpenShiftForShuttle(input.shuttleId);

  const row = await queryOne(
    `INSERT INTO trips
       (shuttle_id, driver_id, shift_id, route_id, origin_stop_id, destination_stop_id,
        status, passenger_count)
     VALUES ($1,$2,$3,$4,$5,$6,'in_progress',0)
     RETURNING *`,
    [
      input.shuttleId,
      input.driverId,
      shift?.shiftId ?? null,
      shift?.routeId ?? null,
      input.originStopId,
      input.destinationStopId,
    ],
  );

  const trip = rowToTrip.one(row)!;
  realtime.tripChanged({ trip: await getView(trip.id), reason: 'started' });
  logger.info({ tripId: trip.id, code: trip.code }, 'trip started');
  return trip;
}

/** Record a passenger on a trip and refresh its head-count. */
export async function attachPassenger(
  tripId: string,
  employeeId: string,
  requestId: string | null,
): Promise<void> {
  await query(
    `INSERT INTO trip_passengers (trip_id, employee_id, request_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (trip_id, employee_id) DO NOTHING`,
    [tripId, employeeId, requestId],
  );

  // Derive the count from the requests on the trip rather than incrementing,
  // so a corrected passenger_count on a request flows through.
  await query(
    `UPDATE trips t
     SET passenger_count = COALESCE((
       SELECT SUM(r.passenger_count)::int
       FROM pickup_requests r
       WHERE r.trip_id = t.id
     ), 0)
     WHERE t.id = $1`,
    [tripId],
  );
}

/**
 * Close a trip once every request riding it has finished.
 *
 * Also folds the observed origin→destination duration into the route's segment
 * statistics, which is how the ETA engine learns (spec §6).
 */
export async function closeTripIfDone(tripId: string): Promise<void> {
  const pending = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM pickup_requests
     WHERE trip_id = $1 AND status IN ('accepted', 'arrived', 'boarding')`,
    [tripId],
  );

  if ((pending?.count ?? 0) > 0) return;

  const trip = rowToTrip.one(
    await queryOne(`SELECT * FROM trips WHERE id = $1 AND status = 'in_progress'`, [tripId]),
  );
  if (trip == null) return;

  const distanceM = Math.round(getOdometerM(trip.shuttleId));

  await query(
    `UPDATE trips
     SET status = 'completed', arrived_at = now(),
         distance_m = CASE WHEN $2 > 0 THEN $2 ELSE distance_m END
     WHERE id = $1`,
    [tripId, distanceM],
  );

  const closed = await getView(tripId);

  if (closed.routeId != null && closed.arrivedAt != null) {
    const travelSec = Math.round(
      (new Date(closed.arrivedAt).getTime() - new Date(closed.departedAt).getTime()) / 1000,
    );
    await recordSegmentObservation(
      closed.routeId,
      closed.originStopId,
      closed.destinationStopId,
      travelSec,
    );
  }

  await query(`UPDATE trip_passengers SET dropped_at = now() WHERE trip_id = $1 AND dropped_at IS NULL`, [tripId]);

  realtime.tripChanged({ trip: closed, reason: 'completed' });
  logger.info({ tripId, code: closed.code }, 'trip completed');
}

/** Abandon an open trip — used when every request on it was cancelled. */
export async function cancelTrip(tripId: string): Promise<void> {
  const row = await queryOne(
    `UPDATE trips
     SET status = 'cancelled', arrived_at = now()
     WHERE id = $1 AND status = 'in_progress'
     RETURNING id`,
    [tripId],
  );
  if (row == null) return;
  realtime.tripChanged({ trip: await getView(tripId), reason: 'cancelled' });
}

/** Counts for the dashboard KPI row. */
export async function todayTotals(): Promise<{ trips: number; passengers: number }> {
  const row = await queryOne<{ trips: number; passengers: number }>(
    `SELECT count(*)::int AS trips,
            COALESCE(SUM(passenger_count), 0)::int AS passengers
     FROM trips
     WHERE departed_at >= date_trunc('day', now()) AND status <> 'cancelled'`,
  );
  return { trips: row?.trips ?? 0, passengers: row?.passengers ?? 0 };
}
