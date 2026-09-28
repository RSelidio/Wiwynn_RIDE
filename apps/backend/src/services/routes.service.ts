/**
 * Stops and routes (spec §4, §5).
 *
 * Route geometry is cached: the ETA engine reads it on every GPS fix, and
 * routes change a few times a year. Any write clears the cache.
 */

import type { Route, RouteStop, RouteWithStops, Stop, UpsertRouteBody, UpsertStopBody } from '@shuttle/shared-types';
import { distanceMeters } from '@shuttle/shared-utils';
import { query, queryOne, withTransaction } from '../db/pool';
import { rowToRoute, rowToStop } from '../db/rows';
import { badRequest, notFound } from '../http/errors';
import { config } from '../config';
import { logger } from '../logger';

const CACHE_TTL_MS = 60_000;

let routeCache: { value: RouteWithStops[]; readAt: number } | null = null;
let stopCache: { value: Stop[]; readAt: number } | null = null;
const roadRouteCache = new Map<string, { value: RouteWithStops; readAt: number }>();
const livePathCache = new Map<string, { value: Array<{ latitude: number; longitude: number }> | null; readAt: number }>();

function invalidate(): void {
  routeCache = null;
  stopCache = null;
  roadRouteCache.clear();
  livePathCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Stops
// ─────────────────────────────────────────────────────────────────────────────

export async function listStops(includeInactive = false): Promise<Stop[]> {
  if (!includeInactive && stopCache != null && Date.now() - stopCache.readAt < CACHE_TTL_MS) {
    return stopCache.value;
  }

  const rows = await query(
    `SELECT * FROM stops
     ${includeInactive ? '' : 'WHERE is_active'}
     ORDER BY display_order, name`,
  );
  const stops = rowToStop.many(rows);

  if (!includeInactive) stopCache = { value: stops, readAt: Date.now() };
  return stops;
}

export async function getStop(id: string): Promise<Stop> {
  const stop = rowToStop.one(await queryOne(`SELECT * FROM stops WHERE id = $1`, [id]));
  if (stop == null) throw notFound('Stop');
  return stop;
}

export async function createStop(body: UpsertStopBody): Promise<Stop> {
  const row = await queryOne(
    `INSERT INTO stops
       (code, name, description, latitude, longitude, kind, geofence_m, is_active, display_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      body.code, body.name, body.description ?? null, body.latitude, body.longitude,
      body.kind, body.geofenceM ?? null, body.isActive ?? true, body.displayOrder ?? 0,
    ],
  );
  invalidate();
  return rowToStop.one(row)!;
}

export async function updateStop(id: string, body: Partial<UpsertStopBody>): Promise<Stop> {
  const columns: Record<string, string> = {
    code: 'code', name: 'name', description: 'description', latitude: 'latitude',
    longitude: 'longitude', kind: 'kind', geofenceM: 'geofence_m',
    isActive: 'is_active', displayOrder: 'display_order',
  };

  const sets: string[] = [];
  const values: unknown[] = [id];

  for (const [key, value] of Object.entries(body)) {
    const column = columns[key];
    if (column == null || value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length === 0) return getStop(id);

  const row = await queryOne(
    `UPDATE stops SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    values,
  );
  if (row == null) throw notFound('Stop');
  invalidate();
  return rowToStop.one(row)!;
}

/**
 * Deactivate rather than delete.
 *
 * Stops are referenced by historical requests and trips with ON DELETE RESTRICT,
 * so a hard delete would either fail or destroy history. Retiring a stop keeps
 * last quarter's reports readable.
 */
export async function deactivateStop(id: string): Promise<Stop> {
  const row = await queryOne(
    `UPDATE stops SET is_active = false WHERE id = $1 RETURNING *`,
    [id],
  );
  if (row == null) throw notFound('Stop');
  invalidate();
  return rowToStop.one(row)!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

interface RouteStopRow extends Record<string, unknown> {
  id: string;
  route_id: string;
  stop_id: string;
  stop_order: number;
}

export async function listRoutes(includeInactive = false): Promise<RouteWithStops[]> {
  if (!includeInactive && routeCache != null && Date.now() - routeCache.readAt < CACHE_TTL_MS) {
    return routeCache.value;
  }

  const routeRows = await query(
    `SELECT * FROM routes ${includeInactive ? '' : 'WHERE is_active'} ORDER BY name`,
  );
  const routes = rowToRoute.many(routeRows);
  if (routes.length === 0) return [];

  // One query for all legs, then group in memory — avoids N+1 across routes.
  const legRows = await query<RouteStopRow>(
    `SELECT rs.*, row_to_json(s.*) AS stop_json
     FROM route_stops rs
     JOIN stops s ON s.id = rs.stop_id
     WHERE rs.route_id = ANY($1::uuid[])
     ORDER BY rs.route_id, rs.stop_order`,
    [routes.map((r) => r.id)],
  );

  const byRoute = new Map<string, RouteWithStops['stops']>();
  for (const row of legRows) {
    const { stop_json: stopJson, ...legRow } = row as RouteStopRow & { stop_json: Record<string, unknown> };
    const leg = {
      ...(camelLeg(legRow)),
      stop: rowToStop.one(stopJson)!,
    };
    const list = byRoute.get(row.route_id) ?? [];
    list.push(leg);
    byRoute.set(row.route_id, list);
  }

  const rawRoutes: RouteWithStops[] = routes.map((r) => ({ ...r, stops: byRoute.get(r.id) ?? [] }));
  const result = await Promise.all(rawRoutes.map(withRoadRouting));
  if (!includeInactive) routeCache = { value: result, readAt: Date.now() };
  return result;
}

interface OsrmRouteResponse {
  code?: string;
  routes?: Array<{
    geometry?: { coordinates?: Array<[number, number]> };
    legs?: Array<{ distance?: number; duration?: number }>;
  }>;
}

/** Road-following navigation from a live shuttle fix to a selected stop. */
export async function roadPathBetween(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): Promise<Array<{ latitude: number; longitude: number }> | null> {
  if (distanceMeters(from, to) > 100_000) return null;

  // Round cache coordinates to keep rapid GPS updates from creating a new
  // routing request every few seconds while still refreshing as the shuttle moves.
  const key = [from.latitude, from.longitude, to.latitude, to.longitude]
    .map((coordinate) => coordinate.toFixed(3))
    .join(':');
  const cached = livePathCache.get(key);
  if (cached != null && Date.now() - cached.readAt < config.routing.cacheTtlMs) return cached.value;

  const baseUrl = config.routing.osrmBaseUrl;
  if (!baseUrl) return null;

  const coordinates = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
  const url = `${baseUrl}/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false&alternatives=false`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(config.routing.requestTimeoutMs) });
    if (!response.ok) throw new Error(`OSRM returned HTTP ${response.status}`);
    const payload = await response.json() as OsrmRouteResponse;
    const points = payload.code === 'Ok' ? payload.routes?.[0]?.geometry?.coordinates : undefined;
    if (points == null || points.length < 2) throw new Error(`OSRM returned no route (code ${payload.code ?? 'unknown'})`);
    const path = points.map(([longitude, latitude]) => ({ latitude, longitude }));
    livePathCache.set(key, { value: path, readAt: Date.now() });
    return path;
  } catch (error) {
    logger.warn({ err: error }, 'live road routing unavailable');
    livePathCache.set(key, { value: null, readAt: Date.now() });
    return null;
  }
}

