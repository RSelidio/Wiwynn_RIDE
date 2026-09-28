/**
 * ETA engine (spec §6).
 *
 * An independent service: it reads route geometry, the live position and the
 * observed segment history, and returns arrival estimates. It has no HTTP or
 * socket knowledge and no write side, so it can be replaced with a better model
 * — or moved to its own process — without touching anything that consumes it.
 *
 * No Google Directions, no OSRM required (spec §19). Distance comes from the
 * configured route legs and spherical geometry. If self-hosted OSRM is added
 * later, the only thing that changes is where `distanceFromPrevM` comes from.
 */

import type { EtaEstimate, ShuttleEtaBoard } from '@shuttle/shared-types';
import { estimateArrivals, etaForStop, type EtaLeg } from '@shuttle/shared-utils';
import { config } from '../config';
import { getPosition } from './gps.service';
import { getSettingsSync } from './settings.service';
import { getOpenShifts, type OpenShift } from './shifts.service';
import { getSegmentStats, listRoutes, lookupSegmentStat } from './routes.service';

interface CachedBoard {
  board: ShuttleEtaBoard;
  computedAtMs: number;
}

/**
 * Per-shuttle throttle. Fixes can arrive every few seconds from several
 * devices at once; recomputing a whole board per fix is wasted work when the
 * answer is rounded to the minute anyway.
 */
const boards = new Map<string, CachedBoard>();

/**
 * Build the ordered leg list for a route, blending observed history into each
 * leg's expected duration.
 */
async function legsForRoute(routeId: string): Promise<{ legs: EtaLeg[]; isLoop: boolean } | null> {
  const routes = await listRoutes(true);
  const route = routes.find((r) => r.id === routeId);
  if (route == null || route.stops.length < 2) return null;

  const stats = await getSegmentStats();
  const ordered = [...route.stops].sort((a, b) => a.stopOrder - b.stopOrder);

  const legs: EtaLeg[] = ordered.map((leg, index) => {
    // The previous stop wraps for a loop, so leg 0's history is the closing leg.
    const previous = ordered[(index - 1 + ordered.length) % ordered.length]!;
    const observed = lookupSegmentStat(stats, routeId, previous.stopId, leg.stopId);

    return {
      stopId: leg.stopId,
      position: { latitude: leg.stop.latitude, longitude: leg.stop.longitude },
      distanceFromPrevM: leg.distanceFromPrevM,
      typicalTravelSec: leg.typicalTravelSec,
      observedTravelSec: observed?.meanTravelSec ?? null,
    };
  });

  return { legs, isLoop: route.isLoop };
}

async function computeBoard(shift: OpenShift): Promise<ShuttleEtaBoard> {
  const now = new Date().toISOString();
  const position = getPosition(shift.shuttleId);
  const settings = getSettingsSync();

  const geometry = shift.routeId == null ? null : await legsForRoute(shift.routeId);

  // Off route, off shift or no fix: return an explicit empty board rather than
  // a plausible-looking guess.
  if (geometry == null) {
    return {
      shuttleId: shift.shuttleId,
      shuttleName: shift.shuttleName,
      routeId: shift.routeId,
      estimates: [],
      computedAt: now,
    };
  }

  const estimates = estimateArrivals(
    {
      shuttleId: shift.shuttleId,
      position:
        position == null
          ? null
          : { latitude: position.latitude, longitude: position.longitude },
      speedKmh: position?.speedKmh ?? null,
      fixAgeSec: position?.ageSec ?? Number.POSITIVE_INFINITY,
      legs: geometry.legs,
      isLoop: geometry.isLoop,
      fallbackSpeedKmh: config.eta.fallbackSpeedKmh,
      historyWeight: config.eta.historyWeight,
      geofenceM: settings.stopGeofenceM,
      staleAfterSec: settings.gpsGapAlertSec,
      dwellSecPerStop: config.eta.dwellSecPerStop,
    },
    now,
  );

  return {
    shuttleId: shift.shuttleId,
    shuttleName: shift.shuttleName,
    routeId: shift.routeId,
    estimates,
    computedAt: now,
  };
}

/**
 * Arrival board for one shuttle.
 *
 * `force` bypasses the throttle; the GPS handler uses it sparingly and the
 * scheduler uses it on its own cadence.
 */
export async function getBoard(shuttleId: string, force = false): Promise<ShuttleEtaBoard | null> {
  const cached = boards.get(shuttleId);
  if (!force && cached != null && Date.now() - cached.computedAtMs < config.eta.recomputeThrottleMs) {
    return cached.board;
  }

  const shift = (await getOpenShifts()).get(shuttleId);
  if (shift == null) {
    boards.delete(shuttleId);
    return null;
  }

  const board = await computeBoard(shift);
  boards.set(shuttleId, { board, computedAtMs: Date.now() });
  return board;
}

/** Boards for every shuttle currently on shift. */
export async function getAllBoards(force = false): Promise<ShuttleEtaBoard[]> {
  const shifts = await getOpenShifts();
  const out: ShuttleEtaBoard[] = [];
  for (const shuttleId of shifts.keys()) {
    const board = await getBoard(shuttleId, force);
    if (board != null) out.push(board);
  }
  return out;
}

/** One shuttle's ETA to one stop. */
export async function getEta(shuttleId: string, stopId: string): Promise<EtaEstimate | null> {
  const board = await getBoard(shuttleId);
  return board == null ? null : etaForStop(board.estimates, stopId);
}

/**
 * The soonest shuttle to a stop, among those online with free seats.
 *
 * `seatsByShuttle` is supplied by the caller (dispatch) so this module stays
 * free of request-table knowledge.
 */
export async function bestShuttleForStop(
  stopId: string,
  seatsByShuttle: Map<string, number>,
  passengersNeeded: number,
): Promise<{ shuttleId: string; etaSec: number } | null> {
  const shifts = await getOpenShifts();
  let best: { shuttleId: string; etaSec: number } | null = null;

  for (const shift of shifts.values()) {
    if (!shift.isOnline) continue;

    const free = seatsByShuttle.get(shift.shuttleId) ?? shift.capacity;
    if (free < passengersNeeded) continue;

    const eta = await getEta(shift.shuttleId, stopId);
    if (eta?.etaSec == null) continue;

    if (best == null || eta.etaSec < best.etaSec) {
      best = { shuttleId: shift.shuttleId, etaSec: eta.etaSec };
    }
  }

  return best;
}

/** Drop a cached board — called when a shift ends or a route is edited. */
export function invalidateBoard(shuttleId?: string): void {
  if (shuttleId == null) boards.clear();
  else boards.delete(shuttleId);
}
