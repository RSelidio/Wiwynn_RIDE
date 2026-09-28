/**
 * ETA engine core (spec §6).
 *
 * Pure functions only — no database, no clock, no network. The backend wraps
 * these in a service (`apps/backend/src/services/eta`) that feeds them route
 * geometry and observed history. Keeping the maths here means the engine can be
 * unit-tested exhaustively and swapped for a better model without touching any
 * transport code, and it does not depend on Google Directions or OSRM
 * (spec §19); self-hosted OSRM can later replace `legDistanceM` only.
 */

import type { EtaBasis, EtaEstimate } from '@shuttle/shared-types';
import { distanceMeters, kmhToMs, projectOntoPath, type LatLng } from './geo';

/** One leg of a route as the engine sees it. */
export interface EtaLeg {
  stopId: string;
  position: LatLng;
  /** Metres from the previous stop. Null on the first leg or when unmeasured. */
  distanceFromPrevM: number | null;
  /** Admin-configured typical seconds from the previous stop. */
  typicalTravelSec: number | null;
  /** Mean observed seconds from the previous stop, from completed trips. */
  observedTravelSec: number | null;
}

export interface EtaInput {
  shuttleId: string;
  /** Latest fix. Null when the shuttle has never reported or is off shift. */
  position: LatLng | null;
  /** Reported ground speed in km/h; null when the device omits it. */
  speedKmh: number | null;
  /** Seconds since the fix was recorded. */
  fixAgeSec: number;
  /** Ordered legs of the shuttle's route, first stop first. */
  legs: readonly EtaLeg[];
  /** True when the final stop connects back to the first stop. */
  isLoop: boolean;
  /** Fallback speed when GPS speed is missing or implausibly low. */
  fallbackSpeedKmh: number;
  /** 0..1 weight on observed history vs configured times. */
  historyWeight: number;
  /** Metres within which the shuttle counts as standing at a stop. */
  geofenceM: number;
  /** Seconds after which a fix is too old to trust. */
  staleAfterSec: number;
  /** Seconds a shuttle is assumed to dwell at each intermediate stop. */
  dwellSecPerStop: number;
}

/** Blend configured and observed times for one leg, falling back to distance. */
function legSeconds(leg: EtaLeg, historyWeight: number, speedMs: number): number | null {
  const { typicalTravelSec, observedTravelSec, distanceFromPrevM } = leg;

  if (observedTravelSec != null && typicalTravelSec != null) {
    const w = Math.max(0, Math.min(1, historyWeight));
    return observedTravelSec * w + typicalTravelSec * (1 - w);
  }
  if (observedTravelSec != null) return observedTravelSec;
  if (typicalTravelSec != null) return typicalTravelSec;
  if (distanceFromPrevM != null && speedMs > 0) return distanceFromPrevM / speedMs;
  return null;
}

/** Effective speed in m/s, floored so a stopped shuttle does not yield infinity. */
function effectiveSpeedMs(speedKmh: number | null, fallbackKmh: number): number {
  // Below ~4 km/h the reading is noise or the vehicle is halted at a stop;
  // planning on it would produce absurd ETAs, so use the configured average.
  const usable = speedKmh != null && speedKmh >= 4 ? speedKmh : fallbackKmh;
  return kmhToMs(Math.max(1, usable));
}

/**
 * Confidence in an estimate, 0..1.
 *
 * Degrades with fix age and with how far off-route the shuttle is — a shuttle
 * 300 m from its configured route is probably detouring, so the route-derived
 * number deserves less trust.
 */
function confidenceFor(fixAgeSec: number, staleAfterSec: number, offsetM: number, basis: EtaBasis): number {
  if (basis === 'unavailable') return 0;
  if (basis === 'at_stop') return 1;

  const ageFactor = Math.max(0, 1 - fixAgeSec / Math.max(1, staleAfterSec * 2));
  const offsetFactor = Math.max(0.2, 1 - offsetM / 250);
  const basisFactor = basis === 'gps_speed' ? 1 : basis === 'historical' ? 0.85 : 0.7;

  return Math.max(0, Math.min(1, ageFactor * offsetFactor * basisFactor));
}

/**
 * Estimate arrival at every stop on the shuttle's route.
 *
 * Returns one entry per leg, in the order the shuttle will reach them starting
 * from its current position, so index 0 is always the next stop.
 */