/** Enrich configured route stops with road-snapped geometry and per-road leg metrics. */
async function withRoadRouting(route: RouteWithStops): Promise<RouteWithStops> {
  const cacheKey = `${route.id}:${route.updatedAt}`;
  const cached = roadRouteCache.get(cacheKey);
  if (cached != null && Date.now() - cached.readAt < config.routing.cacheTtlMs) return cached.value;

  const ordered = [...route.stops].sort((a, b) => a.stopOrder - b.stopOrder);
  const base = { ...route, stops: ordered, roadPath: null } satisfies RouteWithStops;
  const baseUrl = config.routing.osrmBaseUrl;
  if (!baseUrl || ordered.length < 2 || ordered.length > 100) {
    roadRouteCache.set(cacheKey, { value: base, readAt: Date.now() });
    return base;
  }

  const routeStops = route.isLoop ? [...ordered, ordered[0]!] : ordered;
  // Prevent a route containing leftover demo coordinates (e.g. Taiwan and El
  // Paso) from causing nonsensical cross-continent route requests.
  for (let index = 1; index < routeStops.length; index++) {
    if (distanceMeters(routeStops[index - 1]!.stop, routeStops[index]!.stop) > 100_000) {
      roadRouteCache.set(cacheKey, { value: base, readAt: Date.now() });
      return base;
    }
  }

  const coordinates = routeStops.map((leg) => `${leg.stop.longitude},${leg.stop.latitude}`).join(';');
  const url = `${baseUrl}/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false&alternatives=false`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(config.routing.requestTimeoutMs) });
    if (!response.ok) throw new Error(`OSRM returned HTTP ${response.status}`);
    const payload = await response.json() as OsrmRouteResponse;
    const roadRoute = payload.code === 'Ok' ? payload.routes?.[0] : undefined;
    const coordinatesLngLat = roadRoute?.geometry?.coordinates;
    const roadLegs = roadRoute?.legs;
    if (coordinatesLngLat == null || coordinatesLngLat.length < 2 || roadLegs == null) {
      throw new Error(`OSRM returned no driving route (code ${payload.code ?? 'unknown'})`);
    }

    const enrichedStops = ordered.map((leg, index) => {
      const roadLegIndex = route.isLoop ? (index + ordered.length - 1) % ordered.length : index - 1;
      if (roadLegIndex < 0) return leg;
      const roadLeg = roadLegs[roadLegIndex];
      if (roadLeg?.distance == null || roadLeg.duration == null) return leg;
      return {
        ...leg,
        distanceFromPrevM: Math.round(roadLeg.distance),
        typicalTravelSec: Math.round(roadLeg.duration),
      };
    });
    const enriched: RouteWithStops = {
      ...route,
      stops: enrichedStops,
      roadPath: coordinatesLngLat.map(([longitude, latitude]) => ({ latitude, longitude })),
    };
    roadRouteCache.set(cacheKey, { value: enriched, readAt: Date.now() });
    return enriched;
  } catch (error) {
    logger.warn({ err: error, routeId: route.id }, 'road routing unavailable; using configured route values');
    roadRouteCache.set(cacheKey, { value: base, readAt: Date.now() });
    return base;
  }
}

