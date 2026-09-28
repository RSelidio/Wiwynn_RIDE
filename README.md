# Company Shuttle Pickup System

A self-hosted, open-source-first shuttle pickup platform. Employees request a
pickup from a predefined stop, drivers accept and drive it, and dispatchers watch
the whole fleet live. No Google Maps, no Firebase, no paid GPS, routing or
realtime service — GPS comes from the driver's own tablet, ETAs are calculated by
our backend, and everything runs on company infrastructure.

## What is in here

| Path | What it is | Stack |
| --- | --- | --- |
| `apps/backend` | One API for all three clients: REST, Socket.IO, ETA engine, auth | Node, Express, TypeScript |
| `apps/employee` | Employee PWA — request a pickup, watch the ETA, trip history | Next.js, React, TypeScript |
| `apps/admin` | Admin dashboard, plus the security gate tablet at `/gate` | Next.js, React, TypeScript |
| `apps/driver` | Driver app — shift control, pickup queue, GPS tracker | Expo, React Native, TypeScript |
| `packages/shared-types` | Domain models, API DTOs, Socket.IO event contract | TypeScript |
| `packages/shared-utils` | Geo maths, the ETA model, formatting, lifecycle rules | TypeScript |
| `packages/ui` | Wiwynn design tokens and shared React components | React |
| `packages/client` | Typed API client, auth context, socket hooks for the web apps | React |
| `database/` | Schema migrations and reference-data seed | SQL |
| `docs/` | Architecture, API reference, deployment, authentication | Markdown |

The three surfaces share one backend and one PostgreSQL database.

## Running it locally

You need **Node 20+** and **PostgreSQL 14+**.

```bash
# 1. Create an empty database owned by the PostgreSQL role used by PGUSER
#    In pgAdmin: Databases → Create → Database; set Owner to PGUSER.
#    The exact steps and backup/restore commands are in the database runbook.

# 2. Configure
cp .env.example .env
#    Edit PGUSER / PGPASSWORD, and set JWT_SECRET to 48 random bytes:
#    node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# 3. Install and build the shared packages
npm install
npm run build:packages

# 4. Create an empty schema (no fictional data is loaded)
npm run db:migrate

# 5. Create the first real administrator (password input is hidden)
npm run db:bootstrap-admin

# 6. Start the backend, employee PWA and admin together
npm run dev
```

The database starts empty. Sign in to configure verified stops, routes, fleet,
and employee/driver accounts in the admin UI. Employee records can include the
unique RFID tag UID read by the driver scanner. The demo seed is optional and
disabled by default; it contains fictional Hsinchu coordinates, accounts,
trips, and GPS positions. Never use it as real company data. This setup does
not delete or alter records in an existing database.

| Surface | URL |
| --- | --- |
| Employee PWA | http://localhost:3000 |
| Admin dashboard | http://localhost:3001 |
| Gate tablet | http://localhost:3001/gate |
| API | http://localhost:4000/api/health |

### Development fixtures

Fictional fixture accounts and activity are intentionally not listed here to
avoid publishing shared credentials. If fixtures are needed, use only a
disposable local database, set both `NODE_ENV=development` and
`ALLOW_DEMO_SEED=true` in the private `.env`, then run the relevant seed
command. Never copy seed credentials into shared environments or use fixture
data as company records. For regular testing, create accounts in the admin UI.

### The driver app

It installs separately, because Expo pins its dependency versions per SDK and
hoisting them alongside Next.js reliably produces two copies of React.

```bash
npm run build:packages        # from the repo root, first
cd apps/driver
npm install
npm start                     # then press 'a' for Android
npm run web                   # temporary browser preview; foreground GPS only
```

On the Android emulator the API is reachable at `http://10.0.2.2:4000`, which is
already the default in `app.json`. On a physical device, change `expo.extra` to
your machine's LAN address — `localhost` on the tablet means the tablet.

The temporary Expo Web preview supports keyboard-wedge RFID readers that type
the tag UID into the focused scan field. It only supports foreground browser
geolocation; use the native driver app for shifts that need background GPS.

## Useful commands

