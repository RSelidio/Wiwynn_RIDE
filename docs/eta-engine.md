# ETA engine

Written for the engineers who will tune or replace the arrival-time model.

## Constraint

No Google Directions or paid routing API (`spec §6`, `§19`). In development,
the backend uses the public OSRM demo at low volume to snap configured stop
coordinates to roads and return route geometry. In production, set
`OSRM_BASE_URL` to a company-hosted OSRM-compatible service. If no router is
configured or it is unavailable, the map omits the road line and the ETA engine
falls back to admin-configured leg distances/times and observed history.

## Where the code is

| File | Responsibility |
| --- | --- |
| `packages/shared-utils/src/geo.ts` | Spherical distance, bearing, polyline projection |
| `packages/shared-utils/src/eta.ts` | The model — pure functions, no I/O |
| `apps/backend/src/services/eta.service.ts` | Feeds the model route geometry and history; caches |
| `apps/backend/src/services/routes.service.ts` | Resolves and caches OSRM road geometry and per-leg distance/duration |

The model has no database, clock or network access. That is what makes it
exhaustively unit-testable and replaceable without touching any transport code.

## The model

### 1. Place the shuttle on its route

`projectOntoPath` projects the latest fix onto the route polyline, returning the
leg it sits on, how far along the whole line it is, and its perpendicular offset.

Working in a local equirectangular frame centred on the point keeps this to
plain algebra, and at campus scale the distortion is far below GPS accuracy.

Measuring **along the route** rather than straight-line matters: a straight line
from a shuttle to a stop can run through a building, understating the distance by
a factor of two on a campus with a ring road.

### 2. Time the first hop by speed

From the current position to the next stop:

```
hopSeconds = distanceToNextStop / effectiveSpeed
```

`effectiveSpeed` floors the reported speed:

```ts
const usable = speedKmh != null && speedKmh >= 4 ? speedKmh : fallbackKmh;
```

Below about 4 km/h the reading is noise or the vehicle is halted at a stop.
Planning on 0.3 km/h yields an ETA of several hours, so the configured average
(`ETA_FALLBACK_SPEED_KMH`, 22 by default) is used instead.

### 3. Time subsequent hops by leg statistics

For every stop after the next, the leg duration is a blend of the admin's
configured time and what has actually been observed:

```
legSeconds = observed × historyWeight + configured × (1 − historyWeight)
```

`ETA_HISTORY_WEIGHT` defaults to `0.6` — history is trusted more than the
configured guess, but not exclusively, so a handful of unusual trips cannot swing
the estimate wildly. If only one of the two exists, it is used alone. If neither
does, the leg falls back to `distance / effectiveSpeed`.

`dwellSecPerStop` (20 s) is added per intermediate stop, because a shuttle that
stops to pick someone up is not travelling during that time.

### 4. Where observations come from

When a trip completes, `trips.service.ts:closeTripIfDone` folds the observed
origin→destination duration into `route_segment_stats` with an incremental mean:

```sql
mean_travel_sec = mean_travel_sec + ($4 - mean_travel_sec) / (sample_count + 1)
```

So the average never requires re-reading the trip table. Segments with fewer
than three samples are ignored — below that the mean is noise. Durations over
two hours are discarded as implausible (a driver who forgot to tap *Complete*).

### 5. Loop routes

The seeded Campus Loop is a closed loop. The convention: for a loop route,
`stop_order = 0` carries the **closing** leg's distance and time (last stop back
to the first) rather than being null. `legsForRoute` detects a loop by exactly
that — `ordered[0].distanceFromPrevM != null` — and the model then walks the
whole loop once starting from the next stop.

For a linear route, stop 0's values are null and the model stops at the last stop.

### 6. Confidence

Every estimate carries `basis` and `confidence` (0–1):

```ts
confidence = ageFactor × offsetFactor × basisFactor
```

- **ageFactor** decays as the fix ages, reaching 0 at twice the staleness limit.
- **offsetFactor** decays with distance off-route — a shuttle 300 m from its
  configured route is probably detouring, so a route-derived number deserves less
  trust.
- **basisFactor** is 1.0 for `gps_speed`, 0.85 for `historical`, 0.7 for
  `configured`.

A fix older than twice `gpsGapAlertSec` yields `basis: 'unavailable'` and a null
ETA. **Returning null is deliberate.** A stale but plausible-looking number is
worse than no number, because the employee cannot tell the difference and will
keep waiting on it.

## What the user sees

`humanizeEtaSec` rounds to what the model can actually support:

| Seconds | Shown |
| --- | --- |
| ≤ 45 | `Now` |
| < 90 | `~1 min` |
| otherwise | `~N min` |

The tilde and the minute rounding are not decoration. Reporting "5 min 47 s"
claims precision the model does not have, and makes every recomputation look
like a change.

## Throttling

`eta.service.ts` caches a board per shuttle for `recomputeThrottleMs` (2 s).
Fixes can arrive every few seconds from several devices at once; recomputing a
whole board per fix is wasted work when the answer is rounded to the minute.

The scheduler recomputes every 15 s regardless, so ETAs still tick down for a
shuttle sitting in traffic that is not moving enough to trigger a distance-based
fix.

## Tuning it

All in `.env`, no code change:

| Variable | Effect |
| --- | --- |
| `ETA_FALLBACK_SPEED_KMH` | Speed assumed when GPS speed is unusable. Raise if ETAs read long for a stopped-then-moving shuttle. |
| `ETA_HISTORY_WEIGHT` | 0 = trust the configured times only; 1 = trust observations only. |
| `GPS_STALE_AFTER_SEC` | How quickly a quiet shuttle is treated as out of contact. |
| `STOP_GEOFENCE_M` | Radius counting as "at the stop". Too large and a shuttle reads as arrived from the far side of a car park. |

Per-route stop order is edited in the admin dashboard under **Stops & routes**.
When road routing is available, the server snaps the stop sequence to the
driving network and uses the returned leg distances and durations as the
configured baseline. Observed completed-trip times are still blended in, so
the displayed ETA can adapt to the actual campus operation. OSRM's standard
driving profile is not live-traffic routing.

### Road geometry and deployment

`OSRM_BASE_URL` is backend-only. In development, omitting it uses the public
OSRM demo service, intended only for light testing and subject to its usage
policy/availability. Do not rely on that shared demo for production. Deploy an
OSRM-compatible router with El Paso's OpenStreetMap extract (or choose a
provider with appropriate production terms), then set `OSRM_BASE_URL` in the
backend environment. OSRM route responses are cached for one minute per route;
admin-configured distances and durations remain the fallback when a route
cannot be snapped. Stops with mixed far-apart sample coordinates are not sent
to OSRM, avoiding erroneous cross-region routes.

## If you replace the model

Keep the `EtaEstimate` shape and `estimateArrivals`'s signature. Everything
downstream — the socket payload, the employee's hero number, the dispatcher's
table, auto-assignment's choice of shuttle — consumes only that, so a better
model is a change to one file.

Things worth trying, roughly in order of expected value:

1. **Time-of-day segment statistics.** The 08:00 leg from the main gate is not
   the 14:00 leg. Bucket `route_segment_stats` by hour.
2. **Time-of-day road speeds or a traffic-aware provider.** The current OSRM
   driving profile does not include live traffic; the rest of the ETA model can
   continue blending those estimates with observed trips.
3. **Kalman filtering of positions.** Campus GPS multipath around tall buildings
   makes a shuttle jitter; smoothing would steady the first-hop estimate.
4. **Per-driver speed profiles.** Measurable, but likely to be politically
   unwelcome. Consider whether the accuracy is worth it.
