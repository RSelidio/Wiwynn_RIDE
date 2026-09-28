# WiwynnRide project handoff

This file is a short engineering index. The README and linked `docs/` files are
the canonical operator instructions. Do not put passwords, tokens, employee
records, RFID UIDs, GPS exports, or production database details in this file.

## Product and repository

Company shuttle prototype monorepo:

- `apps/backend` — Express, REST, Socket.IO, PostgreSQL access, dispatch, ETA,
  OSRM route geometry, driver and RFID boarding endpoints.
- `apps/employee` — Next.js employee PWA.
- `apps/admin` — Next.js admin and gate UI; admin can create/edit shuttles,
  routes, stops, employee accounts, and driver accounts.
- `apps/driver` — standalone Expo React Native app. It also has a temporary web
  preview for browser testing; use a native device for background GPS.
- `packages/` — shared client, types, UI, and utilities.
- `database/migrations` — ordered SQL migrations; never edit an applied
  migration, add a new numbered migration instead.

GitHub target requested by the owner: `https://github.com/RSelidio/WiwynnRide`.
The provided workspace did not contain a `.git` directory when last checked.
Inspect the GitHub repository's existing history before initializing or pushing;
never force-push over existing work. See
[`docs/operations/publishing-to-github.md`](docs/operations/publishing-to-github.md).

## Current setup

- Local services are configured through the private root `.env`; `.env` is
  ignored by Git. Never commit it.
- PostgreSQL schema is created with `npm run db:migrate`; the migration runner
  applies only missing migration files.
- The configured prototype database has been migrated through migration 005.
  Verify the target database and migration table before operating elsewhere.
- Create the first local admin on a genuinely empty database using
  `npm run db:bootstrap-admin` from an interactive terminal.
- The default database setup is empty. Demo fixtures require both
  `NODE_ENV=development` and `ALLOW_DEMO_SEED=true`; do not use them as company
  data. `npm run db:reset` is destructive and now has the same opt-in guard.
- Employee and driver accounts are created from the admin UI. Add the employee's
  unique RFID tag UID to their profile before issuing the RFID card.
- Driver RFID scans toggle IN/OUT. An admin/driver can review the onboard roster;
  manual clear records a distinct manual alighting method rather than deleting
  scan history. A driver cannot end a shift while the onboard count is nonzero.
- RFID input currently supports keyboard-wedge USB/Bluetooth readers that type
  a UID. Direct phone NFC integration is not implemented.
- Production must set `OSRM_BASE_URL` to a company-controlled router for
  road-following paths; do not depend on the public OSRM demo.

## Common validation commands

Run from the repository root unless noted:

```powershell
npm run typecheck
npm test
npm run build
npm run db:migrate
```

The standalone Expo driver app is not an npm workspace; after installing its
own dependencies, validate it with:

```powershell
npm run typecheck --prefix apps/driver
```

The root workspace tests currently include shared utility ETA, date/time, and
geofence tests. Backend test scripts exist, but no backend integration suite is
configured; validate database-dependent behavior in a disposable test database
before production rollout.

## Release and database safety

- Keep development, staging, and production databases separate.
- Back up production before each schema migration; test restores against a
  separate database and exercise the restore regularly.
- Create a fresh PostgreSQL database, run migrations, then bootstrap its first
  admin. Do not seed production.
- Set secrets in protected deployment configuration, never in Git.
- Review personal/RFID/GPS-data retention and access with the responsible
  company owner before production use.
- See [`docs/operations/database-maintenance.md`](docs/operations/database-maintenance.md),
  [`docs/deployment.md`](docs/deployment.md), and
  [`docs/prototype-readiness.md`](docs/prototype-readiness.md).
