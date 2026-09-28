/**
 * Dispatch — the fleet-wide read model and optional auto-assignment.
 *
 * The snapshot is what the admin dashboard renders and what a joining admin
 * socket receives, so "waiting employees" on the KPI row and the request table
 * below it are computed from the same query in the same instant.
 */

import type {
  DashboardKpis,
  DispatchSnapshotPayload,
  StopWaitingSummary,
} from '@shuttle/shared-types';
import { query, queryOne } from '../db/pool';
import { logger } from '../logger';
import { realtime } from '../realtime/bus';
import { bestShuttleForStop } from './eta.service';
import { assign, listOpen, SYSTEM_ACTOR } from './requests.service';
import { getSettings } from './settings.service';
import { getOpenShifts } from './shifts.service';
import { getCommittedSeats, listStatuses } from './shuttles.service';
import { todayTotals } from './trips.service';

// ─────────────────────────────────────────────────────────────────────────────
// KPIs
// ─────────────────────────────────────────────────────────────────────────────

export async function getKpis(): Promise<DashboardKpis> {
  const [shifts, statuses, totals] = await Promise.all([
    getOpenShifts(),
    listStatuses(),
    todayTotals(),
  ]);

  const waiting = await queryOne<{ passengers: number; pending: number }>(
    `SELECT COALESCE(SUM(passenger_count), 0)::int AS passengers,
            count(*) FILTER (WHERE status = 'pending')::int AS pending
     FROM pickup_requests
     WHERE status IN ('pending', 'accepted')`,
  );

  // Average wait = request raised → shuttle arrived, over today's closed
  // requests. Comparing against the trailing 7 days gives the delta the
  // dashboard shows, so a bad morning is visible as a change, not a bare number.
  const wait = await queryOne<{ today_sec: number | null; week_sec: number | null }>(
    `SELECT
       AVG(EXTRACT(EPOCH FROM (arrived_at - requested_at)))
         FILTER (WHERE requested_at >= date_trunc('day', now())) AS today_sec,
       AVG(EXTRACT(EPOCH FROM (arrived_at - requested_at)))
         FILTER (WHERE requested_at >= now() - interval '7 days'
                   AND requested_at <  date_trunc('day', now())) AS week_sec
     FROM pickup_requests
     WHERE arrived_at IS NOT NULL`,
  );

  const capacity = [...shifts.values()].reduce((sum, s) => sum + s.capacity, 0);
  const occupied = [...(await getCommittedSeats()).values()].reduce((a, b) => a + b, 0);

  const totalShuttles = statuses.length;
  const activeShuttles = statuses.filter(
    (s) => s.status === 'en_route' || s.status === 'at_stop' || s.status === 'full',
  ).length;

  const avgWaitMin = wait?.today_sec == null ? null : round1(wait.today_sec / 60);
  const weekAvgMin = wait?.week_sec == null ? null : wait.week_sec / 60;

  return {
    activeShuttles,
    totalShuttles,
    onlineDrivers: [...shifts.values()].filter((s) => s.isOnline).length,
    waitingEmployees: waiting?.passengers ?? 0,
    pendingRequests: waiting?.pending ?? 0,
    avgWaitMin,
    avgWaitDeltaMin:
      avgWaitMin == null || weekAvgMin == null ? null : round1(avgWaitMin - weekAvgMin),
    tripsToday: totals.trips,
    passengersToday: totals.passengers,
    seatUtilizationPct: capacity === 0 ? null : Math.round((occupied / capacity) * 100),
    computedAt: new Date().toISOString(),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// Waiting by stop
// ─────────────────────────────────────────────────────────────────────────────

export async function getStopWaiting(): Promise<StopWaitingSummary[]> {
  const rows = await query<{
    stop_id: string;
    stop_name: string;
    waiting_passengers: number;
    open_requests: number;
  }>(
    `SELECT s.id AS stop_id, s.name AS stop_name,
            COALESCE(SUM(r.passenger_count), 0)::int AS waiting_passengers,
            count(r.id)::int AS open_requests
     FROM stops s
     LEFT JOIN pickup_requests r
       ON r.pickup_stop_id = s.id
      AND r.status IN ('pending', 'accepted')
     WHERE s.is_active AND s.kind IN ('pickup', 'both')
     GROUP BY s.id, s.name, s.display_order
     ORDER BY s.display_order, s.name`,
  );

  const statuses = await listStatuses();

  return rows.map((r) => {
    // Soonest inbound ETA across the fleet, so a stop shows how long the wait
    // actually is rather than only how many people are in it.
    let nextEtaSec: number | null = null;
    for (const status of statuses) {
      if (status.nextStopId === r.stop_id && status.nextStopEtaSec != null) {
        if (nextEtaSec == null || status.nextStopEtaSec < nextEtaSec) {
          nextEtaSec = status.nextStopEtaSec;
        }
      }
    }

    return {
      stopId: r.stop_id,
      stopName: r.stop_name,
      waitingPassengers: r.waiting_passengers,
      openRequests: r.open_requests,
      nextEtaSec,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot
// ─────────────────────────────────────────────────────────────────────────────

export async function buildSnapshot(): Promise<DispatchSnapshotPayload> {
  const [kpis, shuttles, openRequests, stops] = await Promise.all([
    getKpis(),
    listStatuses(),
    listOpen(),
    getStopWaiting(),
  ]);
  return { kpis, shuttles, openRequests, stops };
}

export async function broadcastSnapshot(): Promise<void> {
  try {
    realtime.dispatchSnapshot(await buildSnapshot());
  } catch (err) {
    logger.error({ err }, 'dispatch snapshot failed');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-assignment (spec §20 — off by default, enabled in settings)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assign pending requests to the nearest online shuttle with room.
 *
 * Runs only when `autoAssign` is on. Requests are handled oldest-first so the
 * person who has waited longest is served first, and each assignment re-reads
 * seat commitments so two requests cannot be given the same last seat.
 */
export async function runAutoAssign(): Promise<number> {
  const settings = await getSettings();
  if (!settings.autoAssign) return 0;

  const pending = (await listOpen()).filter((r) => r.status === 'pending');
  if (pending.length === 0) return 0;

  let assigned = 0;

  for (const request of pending) {
    try {
      const committed = await getCommittedSeats();
      const shifts = await getOpenShifts();

      const free = new Map<string, number>();
      for (const shift of shifts.values()) {
        free.set(shift.shuttleId, shift.capacity - (committed.get(shift.shuttleId) ?? 0));
      }

      const best = await bestShuttleForStop(
        request.pickupStopId,
        free,
        request.passengerCount,
      );
      if (best == null) continue;

      await assign(request.id, best.shuttleId, SYSTEM_ACTOR);
      assigned += 1;
      logger.info(
        { code: request.code, shuttleId: best.shuttleId, etaSec: best.etaSec },
        'auto-assigned request',
      );
    } catch (err) {
      // One failure should not stop the rest of the queue being served.
      logger.warn({ err, code: request.code }, 'auto-assign skipped this request');
    }
  }

  return assigned;
}
