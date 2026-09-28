# Architecture

Written for the engineers who will extend and operate this system.

## Shape

```
  Employee phone          Driver tablet           Dispatcher workstation
  (PWA, Next.js)          (Expo, React Native)    (Next.js)  + Gate tablet
        │                        │                        │
        │  HTTPS + WebSocket     │  HTTPS + WebSocket     │
        └────────────┬───────────┴────────────┬───────────┘
                     │                        │
                ┌────▼────────────────────────▼────┐
                │  IIS  (TLS, reverse proxy)       │   Windows cloud server
                └────┬──────────┬──────────┬───────┘
                     │          │          │
              127.0.0.1:4000   :3000      :3001
              shuttle-backend  employee   admin        ← PM2, single instances
                     │
        ┌────────────┼─────────────┐
        │            │             │
   ETA engine   Socket.IO     Scheduler
        │            │             │
        └────────────┼─────────────┘
                     │
              ┌──────▼──────┐
              │ PostgreSQL  │
              └─────────────┘
```

One backend serves all three clients. That is a deliberate choice: the request
lifecycle, the seat arithmetic and the ETA model have to agree across surfaces,
and the cheapest way to guarantee that is to have exactly one implementation.

## Why these boundaries

### The shared packages are the contract

`@shuttle/shared-types` is imported by the backend *and* every client, so the
Socket.IO event map and the API DTOs are checked against one definition. Rename
a payload field and the build breaks, rather than the field quietly arriving as
`undefined` on a driver's tablet.

`@shuttle/shared-utils` holds the ETA model, the geo maths and the request
lifecycle rules as pure functions. The backend enforces the rules; the clients
use the same functions to decide which buttons to show. A driver therefore never
sees an "Arrived" button on a request they have not accepted, and if they somehow
did, the backend would still refuse it.

### GPS is split between memory and disk

This is the one piece of state that is deliberately not in PostgreSQL.

Driver devices push a fix every 5–10 seconds. The *latest* fix per shuttle lives
in `apps/backend/src/services/gps.service.ts` as a `Map` and is broadcast
immediately. History is written to `shuttle_locations` at most every
`GPS_HISTORY_PERSIST_SEC` (45 s by default).

Writing every push would mean roughly 10,000 rows per shuttle per day for no
analytical benefit — nobody asks what a shuttle was doing at 08:14:07 versus
08:14:15. The trade is that live positions are lost on restart; the next push
restores them within ten seconds, and until then a shuttle reads as "no signal",
which is the honest answer.

**Consequence for scaling:** the in-memory store and the scheduler both assume a
single backend process. `ecosystem.config.js` pins `instances: 1`. Running two
would give each its own position map and run every scheduled job twice. Adding a
second instance means a Redis adapter for Socket.IO, a shared position store, and
a single-runner lock on the scheduler.

### The ETA engine is a separate module, not a separate service

`spec §6` asks for an independent service so the model can be improved later.
It is a module (`services/eta.service.ts`) wrapping pure functions
(`shared-utils/eta.ts`) with no HTTP, no socket and no write side. It can be
moved into its own process without touching a single caller — but until there is
a reason to pay for another process, it stays in-process where a recomputation
costs a function call rather than a network round trip.

See [eta-engine.md](eta-engine.md) for the model itself.

### Realtime goes through a late-bound bus

Services need to broadcast; the socket layer needs services to answer
subscriptions. Importing each other is a cycle. So services publish through
`realtime/bus.ts`, and `realtime/io.ts` installs the real emitter at startup.
Before installation — and in unit tests — publishing is a silent no-op, so a
service can be exercised without standing up a socket server.

Fan-out is decided in one place. A service says "this request changed" once, and
`buildEmitter` delivers it to dispatch, the employee, the assigned driver, the
shuttle's watchers and the pickup stop's watchers.

### Rooms are the authorisation boundary

Every socket joins only the rooms its role entitles it to
(`realtime/io.ts`, `roomsFor`). An employee joins `employee:<id>` and their own
`user:<id>`; they never join `dispatch`. Fleet-wide traffic is therefore not
merely hidden in their UI — it is never sent to their phone.

## Request lifecycle

```
pending ──accept──→ accepted ──arrive──→ arrived ──board──→ boarding ──complete──→ completed
   │                    │                   │
   ├─reject→ rejected   └─cancel→ cancelled └─cancel→ cancelled
   ├─cancel→ cancelled
   └─(20 min)→ expired
```

The table lives in `REQUEST_TRANSITIONS` (shared-types) and the role rules in
`roleCanTransition` (shared-utils). Three things enforce it:

