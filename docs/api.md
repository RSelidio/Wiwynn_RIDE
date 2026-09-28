# API reference

Base path `/api`. All responses use one envelope:

```json
{ "ok": true,  "data": { } }
{ "ok": false, "error": { "code": "NOT_ENOUGH_SEATS", "message": "…", "details": { } } }
```

Authentication is `Authorization: Bearer <accessToken>` unless stated otherwise.
Paginated endpoints return `{ items, total, limit, offset }` and accept
`?limit=&offset=`.

## Auth

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| `POST` | `/auth/login` | — | `{ email, password }`. Sets the refresh cookie. Rate limited to 20 per 15 min per IP. |
| `POST` | `/auth/refresh` | — | Reads the refresh cookie, rotates it, returns a new session. |
| `POST` | `/auth/logout` | — | Revokes the refresh token and clears the cookie. |
| `GET` | `/auth/me` | any | The current session. |
| `POST` | `/auth/password` | any | `{ currentPassword, newPassword }`. Revokes all sessions. |
| `GET` | `/auth/providers` | — | `{ local, entra }` — drives the SSO button's visibility. |

## Employee

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| `GET` | `/me/home` | employee | **The PWA's bootstrap.** Stops, live request, fleet, recent trips, notifications in one call. |
| `GET` | `/me/trips?limit=` | employee | Own trip history. |
| `GET` | `/me/notifications` | any | Unread count also in the `X-Unread-Count` header. |
| `POST` | `/me/notifications/:id/read` | any | Scoped to the caller. |
| `POST` | `/me/notifications/read-all` | any | |

## Requests

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| `POST` | `/requests` | employee, admin | `{ pickupStopId, destinationStopId, passengerCount, note? }`. Admin may pass `employeeId`. 409 if the employee already has a live request. |
| `GET` | `/requests/active` | employee | The caller's live request, or `null`. |
| `GET` | `/requests/mine` | employee | Own history, paginated. |
| `GET` | `/requests/offers` | driver, admin | Pending requests a driver may accept. |
| `GET` | `/requests/queue` | driver | The driver's own accepted work. |
| `GET` | `/requests` | admin | Filters: `status` (repeatable), `shuttleId`, `driverId`, `employeeId`, `stopId`, `q`, `from`, `to`. |
| `GET` | `/requests/open` | admin | Everything still needing attention. |
| `GET` | `/requests/:idOrCode` | any | Accepts a UUID or a code (`REQ-1042`). Employees and drivers may read only their own. |
| `POST` | `/requests/:id/accept` | driver | Assigns to the driver's own shuttle. |
| `POST` | `/requests/:id/assign` | admin | `{ shuttleId, driverId? }`. |
| `POST` | `/requests/:id/reject` | driver, admin | `{ reason? }`. |
| `POST` | `/requests/:id/arrived` | driver, admin | |
| `POST` | `/requests/:id/board` | driver, admin | `{ passengerCount? }` — the real head-count. Opens or joins a trip. |
| `POST` | `/requests/:id/complete` | driver, admin | Closes the trip if nothing else is riding it. |
| `POST` | `/requests/:id/cancel` | any | Employees may cancel only their own. |

### Errors worth handling

| Code | Status | Meaning |
| --- | --- | --- |
| `REQUEST_ALREADY_OPEN` | 409 | The employee already has a live request. |
| `REQUEST_CHANGED` | 409 | Someone moved it first. Re-read and retry. |
| `NOT_ENOUGH_SEATS` | 409 | The shuttle cannot take this many. |
| `NO_DRIVER_ON_SHIFT` | 409 | That shuttle has nobody driving it. |
| `NO_OPEN_SHIFT` | 409 | The driver must start a shift first. |

## Fleet, stops and routes

Reads are open to any signed-in user — an employee needs the stop list. Writes
are admin-only.