function camelLeg(row: Record<string, unknown>): RouteStop {
  return {
    id: row.id as string,
    routeId: row.route_id as string,
    stopId: row.stop_id as string,
    stopOrder: row.stop_order as number,
    distanceFromPrevM: (row.distance_from_prev_m as number | null) ?? null,
    typicalTravelSec: (row.typical_travel_sec as number | null) ?? null,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '');
}

export async function getRoute(id: string): Promise<RouteWithStops> {
  const all = await listRoutes(true);
  const route = all.find((r) => r.id === id);
  if (route == null) throw notFound('Route');
  return route;
}

/** Plain route rows, for pickers that do not need the leg list. */
export async function listRoutesFlat(): Promise<Route[]> {
  return rowToRoute.many(await query(`SELECT * FROM routes WHERE is_active ORDER BY name`));
}

/**
 * Create or replace a route and its full ordered leg list.
 *
 * The legs are replaced wholesale inside a transaction: a partial reorder would
 * leave the route temporarily inconsistent, and the ETA engine could read it
 * mid-write and place a shuttle on a route that briefly has two stop 3s.
 */
export async function upsertRoute(body: UpsertRouteBody, routeId?: string): Promise<RouteWithStops> {
  if (body.stops.length < 2) {
    throw badRequest('A route needs at least two stops', { stops: ['Provide two or more stops'] });
  }

  const orders = body.stops.map((s) => s.stopOrder);
  if (new Set(orders).size !== orders.length) {
    throw badRequest('Two stops share the same position', { stops: ['stopOrder must be unique'] });
  }

  const id = await withTransaction(async (client) => {
    let targetId = routeId;

    if (targetId == null) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO routes (code, name, description, is_loop, is_active)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [body.code, body.name, body.description ?? null, body.isLoop ?? false, body.isActive ?? true],
      );
      targetId = rows[0]!.id;
    } else {
      const { rowCount } = await client.query(
        `UPDATE routes SET code = $2, name = $3, description = $4, is_loop = $5, is_active = $6 WHERE id = $1`,
        [targetId, body.code, body.name, body.description ?? null, body.isLoop ?? false, body.isActive ?? true],
      );
      if (rowCount === 0) throw notFound('Route');
      await client.query(`DELETE FROM route_stops WHERE route_id = $1`, [targetId]);
    }

    for (const leg of body.stops) {
      await client.query(
        `INSERT INTO route_stops
           (route_id, stop_id, stop_order, distance_from_prev_m, typical_travel_sec)
         VALUES ($1,$2,$3,$4,$5)`,
        [targetId, leg.stopId, leg.stopOrder, leg.distanceFromPrevM ?? null, leg.typicalTravelSec ?? null],
      );
    }

    return targetId;
  });

  invalidate();
  return getRoute(id);
}

