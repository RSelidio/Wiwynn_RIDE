/**
 * Driver shifts — who is driving what, on which route, right now.
 *
 * The open-shift set is read on every ETA computation and every dispatch
 * snapshot, so it is cached for a few seconds. Shift changes are rare
 * (a handful per day) and a 5-second lag on "Marcus started his shift" has no
 * operational consequence.
 */

import type { DriverShift } from '@shuttle/shared-types';
import { query, queryOne } from '../db/pool';
import { rowToShift } from '../db/rows';
import { conflict, notFound } from '../http/errors';
import { clearPosition } from './gps.service';

const CACHE_TTL_MS = 5_000;

export interface OpenShift {
  shiftId: string;
  shuttleId: string;
  shuttleName: string;
  shuttleCode: string;
  capacity: number;
  driverId: string;
  driverName: string;
  routeId: string | null;
  routeName: string | null;
  isOnline: boolean;
  startedAt: string;
}

let cache: { byShuttle: Map<string, OpenShift>; readAt: number } | null = null;

function invalidate(): void {
  cache = null;
}

export async function getOpenShifts(): Promise<Map<string, OpenShift>> {
  if (cache != null && Date.now() - cache.readAt < CACHE_TTL_MS) return cache.byShuttle;

  const rows = await query<{
    shift_id: string;
    shuttle_id: string;
    shuttle_name: string;
    shuttle_code: string;
    capacity: number;
    driver_id: string;
    driver_name: string;
    route_id: string | null;
    route_name: string | null;
    is_online: boolean;
    started_at: Date;
  }>(
    `SELECT ds.id AS shift_id, ds.shuttle_id, sh.name AS shuttle_name, sh.code AS shuttle_code,
            sh.capacity, ds.driver_id, dr.display_name AS driver_name,
            ds.route_id, ro.name AS route_name, ds.is_online, ds.started_at
     FROM driver_shifts ds
     JOIN shuttles sh ON sh.id = ds.shuttle_id
     JOIN drivers dr  ON dr.id = ds.driver_id
     LEFT JOIN routes ro ON ro.id = ds.route_id
     WHERE ds.ended_at IS NULL`,
  );

  const byShuttle = new Map<string, OpenShift>();
  for (const r of rows) {
    byShuttle.set(r.shuttle_id, {
      shiftId: r.shift_id,
      shuttleId: r.shuttle_id,
      shuttleName: r.shuttle_name,
      shuttleCode: r.shuttle_code,
      capacity: r.capacity,
      driverId: r.driver_id,
      driverName: r.driver_name,
      routeId: r.route_id,
      routeName: r.route_name,
      isOnline: r.is_online,
      startedAt: r.started_at.toISOString(),
    });
  }

  cache = { byShuttle, readAt: Date.now() };
  return byShuttle;
}

export async function getOpenShiftForShuttle(shuttleId: string): Promise<OpenShift | null> {
  return (await getOpenShifts()).get(shuttleId) ?? null;
}

export async function getOpenShiftForDriver(driverId: string): Promise<OpenShift | null> {
  for (const shift of (await getOpenShifts()).values()) {
    if (shift.driverId === driverId) return shift;
  }
  return null;
}

/**
 * Open a shift.
 *
 * The partial unique indexes on `driver_shifts` make one-open-per-driver and
 * one-open-per-shuttle a database guarantee, so a double-tapped "Start shift"
 * raises a unique violation rather than creating a second shift. We check first
 * only to return a helpful message instead of a bare 409.
 */
export async function startShift(
  driverId: string,
  shuttleId: string,
  routeId: string | null,
): Promise<DriverShift> {
  const open = await getOpenShifts();

  for (const shift of open.values()) {
    if (shift.driverId === driverId) {
      throw conflict('SHIFT_ALREADY_OPEN', `You already have an open shift on ${shift.shuttleName}`);
    }
  }
  const onShuttle = open.get(shuttleId);
  if (onShuttle != null) {
    throw conflict(
      'SHUTTLE_IN_USE',
      `${onShuttle.shuttleName} is already signed out to ${onShuttle.driverName}`,
    );
  }

  const active = await queryOne<{ is_active: boolean }>(
    `SELECT is_active FROM shuttles WHERE id = $1`,
    [shuttleId],
  );
  if (active == null) throw notFound('Shuttle');
  if (!active.is_active) throw conflict('SHUTTLE_INACTIVE', 'That shuttle is out of service');

  const row = await queryOne(
    `INSERT INTO driver_shifts (driver_id, shuttle_id, route_id, is_online)
     VALUES ($1, $2, $3, true)
     RETURNING *`,
    [driverId, shuttleId, routeId],
  );

  invalidate();
  return rowToShift.one(row)!;
}

/**
 * Close a shift.
 *
 * Clears the in-memory position so the shuttle reads as off-shift immediately
 * rather than showing a frozen marker until the fix ages out.
 */
export async function endShift(shiftId: string, driverId: string): Promise<DriverShift> {
  const row = await queryOne(
    `UPDATE driver_shifts
     SET ended_at = now(), is_online = false
     WHERE id = $1 AND driver_id = $2 AND ended_at IS NULL
     RETURNING *`,
    [shiftId, driverId],
  );
  if (row == null) throw notFound('Open shift');

  const shift = rowToShift.one(row)!;
  clearPosition(shift.shuttleId);
  invalidate();
  return shift;
}

export async function setOnline(
  shiftId: string,
  driverId: string,
  isOnline: boolean,
): Promise<DriverShift> {
  const row = await queryOne(
    `UPDATE driver_shifts
     SET is_online = $3
     WHERE id = $1 AND driver_id = $2 AND ended_at IS NULL
     RETURNING *`,
    [shiftId, driverId, isOnline],
  );
  if (row == null) throw notFound('Open shift');
  invalidate();
  return rowToShift.one(row)!;
}

/** Verify a shift belongs to this driver and is still open — used by GPS ingest. */
export async function assertOwnedOpenShift(shiftId: string, driverId: string): Promise<OpenShift> {
  const shift = await getOpenShiftForDriver(driverId);
  if (shift == null || shift.shiftId !== shiftId) {
    throw notFound('Open shift for this driver');
  }
  return shift;
}

export async function listShiftsForDriver(driverId: string, limit = 30): Promise<DriverShift[]> {
  return rowToShift.many(
    await query(
      `SELECT * FROM driver_shifts WHERE driver_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [driverId, limit],
    ),
  );
}

export function invalidateShiftCache(): void {
  invalidate();
}