1. **`transition()` in `requests.service.ts`** is the only function that changes
   a status. It checks the transition is legal, that the actor's role may make
   it, stamps the matching timestamp, writes the audit row and broadcasts.
2. **The UPDATE carries `AND status = $expected`.** Two concurrent callers
   cannot both win: the second updates zero rows and gets a 409. This is what
   stops a driver double-tapping *Accept* on two devices from creating two
   assignments.
3. **Partial unique indexes** in the schema make "one live request per
   employee", "one open shift per driver" and "one open shift per shuttle"
   database guarantees, not application conventions.

## Trips versus requests

A **request** is one employee asking for a ride. A **trip** is one shuttle
journey between two stops, which may carry several requests.

When a driver taps *Picked up*, `board()` finds the shuttle's open trip to that
destination or starts one, and attaches the passenger. The trip closes when every
request riding it has finished. This is what makes "46 trips today, 112
passengers" mean what a dispatcher expects; per-request trips would inflate the
trip count to meaninglessness.

## Seat arithmetic

Seats are never stored as a counter. `getCommittedSeats()` sums
`passenger_count` over requests in `accepted`, `arrived` or `boarding` per
shuttle, and availability is `capacity − committed`.

A counter would drift: cancel a request and something has to remember to
decrement it. Deriving it means a cancellation frees the seat on the next read
with no compensating update to forget.

## Authentication

Access tokens are short-lived JWTs held in memory. Refresh tokens are opaque,
stored **hashed** in `refresh_tokens`, and **rotated** on every use — a stolen
refresh token works at most once, and the legitimate client's next refresh fails
loudly rather than silently sharing the session.

The web apps keep the refresh token in an httpOnly cookie, so JavaScript cannot
read it. The driver app has no cookie jar, so it keeps it in the platform
keystore via `expo-secure-store`. That difference is why `packages/client` and
`apps/driver/src/lib/api.ts` are separate clients rather than one.

See [authentication.md](authentication.md).

## The four roles

`spec §12` names employee, driver and admin. We added a fourth, **guard**, for
the security team on the Main Building gate tablet. They stamp shuttles in and
out and correct their own mistakes; they cannot reach dispatch, employee records
or settings. Folding them into `admin` would have over-granted badly for the sake
of one screen.

The guard tablet lives at `/gate` inside the admin deployment rather than as a
fourth Next app — one screen does not justify another build, and the role split
is enforced by the shell and again by the backend on every endpoint.

## Maps

There is no tile server and no MapLibre dependency. `packages/ui/CampusMap.tsx`
projects real stop coordinates and live positions into an SVG viewBox: one scale
factor for both axes so the campus shape stays true, longitude scaled by
cos(latitude) so it is not stretched east-west.

`spec §7` says a map is not required for the MVP and that free public OSM tile
servers must not be leaned on as production infrastructure. This satisfies both
while still giving employees a spatial sense of where their shuttle is. When the
company stands up self-hosted tiles, `CampusMap` is the only component that
changes — everything around it already passes stops, routes and positions.

## Background jobs

`jobs/scheduler.ts` runs plain intervals. Every task is idempotent, cheap, and
safe to miss a tick, so a job queue would be infrastructure without a purpose.

| Interval | Job |
| --- | --- |
| 10 s | Broadcast the dispatch snapshot |
| 15 s | Recompute and push ETA boards |
| 15 s | Auto-assign pending requests (when enabled) |
| 20 s | "Arriving soon" notifications |
| 60 s | Expire stale pending requests, escalate long waits |
| 1 h | Prune GPS history, read notifications, dead refresh tokens |

An unhandled rejection inside `setInterval` would take the process down and PM2
would restart it, so every job is wrapped in a logging catch.

## What was left out, and why

- **Web Push notifications.** `spec §20` lists them as a later addition. The
  delivery seam is `notifications.service.ts:notify()`; adding a push transport
  touches that one function.
- **Entra ID SSO.** The backend has `upsertEntraUser` and advertises
  availability at `/api/auth/providers`, but no route is wired until company IT
  approves it. The sign-in screens already show or hide the SSO button based on
  that endpoint.
- **Road routing.** Development can use the low-volume public OSRM demo to
  snap admin-configured stop sequences to roads. Production must configure a
  company-hosted OSRM-compatible endpoint (or another properly licensed
  provider); the public demo is not production infrastructure. When routing is
  unavailable, configured route leg values remain the ETA/map fallback.
- **Multi-location support.** The schema has no `site` column. Adding one means
  a `sites` table and a foreign key on stops, routes, shuttles and gates.
