/**
 * Reports (spec §9, §20 analytics).
 *
 * Read-only aggregates over requests and trips. Everything is computed in
 * PostgreSQL rather than in Node — the fleet is small today, but pulling a
 * quarter of trips into memory to average them would not survive growth.
 */

import type {
  PopularStopReport,
  ReportQuery,
  ReportsSummary,
  UtilizationReport,
  WaitTimeReport,
} from '@shuttle/shared-types';
import { appDateKey, shiftDateKey, toCsv } from '@shuttle/shared-utils';
import { query } from '../db/pool';
import { getKpis } from './dispatch.service';

/** Default window: the last 7 days, ending today. */
function resolveWindow(filters: ReportQuery): { from: string; to: string } {
  const to = filters.to ?? appDateKey();
  const from = filters.from ?? shiftDateKey(to, -6);
  return { from, to };
}

/**
 * Wait time by hour of day — request raised to shuttle arrived.
 *
 * Bucketing by hour rather than by day is what surfaces the 08:00–09:00 peak
 * the dashboard calls out; a daily mean hides it entirely.
 */
export async function waitTimes(filters: ReportQuery): Promise<WaitTimeReport[]> {
  const { from, to } = resolveWindow(filters);

  const rows = await query<{
    bucket: string;
    requests: number;
    avg_wait_sec: number | null;
    p90_wait_sec: number | null;
  }>(
    `SELECT to_char(date_trunc('hour', requested_at), 'HH24:00') AS bucket,
            count(*)::int AS requests,
            AVG(EXTRACT(EPOCH FROM (arrived_at - requested_at))) AS avg_wait_sec,
            PERCENTILE_CONT(0.9) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (arrived_at - requested_at))
            ) AS p90_wait_sec
     FROM pickup_requests
     WHERE requested_at >= $1::date
       AND requested_at <  ($2::date + interval '1 day')
       AND arrived_at IS NOT NULL
       AND ($3::uuid IS NULL OR pickup_stop_id = $3)
     GROUP BY date_trunc('hour', requested_at)
     ORDER BY 1`,
    [from, to, filters.stopId ?? null],
  );

  return rows.map((r) => ({
    bucket: r.bucket,
    requests: r.requests,
    avgWaitSec: r.avg_wait_sec == null ? null : Math.round(r.avg_wait_sec),
    p90WaitSec: r.p90_wait_sec == null ? null : Math.round(r.p90_wait_sec),
  }));
}

export async function utilization(filters: ReportQuery): Promise<UtilizationReport[]> {
  const { from, to } = resolveWindow(filters);

  const rows = await query<{
    shuttle_id: string;
    shuttle_name: string;
    trips: number;
    passengers: number;
    capacity: number;
    active_minutes: number;
  }>(
    `SELECT sh.id AS shuttle_id, sh.name AS shuttle_name, sh.capacity,
            count(t.id)::int AS trips,
            COALESCE(SUM(t.passenger_count), 0)::int AS passengers,
            COALESCE((
              SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(ds.ended_at, now()) - ds.started_at)) / 60)
              FROM driver_shifts ds
              WHERE ds.shuttle_id = sh.id
                AND ds.started_at >= $1::date
                AND ds.started_at <  ($2::date + interval '1 day')
            ), 0)::int AS active_minutes
     FROM shuttles sh
     LEFT JOIN trips t
       ON t.shuttle_id = sh.id
      AND t.status = 'completed'
      AND t.departed_at >= $1::date
      AND t.departed_at <  ($2::date + interval '1 day')
     WHERE ($3::uuid IS NULL OR sh.id = $3)
     GROUP BY sh.id, sh.name, sh.capacity
     ORDER BY sh.code`,
    [from, to, filters.shuttleId ?? null],
  );

  return rows.map((r) => ({
    shuttleId: r.shuttle_id,
    shuttleName: r.shuttle_name,
    trips: r.trips,
    passengers: r.passengers,
    // Seats filled against seats offered: passengers / (trips × capacity).
    seatUtilizationPct:
      r.trips === 0 ? null : Math.round((r.passengers / (r.trips * r.capacity)) * 100),
    activeMinutes: r.active_minutes,
  }));
}

