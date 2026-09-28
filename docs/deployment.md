# Deployment — Windows cloud server

Written for whoever operates the server.

## Target shape

```
Internet / company LAN
        │  HTTPS 443
   ┌────▼──────────────────────────────┐
   │ IIS                               │
   │  shuttle.company.com       → :3000  employee PWA
   │  shuttle-admin.company.com → :3001  admin + gate tablet
   │  /api and /socket.io       → :4000  backend
   └───────────────────────────────────┘
        │ loopback only
   PM2: shuttle-backend, shuttle-employee, shuttle-admin
        │
   PostgreSQL 14+ (localhost)
```

**All three Node processes bind to `127.0.0.1`.** Nothing but IIS can reach
them. That is `spec §14`, and it is the single most important thing not to
"simplify" later.

## Prerequisites

| Software | Notes |
| --- | --- |
| Windows Server 2019+ | |
| Node.js 20 LTS | `node --version` must be ≥ 20.11 |
| PostgreSQL 14+ | Local, or a company-controlled host |
| IIS | With **URL Rewrite** and **Application Request Routing (ARR)** |
| PM2 | `npm install -g pm2` |
| Git | For the deploy checkout |

ARR is what makes IIS able to reverse proxy at all. Without it the rewrite rules
below silently do nothing.

## 1. PostgreSQL

```sql
CREATE ROLE shuttle_app WITH LOGIN PASSWORD 'use-a-generated-password';
CREATE DATABASE shuttle_prod OWNER shuttle_app;

\c shuttle_prod
GRANT ALL ON SCHEMA public TO shuttle_app;
```

Create a separate `shuttle_dev` with its own role. `spec §16` requires separate
DEV and PROD databases; sharing one is how a test run deletes production trips.

The application role owns its schema and needs no superuser rights. `gen_random_uuid()`
is core from PostgreSQL 13, so no extension is required.

## 2. Application

```powershell
cd C:\inetpub\shuttle
git clone <azure-devops-repo-url> .

npm ci
npm run build:packages
npm run build

# Configuration — never commit this file
Copy-Item .env.example .env
notepad .env
```

Set at minimum:

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=4000

PGHOST=localhost
PGDATABASE=shuttle_prod
PGUSER=shuttle_app
PGPASSWORD=<the generated password>

# 48 random bytes:
# node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
JWT_SECRET=<generated>

CORS_ORIGINS=https://shuttle.company.com,https://shuttle-admin.company.com
NEXT_PUBLIC_API_URL=https://shuttle.company.com
NEXT_PUBLIC_SOCKET_URL=https://shuttle.company.com

# Company-controlled road routing endpoint; do not depend on the public demo.
OSRM_BASE_URL=https://<company-hosted-osrm-host>
```

> **`NEXT_PUBLIC_*` values are baked in at build time.** They must be set
> *before* `npm run build`, and they must be the URLs the browser will use. If
> you change them, rebuild — restarting is not enough.

Then create the schema:

```powershell
npm run db:migrate
```

Do **not** run either seed command on production. `db:seed` and
`db:seed:test-accounts` require both `NODE_ENV=development` and the explicit
`ALLOW_DEMO_SEED=true` opt-in. Their identities, activity, and Hsinchu
coordinates are fictional and are not company data.

After migrations, create the first real administrator with
`npm run db:bootstrap-admin -w @shuttle/backend` from an interactive terminal.
It prompts for the administrator identity and a hidden password, and refuses if
an administrator already exists. Sign in and configure verified stops, routes,
fleet, gates, and employee/driver accounts through the admin UI. Assign each
employee's unique RFID tag UID in their profile before issuing RFID boarding
cards. Configure the deployed reader as a keyboard-wedge scanner and test its
suffix/terminator with the driver scan field. Do not seed a production database
or overwrite existing records to make a clean prototype.

The driver logs passenger IN/OUT scans and displays the current onboard roster.
Manual “clear all as OUT” records a separate alighting method and must only be
used after the driver confirms everyone has left. Define an operational review
policy for these manual corrections.

Back up the database before migrations and rehearse restores to a separate
database. See [operations/database-maintenance.md](operations/database-maintenance.md)
for the operational database runbook. Database backups, RFID UIDs, GPS history,
requests and employee information are sensitive; store and retain them only
under the company's approved security and retention policies.

## 3. PM2

```powershell
pm2 start ecosystem.config.js --env production
pm2 save
pm2 status
```

### Surviving a reboot

`pm2 startup` does not support Windows. Either:

```powershell
npm install -g pm2-windows-service
pm2-service-install -n PM2
```

or create a Scheduled Task, trigger **At system startup**, running:

```
C:\Program Files\nodejs\node.exe C:\Users\<svc>\AppData\Roaming\npm\node_modules\pm2\bin\pm2 resurrect
```

Verify it by actually rebooting. An untested startup hook is the most common
cause of a Monday-morning outage.

## 4. IIS

Create one site per hostname, each pointing at an empty physical directory — IIS
serves nothing itself, it only proxies.

### Employee PWA — `shuttle.company.com`

`web.config`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <!-- API and WebSocket to the backend. Order matters: these must come
             before the catch-all, or the PWA would swallow /api. -->
        <rule name="API" stopProcessing="true">
          <match url="^api/(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:4000/api/{R:1}" />
        </rule>
        <rule name="SocketIO" stopProcessing="true">
          <match url="^socket.io/(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:4000/socket.io/{R:1}" />
        </rule>
        <rule name="NextApp" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:3000/{R:1}" />
        </rule>
      </rules>
    </rewrite>

    <webSocket enabled="true" pingInterval="00:00:20" />

    <httpProtocol>
      <customHeaders>
        <remove name="X-Powered-By" />
        <add name="Strict-Transport-Security" value="max-age=31536000; includeSubDomains" />
      </customHeaders>
    </httpProtocol>
  </system.webServer>
</configuration>
```