| Method | Path | Role |
| --- | --- | --- |
| `GET` | `/fleet/stops?includeInactive=` | any |
| `POST` `PATCH` `DELETE` | `/fleet/stops[/:id]` | admin (`DELETE` retires, never hard-deletes) |
| `GET` | `/fleet/routes`, `/fleet/routes/:id` | any |
| `POST` `PUT` | `/fleet/routes[/:id]` | admin (replaces the whole leg list) |
| `GET` | `/fleet/shuttles?includeInactive=` | any |
| `GET` | `/fleet/shuttles/status` | any — **the live board**: position, seats, next stop, ETA |
| `GET` | `/fleet/shuttles/positions` | any |
| `GET` | `/fleet/shuttles/:id/navigation-path?destinationStopId=` | any — OSRM road geometry from the latest fresh GPS fix to the requested stop (or next stop when omitted); `null` if unavailable |
| `GET` | `/fleet/shuttles/:id/eta` | any — every stop on that shuttle's route |
| `GET` | `/fleet/shuttles/:id/track?minutes=` | admin — GPS trail |
| `POST` `PATCH` | `/fleet/shuttles[/:id]` | admin; shuttle writes may include `defaultRouteId` |

`defaultRouteId` is an optional default for shift start, not a restriction: the
driver app preselects that route for the chosen shuttle, and the driver can
still choose another active route. The admin manages these defaults from
**Stops & routes**.

## Driver

All require the driver (or admin) role.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/driver/dashboard` | **The app's single screen in one call**: shift, status, ETA board, queue, offers, GPS interval. |
| `GET` | `/driver/shifts/current` | The open shift, or `null`. |
| `POST` | `/driver/shifts` | `{ shuttleId, routeId? }`. 409 if the shuttle is signed out to someone else. |
| `POST` | `/driver/shifts/:id/end` | Stops tracking and releases the shuttle. |
| `POST` | `/driver/shifts/:id/online` | `{ isOnline }` — stay on shift but stop taking work. |
| `POST` | `/driver/gps` | Batch fallback: `{ shiftId, fixes: [...] }`, max 200. Exempt from the global rate limit. |
| `POST` | `/driver/passengers/scan` | `{ shiftId, rfidTag }` — first tap records IN, next tap records OUT; responds with action and onboard count. |
| `POST` | `/driver/passengers/clear-onboard` | `{ shiftId }` — records all currently onboard riders OUT with `alight_method='manual_clear'`; history is retained. |

`GET /driver/dashboard` includes `onboardCount` and `onboardPassengers` for the
current open shift. The end-shift endpoint returns `PASSENGERS_STILL_ONBOARD`
until all passengers have been scanned OUT or the driver confirms a manual clear.

GPS normally flows over the socket. This endpoint exists because campus wifi
drops, the app queues fixes locally, and on reconnect it flushes one batch rather
than replaying dozens of socket events. The backend replays a batch
chronologically so the odometer accumulates correctly.

## Gate log

Requires the guard or admin role.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/gate/gates` | |
| `POST` | `/gate/gates/:id/watch` | Joins the caller's sockets to that gate's room. |
| `GET` | `/gate/logs` | Filters: `gateId`, `shuttleId`, `from`, `to`, `state=open\|closed`. |
| `GET` | `/gate/gates/:id/open` | Shuttles currently standing at the gate. |
| `GET` | `/gate/summary?gateId=` | Today's counts for the reports KPI row. |
| `POST` | `/gate/logs` | `{ gateId, shuttleId, driverId?, checkedInAt? }`. Driver defaults from the open shift. |
| `POST` | `/gate/logs/:id/checkout` | `{ checkedOutAt?, passengerCount?, remark? }`. |
| `POST` | `/gate/logs/:id/passengers` | Live head-count while at the gate. |
| `PATCH` | `/gate/logs/:id` | Correction. Sets `was_edited`. **`checkedOutAt: null` re-opens** an entry closed by mistake. |
| `DELETE` | `/gate/logs/:id` | Removes an entry stamped in error. Audited. |
| `GET` | `/gate/logs.csv` | **admin only** — the guard tablet has no reporting surface. |

## Admin