export function estimateArrivals(input: EtaInput, computedAtIso: string): EtaEstimate[] {
  const {
    shuttleId,
    position,
    speedKmh,
    fixAgeSec,
    legs,
    isLoop,
    fallbackSpeedKmh,
    historyWeight,
    geofenceM,
    staleAfterSec,
    dwellSecPerStop,
  } = input;

  // No fix or no route: every stop is unknown. Say so rather than guessing.
  if (position == null || legs.length === 0) {
    return legs.map((leg) => ({
      shuttleId,
      stopId: leg.stopId,
      etaSec: null,
      distanceM: null,
      basis: 'unavailable' as EtaBasis,
      confidence: 0,
      computedAt: computedAtIso,
    }));
  }

  const path = legs.map((l) => l.position);
  const projection = projectOntoPath(position, path);
  const speedMs = effectiveSpeedMs(speedKmh, fallbackSpeedKmh);
  const usingGpsSpeed = speedKmh != null && speedKmh >= 4;
  const offsetM = projection?.offsetM ?? 0;

  // Where on the route are we? The next stop is the far end of the leg we sit on.
  const segmentIndex = projection?.segmentIndex ?? 0;
  let nextStopIndex = Math.min(segmentIndex + 1, legs.length - 1);

  // Standing inside a stop's geofence: that stop is "now", the one after is next.
  const distanceToNext = distanceMeters(position, legs[nextStopIndex]!.position);
  const atNextStop = distanceToNext <= geofenceM;

  const order: number[] = [];
  const total = legs.length;
  if (isLoop) {
    // Walk the whole loop once, starting from the next stop.
    const start = atNextStop ? nextStopIndex + 1 : nextStopIndex;
    for (let i = 0; i < total; i++) order.push((start + i) % total);
  } else {
    if (atNextStop) nextStopIndex = Math.min(nextStopIndex + 1, total - 1);
    for (let i = nextStopIndex; i < total; i++) order.push(i);
  }

  const estimates: EtaEstimate[] = [];
  let cumulativeSec = 0;
  let cumulativeM = 0;

  // First hop: from the current position to the next stop, by distance/speed.
  // Subsequent hops use leg times, which already encode traffic and stop-spacing.
  let isFirstHop = true;

  for (const idx of order) {
    const leg = legs[idx]!;

    if (isFirstHop) {
      const hopM = atNextStop ? 0 : distanceToNext;
      cumulativeM += hopM;
      cumulativeSec += hopM / speedMs;
      isFirstHop = false;
    } else {
      const seconds = legSeconds(leg, historyWeight, speedMs);
      if (seconds != null) {
        cumulativeSec += seconds + dwellSecPerStop;
      } else {
        // No configured or observed time for this leg — fall back to geometry.
        const prevIdx = (idx - 1 + total) % total;
        const hopM = leg.distanceFromPrevM ?? distanceMeters(legs[prevIdx]!.position, leg.position);
        cumulativeM += hopM;
        cumulativeSec += hopM / speedMs + dwellSecPerStop;
      }
      if (leg.distanceFromPrevM != null) cumulativeM += leg.distanceFromPrevM;
    }

    const isAtThisStop = idx === nextStopIndex && atNextStop && estimates.length === 0;
    const basis: EtaBasis = isAtThisStop
      ? 'at_stop'
      : fixAgeSec > staleAfterSec * 2
        ? 'unavailable'
        : leg.observedTravelSec != null
          ? 'historical'
          : usingGpsSpeed
            ? 'gps_speed'
            : 'configured';

    estimates.push({
      shuttleId,
      stopId: leg.stopId,
      etaSec: basis === 'unavailable' ? null : Math.max(0, Math.round(cumulativeSec)),
      distanceM: Math.round(cumulativeM),
      basis,
      confidence: confidenceFor(fixAgeSec, staleAfterSec, offsetM, basis),
      computedAt: computedAtIso,
    });
  }

  return estimates;
}

/** Pull one stop's estimate out of a board. */
export function etaForStop(estimates: readonly EtaEstimate[], stopId: string): EtaEstimate | null {
  return estimates.find((e) => e.stopId === stopId) ?? null;
}

/**
 * Round an ETA to what a person should actually be told.
 *
 * Employees get "~6 min", not "5 min 47 s" — a false precision that the model
 * cannot support and that makes every refresh look like a change.
 */
export function humanizeEtaSec(etaSec: number | null): string {
  if (etaSec == null) return '—';
  if (etaSec <= 45) return 'Now';
  if (etaSec < 90) return '~1 min';
  const minutes = Math.round(etaSec / 60);
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `~${hours} h` : `~${hours} h ${rest} min`;
}

/** The big number and its unit, for the employee app's hero ETA. */
export function etaParts(etaSec: number | null): { value: string; unit: string } {
  if (etaSec == null) return { value: '—', unit: '' };
  if (etaSec <= 45) return { value: 'Now', unit: '' };
  if (etaSec < 90) return { value: '~1', unit: 'min' };
  return { value: `~${Math.round(etaSec / 60)}`, unit: 'min' };
}
