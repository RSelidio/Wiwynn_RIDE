/**
 * Shuttle read models.
 *
 * `ShuttleStatusView` is the single shape every surface uses to draw a shuttle:
 * the employee's tracking list, the driver's own header, the admin fleet cards.
 * Composing it in one place means "seats free" and "next stop" cannot disagree
 * between two screens.
 */

import type {
  LivePosition,
  Shuttle,
  ShuttleOperationalStatus,
  ShuttleStatusView,
} from '@shuttle/shared-types';
import { distanceMeters } from '@shuttle/shared-utils';
import { query, queryOne } from '../db/pool';
import { rowToShuttle } from '../db/rows';
import { notFound } from '../http/errors';
import { getBoard } from './eta.service';
import { getAllPositions, getPosition } from './gps.service';
import { listStops, roadPathBetween } from './routes.service';
import { getSettingsSync } from './settings.service';
import { getOpenShifts, type OpenShift } from './shifts.service';

export async function listShuttles(includeInactive = false): Promise<Shuttle[]> {
  return rowToShuttle.many(
    await query(
      `SELECT * FROM shuttles ${includeInactive ? '' : 'WHERE is_active'} ORDER BY code`,
    ),
  );
}

export async function getShuttle(id: string): Promise<Shuttle> {
  const shuttle = rowToShuttle.one(await queryOne(`SELECT * FROM shuttles WHERE id = $1`, [id]));
  if (shuttle == null) throw notFound('Shuttle');
  return shuttle;
}

/**
 * Seats committed per shuttle, from requests that are riding or about to.
 *
 * Counted from the request table rather than tracked as a column so it cannot
 * drift: cancel a request and the seat is free on the next read, with no
 * compensating update to forget.
 */
export async function getCommittedSeats(): Promise<Map<string, number>> {
  const rows = await query<{ shuttle_id: string; seats: number }>(
    `SELECT shuttle_id, COALESCE(SUM(passenger_count), 0)::int AS seats
     FROM pickup_requests
     WHERE shuttle_id IS NOT NULL
       AND status IN ('accepted', 'arrived', 'boarding')
     GROUP BY shuttle_id`,
  );

  const map = new Map<string, number>();
  for (const r of rows) map.set(r.shuttle_id, r.seats);
  return map;
}

/** Open request counts per shuttle, for the driver's queue badge. */
async function getOpenRequestCounts(): Promise<Map<string, number>> {
  const rows = await query<{ shuttle_id: string; count: number }>(
    `SELECT shuttle_id, count(*)::int AS count
     FROM pickup_requests
     WHERE shuttle_id IS NOT NULL AND status IN ('accepted', 'arrived', 'boarding')
     GROUP BY shuttle_id`,
  );
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.shuttle_id, r.count);
  return map;
}

function operationalStatus(
  shift: OpenShift | undefined,
  hasFreeSeats: boolean,
  atStopId: string | null,
  isStale: boolean,
): ShuttleOperationalStatus {
  if (shift == null) return 'off_shift';
  if (!shift.isOnline) return 'offline';
  // A stale fix is not the same as offline — the driver may be mid-tunnel —
  // but treating it as "en route" would show a marker that is not moving.
  if (isStale) return 'offline';
  if (!hasFreeSeats) return 'full';
  if (atStopId != null) return 'at_stop';
  return 'en_route';
}

/** Which stop, if any, the shuttle is standing inside the geofence of. */
async function resolveAtStop(
  latitude: number,
  longitude: number,
): Promise<{ id: string; name: string } | null> {
  const stops = await listStops();
  const fallbackRadius = getSettingsSync().stopGeofenceM;

  let closest: { id: string; name: string; distance: number } | null = null;

  for (const stop of stops) {
    const radius = stop.geofenceM ?? fallbackRadius;
    const distance = distanceMeters(
      { latitude, longitude },
      { latitude: stop.latitude, longitude: stop.longitude },
    );
    if (distance <= radius && (closest == null || distance < closest.distance)) {
      closest = { id: stop.id, name: stop.name, distance };
    }
  }

  return closest == null ? null : { id: closest.id, name: closest.name };
}

/** Compose the status view for one shuttle. */
export async function getStatus(shuttleId: string): Promise<ShuttleStatusView> {
  const shuttle = await getShuttle(shuttleId);
  const [shifts, committed, openCounts] = await Promise.all([
    getOpenShifts(),
    getCommittedSeats(),
    getOpenRequestCounts(),
  ]);
  return buildStatus(shuttle, shifts.get(shuttleId), committed, openCounts);
}