All require the admin role.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/admin/snapshot` | **Everything the overview needs** — KPIs, fleet, open requests, stop waiting. |
| `GET` | `/admin/kpis` | |
| `GET` | `/admin/stops/waiting` | |
| `POST` | `/admin/dispatch/auto-assign` | Runs it now instead of waiting for the scheduler. |
| `GET` | `/admin/trips` | |
| `GET` | `/admin/employees?q=` | Server-side search. |
| `POST` | `/admin/employees` | Create a local employee login/profile: `{ email, password, displayName, badgeNo, rfidTag?, department?, defaultStopId? }`. Password requires 12+ characters with upper/lowercase and a number. |
| `PATCH` | `/admin/employees/:id` | Update profile/login details; optional `rfidTag: null` clears a tag. Optional password change revokes existing sessions. |
| `GET` | `/admin/drivers?q=` | |
| `POST` | `/admin/drivers` | Create a local driver login/profile. Same password policy. |
| `PATCH` | `/admin/drivers/:id` | Update driver profile/login details; optional password change revokes existing sessions. |
| `GET` | `/admin/reports?from=&to=` | Summary: KPIs, wait times by hour, utilization, popular stops. |
| `GET` | `/admin/reports/wait-times`, `/utilization`, `/popular-stops` | Individually. |
| `GET` | `/admin/reports/trips.csv`, `/requests.csv` | CSV, UTF-8 with a BOM so Excel on Windows opens it correctly. |
| `GET` `PATCH` | `/admin/settings` | Partial patch. Takes effect within 10 s, no restart. |
| `GET` | `/admin/audit?entityType=&entityId=` | |

## Health

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Liveness. No database access — a readiness probe that queries Postgres turns a slow query into a restart loop. |
| `GET` | `/health/ready` | Readiness. Checks the database. This is the one the deploy smoke test polls. |

## Socket.IO

Connect to the same origin as the API. Authenticate in the handshake:

```ts
io(url, { auth: (cb) => cb({ token: accessToken }) })
```

A missing or invalid token is refused with `UNAUTHORIZED`. The token is read
lazily so a reconnect after a refresh presents the *new* token.

### Rooms joined automatically

| Role | Rooms |
| --- | --- |
| employee | `user:<userId>`, `employee:<employeeId>` |
| driver | `user:<userId>`, `driver:<driverId>` |
| admin | `user:<userId>`, `dispatch` |
| guard | `user:<userId>`, plus `gate:<gateId>` after `POST /gate/gates/:id/watch` |

### Server → client

| Event | Payload | Sent to |
| --- | --- | --- |
| `connection:ready` | `{ userId, role, rooms }` | the connecting socket |
| `shuttle:position` | `{ shuttleId, position }` | `shuttle:<id>`, `dispatch` |
| `shuttle:status` | `{ status }` | `shuttle:<id>`, `dispatch` |
| `shuttle:eta` | `{ shuttleId, estimates, computedAt }` | `shuttle:<id>`, `dispatch`, `stop:<id>` |
| `request:changed` | `{ request, reason, actorUserId }` | `dispatch`, the employee, the driver, the shuttle, the stop |
| `request:offered` | same | one driver's room |
| `trip:changed` | `{ trip, reason }` | `dispatch`, the driver, the shuttle |
| `gate:changed` | `{ entry, reason }` | `gate:<id>`, `dispatch` |
| `notification:new` | `{ notification }` | `user:<id>` — all that person's devices |
| `dispatch:snapshot` | KPIs, fleet, open requests, stops | `dispatch` |
| `settings:changed` | `{ settings }` | `dispatch` |
| `error:raised` | `{ code, message }` | the offending socket |

### Client → server

| Event | Payload | Role |
| --- | --- | --- |
| `gps:push` | `{ shuttleId, shiftId, latitude, longitude, speedKmh?, headingDeg?, accuracyM?, recordedAt }`, acked `{ ok, error? }` | driver — the shift must be theirs and open |
| `shuttle:subscribe` / `unsubscribe` | `{ shuttleId }` | any. Subscribing immediately replies with the current status, position and ETA, so the UI is never blank waiting for the next fix. |
| `stop:subscribe` / `unsubscribe` | `{ stopId }` | any |
| `dispatch:refresh` | — | admin |
