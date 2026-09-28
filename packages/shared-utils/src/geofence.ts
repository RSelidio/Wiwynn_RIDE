/**
 * Debounce GPS geofence arrival so one noisy/teleported fix cannot declare
 * that a shuttle has arrived. This is pure so its thresholds are unit-testable.
 */
export interface GeofenceCandidate {
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  lastRecordedAt: string;
  fixCount: number;
  confirmed: boolean;
}

export interface GeofenceFix {
  recordedAt: string;
  observedAtMs: number;
  distanceM: number;
  radiusM: number;
  accuracyM: number | null;
  fresh: boolean;
}

export interface GeofenceConfirmationOptions {
  requiredFixes: number;
  minDwellMs: number;
  maxFixGapMs: number;
  maxAccuracyM: number;
}

export const DEFAULT_GEOFENCE_CONFIRMATION: GeofenceConfirmationOptions = {
  requiredFixes: 2,
  minDwellMs: 4_000,
  maxFixGapMs: 20_000,
  maxAccuracyM: 40,
};

/** Return updated state; invalid/outside fixes clear it, repeated fixes do not count twice. */
export function updateGeofenceCandidate(
  previous: GeofenceCandidate | null,
  fix: GeofenceFix,
  options: GeofenceConfirmationOptions = DEFAULT_GEOFENCE_CONFIRMATION,
): GeofenceCandidate | null {
  if (
    !fix.fresh ||
    fix.accuracyM == null ||
    fix.accuracyM > Math.min(options.maxAccuracyM, fix.radiusM) ||
    fix.distanceM > fix.radiusM
  ) return null;

  if (previous?.lastRecordedAt === fix.recordedAt) return previous;

  const gapMs = previous == null ? Number.POSITIVE_INFINITY : fix.observedAtMs - previous.lastObservedAtMs;
  const startsNewCandidate = previous == null || gapMs <= 0 || gapMs > options.maxFixGapMs;
  const firstObservedAtMs = startsNewCandidate ? fix.observedAtMs : previous.firstObservedAtMs;
  const fixCount = startsNewCandidate ? 1 : previous.fixCount + 1;

  return {
    firstObservedAtMs,
    lastObservedAtMs: fix.observedAtMs,
    lastRecordedAt: fix.recordedAt,
    fixCount,
    confirmed: fixCount >= options.requiredFixes && fix.observedAtMs - firstObservedAtMs >= options.minDwellMs,
  };
}