/** Road geometry from the latest shuttle fix to the next route stop. */
export async function getNavigationPath(
  shuttleId: string,
  destinationStopId?: string,
): Promise<Array<{ latitude: number; longitude: number }> | null> {
  const position = getPosition(shuttleId);
  if (position == null || position.isStale) return null;

  const stops = await listStops();
  let targetStopId = destinationStopId;
  if (targetStopId == null) targetStopId = (await getStatus(shuttleId)).nextStopId ?? undefined;
  if (targetStopId == null) return null;

  const targetStop = stops.find((stop) => stop.id === targetStopId);
  if (targetStop == null) return null;

  return roadPathBetween(position, targetStop);
}

/** Compose status views for the whole fleet in one pass. */
export async function listStatuses(includeInactive = false): Promise<ShuttleStatusView[]> {
  const [shuttles, shifts, committed, openCounts] = await Promise.all([
    listShuttles(includeInactive),
    getOpenShifts(),
    getCommittedSeats(),
    getOpenRequestCounts(),
  ]);

  return Promise.all(
    shuttles.map((s) => buildStatus(s, shifts.get(s.id), committed, openCounts)),
  );
}

async function buildStatus(
  shuttle: Shuttle,
  shift: OpenShift | undefined,
  committed: Map<string, number>,
  openCounts: Map<string, number>,
): Promise<ShuttleStatusView> {
  const position = getPosition(shuttle.id);
  const seatsOccupied = Math.min(shuttle.capacity, committed.get(shuttle.id) ?? 0);
  const seatsAvailable = Math.max(0, shuttle.capacity - seatsOccupied);

  const atStop =
    position == null || position.isStale
      ? null
      : await resolveAtStop(position.latitude, position.longitude);

  // Next stop comes from the ETA board, which already knows where the shuttle
  // sits on its route — no need to re-derive it here.
  let nextStopId: string | null = null;
  let nextStopName: string | null = null;
  let nextStopEtaSec: number | null = null;

  if (shift != null) {
    const board = await getBoard(shuttle.id);
    const next = board?.estimates[0];
    if (next != null) {
      nextStopId = next.stopId;
      nextStopEtaSec = next.etaSec;
      const stops = await listStops();
      nextStopName = stops.find((s) => s.id === next.stopId)?.name ?? null;
    }
  }

  return {
    shuttle,
    driverId: shift?.driverId ?? null,
    driverName: shift?.driverName ?? null,
    shiftId: shift?.shiftId ?? null,
    status: operationalStatus(shift, seatsAvailable > 0, atStop?.id ?? null, position?.isStale ?? true),
    position,
    seatsOccupied,
    seatsAvailable,
    routeId: shift?.routeId ?? null,
    routeName: shift?.routeName ?? null,
    nextStopId,
    nextStopName,
    nextStopEtaSec,
    atStopId: atStop?.id ?? null,
    atStopName: atStop?.name ?? null,
    openRequestCount: openCounts.get(shuttle.id) ?? 0,
  };
}

export type NamedPosition = LivePosition & { shuttleName: string };

/** Live positions with their shuttle names, for the admin map layer. */
export async function listPositions(): Promise<NamedPosition[]> {
  const shuttles = await listShuttles(true);
  const names = new Map(shuttles.map((s) => [s.id, s.name]));

  return getAllPositions().map((p) => ({
    ...p,
    shuttleName: names.get(p.shuttleId) ?? 'Unknown',
  }));
}

export async function createShuttle(input: {
  code: string;
  name: string;
  plateNo: string;
  model?: string | null;
  capacity?: number;
  defaultRouteId?: string | null;
}): Promise<Shuttle> {
  const row = await queryOne(
    `INSERT INTO shuttles (code, name, plate_no, model, capacity, default_route_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.code, input.name, input.plateNo, input.model ?? null, input.capacity ?? 12, input.defaultRouteId ?? null],
  );
  return rowToShuttle.one(row)!;
}

export async function updateShuttle(
  id: string,
  patch: Partial<{ code: string; name: string; plateNo: string; model: string | null; capacity: number; defaultRouteId: string | null; isActive: boolean }>,
): Promise<Shuttle> {
  const columns: Record<string, string> = {
    code: 'code', name: 'name', plateNo: 'plate_no', model: 'model',
    capacity: 'capacity', defaultRouteId: 'default_route_id', isActive: 'is_active',
  };

  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [key, value] of Object.entries(patch)) {
    const column = columns[key];
    if (column == null || value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length === 0) return getShuttle(id);

  const row = await queryOne(
    `UPDATE shuttles SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    values,
  );
  if (row == null) throw notFound('Shuttle');
  return rowToShuttle.one(row)!;
}
