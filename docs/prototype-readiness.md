# Prototype readiness brief (no demo data)

**Status:** Development prototype. This brief describes existing behavior and
known gaps; it does not certify the system for production. No company-specific
stops, routes, fleet, staff, credentials, or service levels are assumed here.

## Goal

Run the shuttle workflow against records supplied and verified by the company,
not fictional sample records. A fresh database must remain empty until an
operator configures it.

## In-scope workflow

1. An employee requests a pickup between configured stops.
2. A dispatcher/admin manages fleet and dispatch operations.
3. A driver starts a shift, receives work, and sends GPS updates.
4. The employee and operations views show live shuttle location and ETA when
   current GPS and route data are available.
5. Gate and reporting workflows operate on events recorded by actual users.

## No-demo-data requirements

- `npm run db:migrate` creates schema only; it must not create users, stops,
  routes, shifts, GPS positions, requests, trips, or gate logs.
- `npm run db:bootstrap-admin` creates one real initial local admin interactively
  on a migrated database. It refuses when an admin or matching email exists and
  does not print the password.
- Fictional development fixtures require both `NODE_ENV=development` and
  `ALLOW_DEMO_SEED=true`. They are not production reference data.
- Never clear or reseed an existing database as part of prototype setup. Back up
  and explicitly approve any data cleanup separately.
- Maps, ETAs, and reports must be empty/unknown when no verified records or live
  GPS fixes exist; do not substitute sample locations or fabricated activity.

## Operator-provided information still required

- Surveyed service-area stop coordinates, names, types, and geofence radii.
- Approved route order, route assignments, and fleet identifiers/capacities.
- Real employee/driver account data and RFID tag UIDs, plus the provisioning
  process for issuing credentials securely.
- Gate identifiers and staff assignments, if gate operations are in scope.
- A routable map dataset or approved routing endpoint covering the real service
  area. A test graph for another geography must not be used.
- Deployment URLs, CORS origins, database credentials, and secret-management
  ownership for each environment.

## Known prototype gaps

- Admin can create and edit local employee/driver accounts. Entra ID SSO and
  bulk identity import are not implemented; local accounts need a secure
  credential issuance/reset process before rollout.
- RFID scanning currently supports keyboard-wedge readers (USB/Bluetooth
  scanners that type a UID). Native phone NFC integration is not implemented.
- Drivers can manually clear forgotten passenger OUT scans; these are auditable
  manual alighting events and still require an operational policy for review.
- Entra ID sign-in is documented as a target but its routes are not implemented.
- Production readiness still requires environment-specific security review,
  backup/restore rehearsal, monitoring/alerting, load testing, and end-to-end
  validation on the actual service area and devices.
- Local development can fall back to the public OSRM demo when no endpoint is
  configured. It is not a production service; configure a company-controlled
  endpoint or explicitly accept that development dependency.

## Prototype acceptance checks

- A fresh migrated database has no business rows until explicitly configured.
- The first admin can sign in without a shared demo password.
- No sample employee, driver, shuttle position, request, trip, gate log, or
  fabricated ETA is visible.
- Stop/route geometry and a sample route request are verified against the
  operator-provided service area before a live trial.
- A live trial confirms driver GPS, employee map updates, request lifecycle,
  arrival behavior, and recovery after a backend restart.
- A test RFID reader maps to a unique employee UID; boarding increments the
  onboard count, alighting decrements it, capacity is enforced, and manual
  clear records an auditable OUT event rather than deleting scan history.

## Not yet a production sign-off

This prototype brief is not an operational approval. Do not publish a launch date,
coverage promise, privacy-retention commitment, uptime target, or safety claim
until the responsible business and technical owners provide and approve them.