/** Force a cache refresh — used after a seed or an external schema change. */
export function invalidateRouteCache(): void {
  invalidate();
}

// ─────────────────────────────────────────────────────────────────────────────
// Observed segment times, for the ETA engine (spec §6)
// ─────────────────────────────────────────────────────────────────────────────

export interface SegmentStat {
  routeId: string;
  fromStopId: string;
  toStopId: string;
  sampleCount: number;
  meanTravelSec: number | null;
}

let statsCache: { value: Map<string, SegmentStat>; readAt: number } | null = null;

function statKey(routeId: string, fromStopId: string, toStopId: string): string {
  return `${routeId}|${fromStopId}|${toStopId}`;
}

export async function getSegmentStats(): Promise<Map<string, SegmentStat>> {
  if (statsCache != null && Date.now() - statsCache.readAt < CACHE_TTL_MS) {
    return statsCache.value;
  }

  const rows = await query<{
    route_id: string;
    from_stop_id: string;
    to_stop_id: string;
    sample_count: number;
    mean_travel_sec: number | null;
  }>(
    // Below three samples the mean is noise, so it is not worth blending in.
    `SELECT route_id, from_stop_id, to_stop_id, sample_count, mean_travel_sec
     FROM route_segment_stats
     WHERE sample_count >= 3 AND mean_travel_sec IS NOT NULL`,
  );

  const map = new Map<string, SegmentStat>();
  for (const r of rows) {
    map.set(statKey(r.route_id, r.from_stop_id, r.to_stop_id), {
      routeId: r.route_id,
      fromStopId: r.from_stop_id,
      toStopId: r.to_stop_id,
      sampleCount: r.sample_count,
      meanTravelSec: r.mean_travel_sec,
    });
  }

  statsCache = { value: map, readAt: Date.now() };
  return map;
}

export function lookupSegmentStat(
  stats: Map<string, SegmentStat>,
  routeId: string,
  fromStopId: string,
  toStopId: string,
): SegmentStat | null {
  return stats.get(statKey(routeId, fromStopId, toStopId)) ?? null;
}

/**
 * Fold a completed trip's observed duration into the running mean.
 *
 * Welford-style incremental update, so we never re-read the trip table to
 * recompute an average.
 */
export async function recordSegmentObservation(
  routeId: string,
  fromStopId: string,
  toStopId: string,
  travelSec: number,
): Promise<void> {
  if (travelSec <= 0 || travelSec > 7_200) return; // implausible; ignore

  await query(
    `INSERT INTO route_segment_stats
       (route_id, from_stop_id, to_stop_id, sample_count, mean_travel_sec, stddev_sec)
     VALUES ($1, $2, $3, 1, $4, 0)
     ON CONFLICT (route_id, from_stop_id, to_stop_id) DO UPDATE SET
       sample_count = route_segment_stats.sample_count + 1,
       mean_travel_sec =
         route_segment_stats.mean_travel_sec
         + ($4 - route_segment_stats.mean_travel_sec) / (route_segment_stats.sample_count + 1),
       updated_at = now()`,
    [routeId, fromStopId, toStopId, travelSec],
  );

  statsCache = null;
}