export async function popularStops(filters: ReportQuery): Promise<PopularStopReport[]> {
  const { from, to } = resolveWindow(filters);

  const rows = await query<{
    stop_id: string;
    stop_name: string;
    pickups: number;
    dropoffs: number;
  }>(
    `SELECT s.id AS stop_id, s.name AS stop_name,
            count(*) FILTER (WHERE r.pickup_stop_id = s.id)::int AS pickups,
            count(*) FILTER (WHERE r.destination_stop_id = s.id)::int AS dropoffs
     FROM stops s
     LEFT JOIN pickup_requests r
       ON (r.pickup_stop_id = s.id OR r.destination_stop_id = s.id)
      AND r.requested_at >= $1::date
      AND r.requested_at <  ($2::date + interval '1 day')
      AND r.status = 'completed'
     GROUP BY s.id, s.name, s.display_order
     ORDER BY (count(*) FILTER (WHERE r.pickup_stop_id = s.id)) DESC, s.display_order`,
    [from, to],
  );

  return rows.map((r) => ({
    stopId: r.stop_id,
    stopName: r.stop_name,
    pickups: r.pickups,
    dropoffs: r.dropoffs,
  }));
}

export async function summary(filters: ReportQuery): Promise<ReportsSummary> {
  const { from, to } = resolveWindow(filters);
  const [kpis, wait, util, stops] = await Promise.all([
    getKpis(),
    waitTimes(filters),
    utilization(filters),
    popularStops(filters),
  ]);

  return { kpis, waitTimes: wait, utilization: util, popularStops: stops, from, to };
}

/** Trip-level CSV export for the admin "Export report" action. */
export async function tripsCsv(filters: ReportQuery): Promise<string> {
  const { from, to } = resolveWindow(filters);

  const rows = await query<{
    code: string;
    shuttle_name: string;
    driver_name: string;
    origin: string;
    destination: string;
    departed_at: Date;
    arrived_at: Date | null;
    duration_min: number | null;
    passenger_count: number;
    distance_m: number | null;
  }>(
    `SELECT t.code, sh.name AS shuttle_name, dr.display_name AS driver_name,
            os.name AS origin, ds.name AS destination,
            t.departed_at, t.arrived_at,
            EXTRACT(EPOCH FROM (t.arrived_at - t.departed_at)) / 60 AS duration_min,
            t.passenger_count, t.distance_m
     FROM trips t
     JOIN shuttles sh ON sh.id = t.shuttle_id
     JOIN drivers dr  ON dr.id = t.driver_id
     JOIN stops os    ON os.id = t.origin_stop_id
     JOIN stops ds    ON ds.id = t.destination_stop_id
     WHERE t.departed_at >= $1::date
       AND t.departed_at <  ($2::date + interval '1 day')
       AND ($3::uuid IS NULL OR t.shuttle_id = $3)
     ORDER BY t.departed_at DESC`,
    [from, to, filters.shuttleId ?? null],
  );

  return toCsv(
    ['trip', 'shuttle', 'driver', 'origin', 'destination', 'departed', 'arrived', 'duration_min', 'passengers', 'distance_m'],
    rows.map((r) => [
      r.code,
      r.shuttle_name,
      r.driver_name,
      r.origin,
      r.destination,
      r.departed_at.toISOString(),
      r.arrived_at?.toISOString() ?? '',
      r.duration_min == null ? '' : r.duration_min.toFixed(1),
      r.passenger_count,
      r.distance_m ?? '',
    ]),
  );
}

/** Request-level CSV export, including the ones nobody served. */
export async function requestsCsv(filters: ReportQuery): Promise<string> {
  const { from, to } = resolveWindow(filters);

  const rows = await query<{
    code: string;
    employee_name: string;
    department: string | null;
    pickup: string;
    destination: string;
    passenger_count: number;
    status: string;
    shuttle_name: string | null;
    requested_at: Date;
    wait_sec: number | null;
  }>(
    `SELECT r.code, e.display_name AS employee_name, e.department,
            ps.name AS pickup, ds.name AS destination,
            r.passenger_count, r.status, sh.name AS shuttle_name, r.requested_at,
            EXTRACT(EPOCH FROM (r.arrived_at - r.requested_at)) AS wait_sec
     FROM pickup_requests r
     JOIN employees e ON e.id = r.employee_id
     JOIN stops ps    ON ps.id = r.pickup_stop_id
     JOIN stops ds    ON ds.id = r.destination_stop_id
     LEFT JOIN shuttles sh ON sh.id = r.shuttle_id
     WHERE r.requested_at >= $1::date
       AND r.requested_at <  ($2::date + interval '1 day')
     ORDER BY r.requested_at DESC`,
    [from, to],
  );

  return toCsv(
    ['request', 'employee', 'department', 'pickup', 'destination', 'passengers', 'status', 'shuttle', 'requested', 'wait_sec'],
    rows.map((r) => [
      r.code,
      r.employee_name,
      r.department ?? '',
      r.pickup,
      r.destination,
      r.passenger_count,
      r.status,
      r.shuttle_name ?? '',
      r.requested_at.toISOString(),
      r.wait_sec == null ? '' : Math.round(r.wait_sec),
    ]),
  );
}