### Admin — `shuttle-admin.company.com`

The same file with `3000` replaced by `3001`.

### WebSocket checklist

Socket.IO falls back to HTTP long-polling if WebSocket is blocked, so it "works"
while being far more expensive. Confirm all of:

1. **Web Sockets** is installed under *Server Roles → Web Server → Application
   Development*.
2. `<webSocket enabled="true" />` is present, as above.
3. ARR is not buffering responses. In *Application Request Routing Cache →
   Server Proxy Settings*, set **Response buffer threshold** to `0`.

Verify in the browser console — the connection should report `websocket`, not
`polling`.

### TLS

Bind a company certificate to each site on 443 and redirect HTTP to HTTPS. The
refresh cookie is issued with `Secure` when `NODE_ENV=production`, so **sign-in
will not work over plain HTTP in production.** That is intentional.

## 5. Verify

```powershell
# Liveness, then readiness (which checks PostgreSQL)
Invoke-WebRequest http://127.0.0.1:4000/api/health      -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:4000/api/health/ready -UseBasicParsing

# Through IIS
Invoke-WebRequest https://shuttle.company.com/api/health -UseBasicParsing
```

Then sign in as an admin, confirm the **Live** indicator in the top bar is green
(that reflects the socket, not decoration), and confirm the gate tablet loads at
`/gate`.

## 6. The driver tablets

The driver app is not deployed to this server. It is built with EAS and
installed on company Android tablets:

```powershell
cd apps\driver
npx eas-cli build --platform android --profile production
```

`eas.json`'s `production` profile points `apiUrl` and `socketUrl` at
`https://shuttle.company.com`. Change them there, not in `app.json`, for
release builds.

Distribution is through company device management — the profile builds an APK
rather than an AAB because these tablets do not go through Play.

### On each tablet

1. Install the APK.
2. Grant location as **Allow all the time**. "While using the app" stops
   tracking when the screen locks, and the app warns about this on the shift
   screen, but it is far better to get it right at provisioning.
3. Disable battery optimisation for the app, or Android will kill the foreground
   service after a few hours.
4. Keep it docked and charging. The app holds a wake lock during a shift.

## Operations

```powershell
pm2 status
pm2 logs shuttle-backend --lines 200
pm2 reload ecosystem.config.js --env production   # zero-downtime
pm2 restart shuttle-backend                        # hard restart
pm2 monit
```

Logs are written to `logs/` and also captured by PM2. They are JSON in
production; `pino-pretty` is a dev dependency only.

### Backups

`pg_dump` nightly, via Scheduled Task:

```powershell
$stamp = Get-Date -Format 'yyyyMMdd'
pg_dump --format=custom --file="D:\backups\shuttle-$stamp.dump" shuttle_prod
```

The PROD deploy stage takes a dump before migrating, but a nightly schedule is
what you actually restore from.

### Data growth

The hourly prune job keeps things bounded: GPS history 90 days, read
notifications 60 days, dead refresh tokens 30 days. At two shuttles and
45-second sampling that is roughly 3,800 location rows a day — trivial. Revisit
the retention if the fleet grows substantially.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Sign-in succeeds then immediately signs out | Refresh cookie rejected. Check the site is HTTPS and `CORS_ORIGINS` lists the exact origin. |
| "Reconnecting…" never clears | WebSocket blocked at IIS. Work the checklist above. |
| Shuttles show "no GPS fix" | Driver's shift not started, or background location denied on the tablet. |
| ETAs are null everywhere | The shuttle's shift has no `routeId`. The ETA model needs a route to measure along. |
| Frontend calls `localhost:4000` in production | `NEXT_PUBLIC_API_URL` was wrong at build time. Rebuild. |
| `EADDRINUSE` on 4000 | An old process survived. `pm2 delete all`, then start again. |
| Migration fails partway | Each file runs in its own transaction and is only recorded on success, so fix the SQL and re-run. Nothing is half-applied. |
