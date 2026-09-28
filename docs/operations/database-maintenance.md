# PostgreSQL setup and maintenance runbook

This runbook covers local prototype databases and production operations. Use a
separate PostgreSQL database (and preferably separate database role) per
**development, test, and production** environment. Do not use production data in
a developer's local database.

## What the database contains

PostgreSQL is the source of truth for configuration and business history. The
backend's newest shuttle location is also kept in process memory for realtime
updates; persisted GPS samples are written to PostgreSQL at the configured
history interval.

| Area | Tables | Notes |
| --- | --- | --- |
| Identity and sessions | `users`, `refresh_tokens` | Local credentials store bcrypt password hashes; refresh tokens are stored hashed. |
| Service configuration | `stops`, `routes`, `route_stops`, `shuttles`, `gates`, `system_settings` | Enter verified stop coordinates, route order, and fleet/gate records. `routes.is_loop` records whether the last stop returns to the first. |
| Staff profiles | `employees`, `drivers` | Employee `badge_no` is the company-readable badge; `rfid_tag` is the unique reader UID used by driver passenger scans. Never treat the RFID UID as a password. |
| Operations | `driver_shifts`, `shuttle_locations`, `pickup_requests`, `trips`, `trip_passengers`, `shuttle_passenger_boardings` | Holds shifts, sampled GPS, requests, journeys, request-linked passengers, and RFID IN/OUT events. `alight_method='manual_clear'` means a driver cleared a forgotten OUT scan. |
| Support and accountability | `notifications`, `audit_logs`, `route_segment_stats`, `schema_migrations` | Notifications, admin/operational audit events, observed travel-time statistics, and migration history. |

Treat employee names/emails, badge numbers, RFID tag UIDs, GPS history, trip
records, requests, and audit logs as sensitive operational data. Restrict database
access, protect backups, and define an organization-approved retention period.
Do not put real credentials, database dumps, RFID values, or production data in
Git issues or commits.

## Create a fresh local database

1. Start PostgreSQL and create a **new empty** database in pgAdmin (or with
   `createdb`). Use a database owner matching `PGUSER` in your local `.env`.
   A conventional name is `shuttle_dev`; use another name if desired.
2. From the repository root, copy `.env.example` to `.env` if `.env` does not
   exist. Keep `.env` private and untracked.
3. Set `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` for the new
   database. Set a private `JWT_SECRET` of at least 32 characters. Keep
   `NODE_ENV=development` and `ALLOW_DEMO_SEED=false` for a data-free prototype.
   Leave `OSRM_BASE_URL` blank unless you intentionally have a routing service.
4. Apply migrations and create the first admin:

   ```powershell
   npm run db:migrate
   npm run db:bootstrap-admin
   ```

   Bootstrap prompts for a real admin email/name and a hidden password. It only
   works when the database has no admin; it refuses to replace an existing one.
5. Run the web apps with `npm run dev`. Sign in to the admin app and add verified
   stops, routes, shuttles, employees, and drivers. Use an employee's **RFID
   tag** field for the exact UID read by your RFID reader.
6. For driver development, install dependencies from `apps/driver` and run Expo.
   The browser-only preview can be started from that folder with `npm run web`;
   it supports foreground browser geolocation only. A phone/tablet app is required
   for shift GPS tracking when the screen is locked.

The initial schema creates empty tables; it does not populate operational rows.
Do not run `db:seed` or `db:reset` on a database containing any data you need.

## Schema migrations

- Migration files are `database/migrations/*.sql`, applied in filename order by
  `npm run db:migrate`.
- The runner records applied filenames in `schema_migrations`; rerunning it is
  safe and applies only pending migrations.
- Back up production before every migration. Apply migrations once to a restored
  staging copy first, validate the app, then run them during the production
  release procedure.
- Never edit a migration that has already been applied in a shared environment.
  Add a new numbered migration instead.
- Current sequence: `001_initial_schema.sql` creates the base tables;
  `002_shuttle_default_route.sql` adds per-shuttle default routes;
  `003_route_loop_back.sql` adds explicit loop routing; `004_rfid_shuttle_boarding.sql`
  adds employee RFID UIDs and passenger IN/OUT history; `005_manual_passenger_clear.sql`
  marks manual roster clears separately from RFID OUT scans.

## Back up a database

Use the PostgreSQL client tools from a protected operator workstation. A custom
format dump supports selective restore and compression. `pg_dump` prompts for a
password when required; do not put the password directly in the command line or
check it into a script.

```powershell
# Set these to the target environment; .env is not automatically imported by PowerShell.
$DbHost = 'localhost'
$DbPort = '5432'
$DbName = 'shuttle_prod'
$DbUser = 'shuttle_app'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
pg_dump --host $DbHost --port $DbPort --username $DbUser --format=custom --no-owner --no-acl --file ".\database-backup-$stamp.dump" $DbName
```

Move the resulting file promptly to the approved encrypted backup location and
remove the workstation copy according to company policy. Backups contain
personal, location, and badge data and must have access controls and retention.

For production, schedule automated backups, monitor job success, retain copies
according to the approved policy, and use point-in-time recovery/WAL archiving if
the service's recovery objectives require it. A backup is not proven until a
restore has been tested.

## Restore a backup to a separate database

Never test a restore over the live database. Create a separate empty target
first, then restore into it. This example uses a custom-format dump and the
application role as owner:

```powershell
$DbHost = 'localhost'
$DbPort = '5432'
$DbUser = 'shuttle_app'
createdb --host $DbHost --port $DbPort --username postgres --owner $DbUser shuttle_restore_test
pg_restore --host $DbHost --port $DbPort --username $DbUser --dbname shuttle_restore_test --no-owner --no-acl --exit-on-error .\database-backup-YYYYMMDD-HHMMSS.dump
```

Set `PGDATABASE=shuttle_restore_test` in a temporary private environment file or
operator environment, run the application against that target, and verify
sign-in, stops/routes/fleet, recent trips, passenger scan history, and audit
records. Never point a restore test at production. Drop the test database only
after an operator has confirmed the restore test is complete:

```powershell
dropdb --host $DbHost --port $DbPort --username postgres shuttle_restore_test
```

## Routine checks and maintenance

- Confirm schema level: inspect `schema_migrations` and compare with the latest
  checked-in migration before deployment.
- Check service reachability with `http://localhost:4000/api/health/ready` (it
  checks the database connection).
- Monitor PostgreSQL disk space, connections, slow-query/application logs,
  backup completion, and restore-test results.
- Review `shuttle_locations` growth against `GPS_HISTORY_PERSIST_SEC` and the
  approved GPS retention policy. Archive/delete only under an approved retention
  process; do not casually remove request, trip, passenger, audit, or gate history.
- Use `ON DELETE`-safe deactivation for staff, stops, routes, and shuttles where
  the application provides it. Historical foreign keys intentionally prevent
  many destructive deletes.
- For RFID: enforce one current onboard row per employee (database partial
  unique index); investigate duplicate-tag conflicts rather than bypassing the
  constraint. Check the `alight_method` column to distinguish RFID OUT from a
  driver's manual clear.

## Seeds and destructive commands

Demo seeds create fictional Hsinchu campus stops, identities, GPS fixes,
requests, trips, and gate logs. They require both `NODE_ENV=development` and
`ALLOW_DEMO_SEED=true`; keep this false for an empty prototype and production.

`npm run db:reset` drops and recreates the entire `public` schema before seeding.
It permanently removes all application data in that database. Use it only for a
disposable local database after checking `PGDATABASE`. Never use it in staging
or production.