```bash
npm run dev             # backend + both web apps, with package watchers
npm run dev:api         # backend only
npm run build           # everything, production
npm run typecheck       # every workspace
npm run db:migrate      # apply pending migrations
npm run db:bootstrap-admin  # create the first real admin on an empty database
npm run db:seed         # fictional DEV fixtures; requires explicit opt-in
npm run db:reset        # destructive: drops schema then seeds fixtures; disposable DEV DB only, explicit opt-in required
```

## How a pickup actually flows

```
Employee opens the PWA, picks a stop and a destination, taps Request pickup
   │
   ├─ POST /api/requests                        → a pending request
   └─ Socket.IO 'request:offered'               → every online driver's tablet
   │
Driver taps Accept
   │
   ├─ POST /api/requests/:id/accept             → status: accepted
   └─ 'request:changed' + a notification        → the employee sees it at once
   │
Driver's tablet pushes a GPS fix every 5–10 s
   │
   ├─ latest position kept in backend memory, broadcast immediately
   ├─ written to shuttle_locations only every ~45 s
   └─ ETA engine recomputes → 'shuttle:eta'     → the employee's ETA counts down
   │
Arrived → Picked up → Complete trip
   │
   └─ the trip is stored, and the observed duration is folded into the ETA model
```

While on shift, the driver can scan a passenger's RFID tag to record IN; the
next scan records OUT. The driver screen lists currently onboard passengers and
their count. If a rider forgets to scan OUT, the driver can confirm **Clear all
as OUT**; that records manual alighting timestamps and keeps the audit/history
rows rather than deleting them. RFID readers should act as keyboard-wedge
scanners that type the tag UID into the focused scan field.

Full detail in [docs/architecture.md](docs/architecture.md).

## Deployment

IIS terminates HTTPS and reverse proxies to three PM2-managed Node processes,
none of which listens on a public port. Azure DevOps builds once and deploys the
same artifact to DEV and then, behind an approval gate, to PROD.

See [docs/deployment.md](docs/deployment.md) and `azure-pipelines.yml`.

## Publishing to GitHub

The supplied repository URL is <https://github.com/RSelidio/WiwynnRide>, but
this workspace currently has no `.git` directory or configured remote. Before
the first push, check whether the GitHub repository already contains commits.
Do not overwrite its default branch or force-push to resolve unrelated history;
clone/merge the existing history first if needed. Review `git status` and the
staged diff before committing. Keep `.env`, database dumps, RFID/employee data,
`.osrm-data`, `node_modules`, build output, and EAS signing files out of Git.
The `.gitignore` excludes these local artifacts; never force-add secrets.

For database creation, schema/table information, migrations, backup, restore,
and routine maintenance, follow
[docs/operations/database-maintenance.md](docs/operations/database-maintenance.md).
For first-time publication and safe GitHub push checks, see
[docs/operations/publishing-to-github.md](docs/operations/publishing-to-github.md).

## Design

The interface follows the approved *Company Shuttle UI Sample*. Two rules from
it are load-bearing and easy to break by accident:

1. **Wiwynn Blue `#006090` carries structure** — navigation, primary actions,
   route lines.
2. **Signal Green `#80d000` means only "online / accepted / arrived."** Using it
   for a general-purpose success state destroys its meaning at a glance.

Both live in `packages/ui/src/tokens.ts`, which every surface reads, including
the React Native driver app.

## Documentation

- [docs/architecture.md](docs/architecture.md) — how the pieces fit, and why
- [docs/api.md](docs/api.md) — every endpoint and socket event
- [docs/deployment.md](docs/deployment.md) — Windows server, IIS, PM2, Postgres
- [docs/authentication.md](docs/authentication.md) — local auth now, Entra ID later
- [docs/eta-engine.md](docs/eta-engine.md) — how arrival times are calculated
- [docs/prototype-readiness.md](docs/prototype-readiness.md) — no-demo-data setup, acceptance checks, and known launch gaps
- [docs/operations/database-maintenance.md](docs/operations/database-maintenance.md) — schema, migrations, backups, restores, and data protection
- [docs/operations/publishing-to-github.md](docs/operations/publishing-to-github.md) — first push and secret/data safety checklist
