import test from 'node:test';
import assert from 'node:assert/strict';
import { updateGeofenceCandidate, type GeofenceCandidate, type GeofenceFix } from './geofence';

const fix = (overrides: Partial<GeofenceFix> = {}): GeofenceFix => ({
  recordedAt: new Date(1_000).toISOString(),
  observedAtMs: 1_000,
  distanceM: 10,
  radiusM: 50,
  accuracyM: 8,
  fresh: true,
  ...overrides,
});

test('requires separate accurate fixes and a minimum dwell before confirming stop arrival', () => {
  const first = updateGeofenceCandidate(null, fix());
  assert.equal(first?.confirmed, false);

  const second = updateGeofenceCandidate(first, fix({
    recordedAt: new Date(6_000).toISOString(),
    observedAtMs: 6_000,
  }));
  assert.equal(second?.fixCount, 2);
  assert.equal(second?.confirmed, true);
});

test('does not count the same GPS fix twice', () => {
  const first = updateGeofenceCandidate(null, fix()) as GeofenceCandidate;
  const duplicate = updateGeofenceCandidate(first, fix());
  assert.equal(duplicate?.fixCount, 1);
  assert.equal(duplicate?.confirmed, false);
});

test('outside, stale or low-accuracy fixes reset arrival confirmation', () => {
  const first = updateGeofenceCandidate(null, fix());
  assert.equal(updateGeofenceCandidate(first, fix({ distanceM: 60 })), null);
  assert.equal(updateGeofenceCandidate(first, fix({ fresh: false })), null);
  assert.equal(updateGeofenceCandidate(first, fix({ accuracyM: 45 })), null);
});

test('a long gap starts a new confirmation sequence', () => {
  const first = updateGeofenceCandidate(null, fix());
  const afterGap = updateGeofenceCandidate(first, fix({
    recordedAt: new Date(30_000).toISOString(),
    observedAtMs: 30_000,
  }));
  assert.equal(afterGap?.fixCount, 1);
  assert.equal(afterGap?.confirmed, false);
});
