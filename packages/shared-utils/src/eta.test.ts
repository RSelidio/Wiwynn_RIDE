import assert from 'node:assert/strict';
import test from 'node:test';
import { etaForStop, etaParts, estimateArrivals, humanizeEtaSec, type EtaInput } from './eta';
import {
  APP_TIME_ZONE,
  appDateKey,
  appDateTimeInput,
  appDateTimeInputToIso,
  formatRelativeDay,
  formatTime,
  formatTimeWithSeconds,
  shiftDateKey,
} from './format';

const computedAt = '2026-09-25T12:00:00.000Z';

const baseInput: EtaInput = {
  shuttleId: 'shuttle-1',
  position: { latitude: 0, longitude: 0.0005 },
  speedKmh: 36,
  fixAgeSec: 0,
  legs: [
    {
      stopId: 'stop-a',
      position: { latitude: 0, longitude: 0 },
      distanceFromPrevM: null,
      typicalTravelSec: null,
      observedTravelSec: null,
    },
    {
      stopId: 'stop-b',
      position: { latitude: 0, longitude: 0.001 },
      distanceFromPrevM: 111,
      typicalTravelSec: 60,
      observedTravelSec: 120,
    },
    {
      stopId: 'stop-c',
      position: { latitude: 0, longitude: 0.002 },
      distanceFromPrevM: 111,
      typicalTravelSec: 90,
      observedTravelSec: null,
    },
  ],
  isLoop: false,
  fallbackSpeedKmh: 22,
  historyWeight: 0.5,
  geofenceM: 10,
  staleAfterSec: 30,
  dwellSecPerStop: 20,
};

test('estimateArrivals uses GPS speed and configured leg times', () => {
  const estimates = estimateArrivals(baseInput, computedAt);

  assert.deepEqual(estimates.map(({ stopId }) => stopId), ['stop-b', 'stop-c']);
  assert.equal(estimates[0]?.basis, 'historical');
  assert.equal(estimates[0]?.etaSec, 6);
  assert.equal(estimates[1]?.basis, 'gps_speed');
  assert.equal(estimates[1]?.etaSec, 116);
  assert.equal(estimates[1]?.computedAt, computedAt);
});

test('estimateArrivals blends observed and configured travel times by history weight', () => {
  const legs = baseInput.legs.map((leg) =>
    leg.stopId === 'stop-c'
      ? { ...leg, typicalTravelSec: 60, observedTravelSec: 120 }
      : leg,
  );
  const estimates = estimateArrivals({ ...baseInput, legs }, computedAt);

  assert.equal(estimates[1]?.basis, 'historical');
  assert.equal(estimates[1]?.etaSec, 116);
});

test('estimateArrivals returns unavailable estimates when there is no position', () => {
  const estimates = estimateArrivals({ ...baseInput, position: null }, computedAt);

  assert.equal(estimates.length, baseInput.legs.length);
  assert.ok(estimates.every((estimate) => estimate.etaSec === null));
  assert.ok(estimates.every((estimate) => estimate.basis === 'unavailable'));
  assert.ok(estimates.every((estimate) => estimate.confidence === 0));
});

test('estimateArrivals marks stale predictions unavailable', () => {
  const estimates = estimateArrivals({ ...baseInput, fixAgeSec: 61 }, computedAt);

  assert.ok(estimates.every((estimate) => estimate.etaSec === null));
  assert.ok(estimates.every((estimate) => estimate.basis === 'unavailable'));
});

test('estimateArrivals includes the first stop again for an explicit loop route', () => {
  const legs = baseInput.legs.map((leg) =>
    leg.stopId === 'stop-a'
      ? { ...leg, distanceFromPrevM: 333, typicalTravelSec: 100 }
      : leg,
  );
  const loopEstimates = estimateArrivals({ ...baseInput, legs, isLoop: true }, computedAt);
  const oneWayEstimates = estimateArrivals({ ...baseInput, legs, isLoop: false }, computedAt);

  assert.deepEqual(loopEstimates.map(({ stopId }) => stopId), ['stop-b', 'stop-c', 'stop-a']);
  assert.deepEqual(oneWayEstimates.map(({ stopId }) => stopId), ['stop-b', 'stop-c']);
  assert.ok((loopEstimates[2]?.etaSec ?? 0) > (loopEstimates[1]?.etaSec ?? 0));
});

test('etaForStop finds a stop and returns null when it is absent', () => {
  const estimates = estimateArrivals(baseInput, computedAt);

  assert.equal(etaForStop(estimates, 'stop-c'), estimates[1]);
  assert.equal(etaForStop(estimates, 'missing'), null);
});

test('humanizeEtaSec and etaParts avoid false precision', () => {
  assert.equal(humanizeEtaSec(null), '—');
  assert.equal(humanizeEtaSec(45), 'Now');
  assert.equal(humanizeEtaSec(89), '~1 min');
  assert.equal(humanizeEtaSec(3660), '~1 h 1 min');
  assert.deepEqual(etaParts(75), { value: '~1', unit: 'min' });
  assert.deepEqual(etaParts(null), { value: '—', unit: '' });
});

test('all displayed date/time helpers use El Paso time across UTC day boundaries', () => {
  const instant = '2026-01-01T02:04:05.000Z';

  assert.equal(APP_TIME_ZONE, 'America/Denver');
  assert.equal(formatTime(instant), '19:04');
  assert.equal(formatTimeWithSeconds(instant), '19:04:05');
  assert.equal(appDateKey(new Date(instant)), '2025-12-31');
  assert.equal(formatRelativeDay(instant, new Date('2026-01-01T18:00:00.000Z')), 'Yesterday · 19:04');
  assert.equal(shiftDateKey('2026-03-09', -1), '2026-03-08');
});

test('gate datetime input values round-trip using El Paso daylight time', () => {
  const instant = '2026-07-01T03:04:05.000Z';
  const input = appDateTimeInput(instant);

  assert.equal(input, '2026-06-30T21:04:05');
  assert.equal(appDateTimeInputToIso(input), instant);
  assert.equal(appDateTimeInputToIso('2026-03-08T02:30:00'), null);
});