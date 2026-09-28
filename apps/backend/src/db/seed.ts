/**
 * Development seed.
 *
 * Runs `database/seed.sql` for reference data, then creates the demo accounts
 * (passwords must be bcrypt-hashed, which SQL cannot do) and a small amount of
 * live-looking activity so every screen has something to render on first run.
 *
 *   npm run db:seed
 *
 * Requires NODE_ENV=development and ALLOW_DEMO_SEED=true. The fixtures use
 * fictional Hsinchu campus data and must never be mistaken for live records.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { config } from '../config';
import { logger } from '../logger';
import { closePool, withTransaction } from './pool';

const SEED_SQL = path.resolve(__dirname, '../../../../database/seed.sql');

/** Shared by every demo account. Fine for DEV, unacceptable anywhere else. */
const DEMO_PASSWORD = 'Shuttle!2026';

const STOPS = {
  lotA: '11111111-1111-4111-8111-000000000001',
  mainGate: '11111111-1111-4111-8111-000000000002',
  warehouse: '11111111-1111-4111-8111-000000000003',
  mainBuilding: '11111111-1111-4111-8111-000000000004',
  lotB: '11111111-1111-4111-8111-000000000005',
  buildingA: '11111111-1111-4111-8111-000000000006',
} as const;

const SHUTTLES = {
  one: '22222222-2222-4222-8222-000000000001',
  two: '22222222-2222-4222-8222-000000000002',
} as const;

const ROUTE_LOOP = '66666666-6666-4666-8666-000000000001';
const GATE_MB = '77777777-7777-4777-8777-000000000001';

interface DemoUser {
  id: string;
  email: string;
  displayName: string;
  role: 'employee' | 'driver' | 'admin' | 'guard';
}

const USERS: DemoUser[] = [
  { id: '55555555-5555-4555-8555-000000000001', email: 'kc@wiwynn.com',          displayName: 'K. Chang',   role: 'admin' },
  { id: '55555555-5555-4555-8555-000000000002', email: 'wei.chen@wiwynn.com',    displayName: 'Wei Chen',   role: 'guard' },
  { id: '55555555-5555-4555-8555-000000000011', email: 'marcus.lin@wiwynn.com',  displayName: 'Marcus Lin', role: 'driver' },
  { id: '55555555-5555-4555-8555-000000000012', email: 'priya.nair@wiwynn.com',  displayName: 'Priya Nair', role: 'driver' },
  { id: '55555555-5555-4555-8555-000000000013', email: 'kenji.sato@wiwynn.com',  displayName: 'Kenji Sato', role: 'driver' },
  { id: '55555555-5555-4555-8555-000000000021', email: 's.huang@wiwynn.com',     displayName: 'S. Huang',   role: 'employee' },
  { id: '55555555-5555-4555-8555-000000000022', email: 'j.lee@wiwynn.com',       displayName: 'J. Lee',     role: 'employee' },
  { id: '55555555-5555-4555-8555-000000000023', email: 't.okafor@wiwynn.com',    displayName: 'T. Okafor',  role: 'employee' },
  { id: '55555555-5555-4555-8555-000000000024', email: 'a.chen@wiwynn.com',      displayName: 'A. Chen',    role: 'employee' },
  { id: '55555555-5555-4555-8555-000000000025', email: 'r.wu@wiwynn.com',        displayName: 'R. Wu',      role: 'employee' },
  { id: '55555555-5555-4555-8555-000000000026', email: 'm.garcia@wiwynn.com',    displayName: 'M. Garcia',  role: 'employee' },
];

const DRIVERS = [
  { id: '33333333-3333-4333-8333-000000000001', userId: '55555555-5555-4555-8555-000000000011', driverNo: 'D-0112', name: 'Marcus Lin', phone: '+886 900 111 112' },
  { id: '33333333-3333-4333-8333-000000000002', userId: '55555555-5555-4555-8555-000000000012', driverNo: 'D-0127', name: 'Priya Nair', phone: '+886 900 111 127' },
  { id: '33333333-3333-4333-8333-000000000003', userId: '55555555-5555-4555-8555-000000000013', driverNo: 'D-0131', name: 'Kenji Sato', phone: '+886 900 111 131' },
];

const EMPLOYEES = [
  { id: '44444444-4444-4444-8444-000000000001', userId: '55555555-5555-4555-8555-000000000021', badgeNo: 'E-20481', name: 'S. Huang',  dept: 'Thermal Eng.',      stop: STOPS.lotA },
  { id: '44444444-4444-4444-8444-000000000002', userId: '55555555-5555-4555-8555-000000000022', badgeNo: 'E-19022', name: 'J. Lee',    dept: 'Rack Integration',  stop: STOPS.lotA },
  { id: '44444444-4444-4444-8444-000000000003', userId: '55555555-5555-4555-8555-000000000023', badgeNo: 'E-21377', name: 'T. Okafor', dept: 'Supply Chain',      stop: STOPS.lotB },
  { id: '44444444-4444-4444-8444-000000000004', userId: '55555555-5555-4555-8555-000000000024', badgeNo: 'E-18560', name: 'A. Chen',   dept: 'Firmware',          stop: STOPS.lotA },
  { id: '44444444-4444-4444-8444-000000000005', userId: '55555555-5555-4555-8555-000000000025', badgeNo: 'E-20917', name: 'R. Wu',     dept: 'Quality',           stop: STOPS.lotA },
  { id: '44444444-4444-4444-8444-000000000006', userId: '55555555-5555-4555-8555-000000000026', badgeNo: 'E-19844', name: 'M. Garcia', dept: 'Facilities',        stop: STOPS.lotB },
];

/** Minutes before now, as a timestamp — keeps the demo data always "recent". */
function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

async function run(): Promise<void> {
  if (config.env !== 'development' || process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Demo seed disabled. Set NODE_ENV=development and ALLOW_DEMO_SEED=true to opt in.');
  }

  const referenceSql = await readFile(SEED_SQL, 'utf8');
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, config.auth.bcryptRounds);

  await withTransaction(async (client) => {
    await client.query("SET LOCAL app.allow_demo_seed = 'true'");
    // ── Reference data ────────────────────────────────────────────────────
    await client.query(referenceSql);
    logger.info('reference data seeded');

    // ── Accounts ──────────────────────────────────────────────────────────
    for (const u of USERS) {
      await client.query(
        `INSERT INTO users (id, email, password_hash, display_name, role, provider)
         VALUES ($1, $2, $3, $4, $5, 'local')
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           password_hash = EXCLUDED.password_hash,
           display_name = EXCLUDED.display_name,
           role = EXCLUDED.role`,
        [u.id, u.email, passwordHash, u.displayName, u.role],
      );
    }

    for (const d of DRIVERS) {
      await client.query(
        `INSERT INTO drivers (id, user_id, driver_no, display_name, phone)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           driver_no = EXCLUDED.driver_no,
           display_name = EXCLUDED.display_name,
           phone = EXCLUDED.phone`,
        [d.id, d.userId, d.driverNo, d.name, d.phone],
      );
    }

    for (const e of EMPLOYEES) {
      await client.query(
        `INSERT INTO employees (id, user_id, badge_no, display_name, department, default_stop_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           badge_no = EXCLUDED.badge_no,
           display_name = EXCLUDED.display_name,
           department = EXCLUDED.department,
           default_stop_id = EXCLUDED.default_stop_id`,
        [e.id, e.userId, e.badgeNo, e.name, e.dept, e.stop],
      );
    }

    logger.info({ users: USERS.length }, 'accounts seeded');

    // ── Open shifts for the two active shuttles ───────────────────────────
    // Partial unique indexes stop a second open shift per driver/shuttle, so
    // clear any leftovers from a previous seed before opening new ones.
    await client.query(`UPDATE driver_shifts SET ended_at = now() WHERE ended_at IS NULL`);

    const shiftIds: string[] = [];
    for (const [driver, shuttle] of [
      [DRIVERS[0]!, SHUTTLES.one],
      [DRIVERS[1]!, SHUTTLES.two],
    ] as const) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO driver_shifts (driver_id, shuttle_id, route_id, started_at, is_online)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id`,
        [driver.id, shuttle, ROUTE_LOOP, minutesAgo(134)],
      );
      shiftIds.push(rows[0]!.id);
    }

    // ── A GPS fix each, so the fleet is not "no signal" on first load ─────
    // Shuttle 1 mid-loop between the Main Gate and the Warehouse; Shuttle 2
    // standing at Parking Lot B.
    await client.query(
      `INSERT INTO shuttle_locations
         (shuttle_id, driver_id, shift_id, latitude, longitude, speed_kmh, heading_deg, accuracy_m, recorded_at)
       VALUES
         ($1, $2, $3, 24.78390, 121.01050, 24, 90, 4, now()),
         ($4, $5, $6, 24.78720, 121.00950,  0,  0, 3, now())`,
      [SHUTTLES.one, DRIVERS[0]!.id, shiftIds[0], SHUTTLES.two, DRIVERS[1]!.id, shiftIds[1]],
    );

    // ── Requests in a spread of states ───────────────────────────────────
    // Only one may be open per employee (partial unique index), so each row
    // below uses a different employee.
    await client.query(`DELETE FROM trip_passengers`);
    await client.query(`DELETE FROM pickup_requests`);
    await client.query(`DELETE FROM trips`);

    const requests: Array<[string, string, string, number, string, string | null, string | null, Date]> = [
      // employee,            pickup,          destination,        pax, status,      shuttle,       driver,             requestedAt
      [EMPLOYEES[0]!.id, STOPS.lotA,     STOPS.mainBuilding, 2, 'pending',   null,          null,                minutesAgo(4)],
      [EMPLOYEES[1]!.id, STOPS.lotA,     STOPS.mainBuilding, 1, 'accepted',  SHUTTLES.one,  DRIVERS[0]!.id,      minutesAgo(7)],
      [EMPLOYEES[2]!.id, STOPS.lotB,     STOPS.buildingA,    1, 'boarding',  SHUTTLES.two,  DRIVERS[1]!.id,      minutesAgo(12)],
      [EMPLOYEES[3]!.id, STOPS.lotA,     STOPS.mainBuilding, 2, 'accepted',  SHUTTLES.one,  DRIVERS[0]!.id,      minutesAgo(15)],
      [EMPLOYEES[4]!.id, STOPS.warehouse, STOPS.lotA,        1, 'completed', SHUTTLES.one,  DRIVERS[0]!.id,      minutesAgo(48)],
      [EMPLOYEES[5]!.id, STOPS.lotB,     STOPS.mainGate,     1, 'cancelled', null,          null,                minutesAgo(62)],
    ];

    for (const [employeeId, pickup, dest, pax, status, shuttleId, driverId, requestedAt] of requests) {
      // Fill the lifecycle timestamps that the status implies, so the admin
      // timeline and the wait-time report have real numbers to work with.
      const accepted = ['accepted', 'arrived', 'boarding', 'completed'].includes(status)
        ? new Date(requestedAt.getTime() + 90_000)
        : null;
      const arrived = ['arrived', 'boarding', 'completed'].includes(status)
        ? new Date(requestedAt.getTime() + 300_000)
        : null;
      const boarded = ['boarding', 'completed'].includes(status)
        ? new Date(requestedAt.getTime() + 360_000)
        : null;
      const completed = status === 'completed' ? new Date(requestedAt.getTime() + 900_000) : null;
      const cancelled = status === 'cancelled' ? new Date(requestedAt.getTime() + 240_000) : null;

      await client.query(
        `INSERT INTO pickup_requests
           (employee_id, pickup_stop_id, destination_stop_id, passenger_count, status,
            shuttle_id, driver_id, source, requested_at, accepted_at, arrived_at,
            boarded_at, completed_at, cancelled_at, cancel_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pwa',$8,$9,$10,$11,$12,$13,$14)`,
        [
          employeeId, pickup, dest, pax, status, shuttleId, driverId,
          requestedAt, accepted, arrived, boarded, completed, cancelled,
          status === 'cancelled' ? 'Employee found another ride' : null,
        ],
      );
    }

    // ── Completed trips for history and reports ──────────────────────────
    const trips: Array<[string, string, string, string, number, number, number]> = [
      // shuttle,       driver,          origin,              destination,        pax, departedMinAgo, durationMin
      [SHUTTLES.two, DRIVERS[1]!.id, STOPS.lotB,      STOPS.buildingA,    3, 34, 10],
      [SHUTTLES.one, DRIVERS[0]!.id, STOPS.lotA,      STOPS.mainBuilding, 4, 52, 11],
      [SHUTTLES.one, DRIVERS[0]!.id, STOPS.warehouse, STOPS.lotA,         2, 78, 13],
      [SHUTTLES.two, DRIVERS[1]!.id, STOPS.lotA,      STOPS.lotB,         6, 96, 11],
      [SHUTTLES.one, DRIVERS[0]!.id, STOPS.lotA,      STOPS.mainBuilding, 5, 122, 14],
    ];

    for (const [shuttleId, driverId, origin, dest, pax, departedMin, durationMin] of trips) {
      const departedAt = minutesAgo(departedMin);
      await client.query(
        `INSERT INTO trips
           (shuttle_id, driver_id, route_id, origin_stop_id, destination_stop_id,
            status, passenger_count, departed_at, arrived_at, distance_m)
         VALUES ($1,$2,$3,$4,$5,'completed',$6,$7,$8,$9)`,
        [
          shuttleId, driverId, ROUTE_LOOP, origin, dest, pax,
          departedAt, new Date(departedAt.getTime() + durationMin * 60_000),
          900 + pax * 40,
        ],
      );
    }

    // ── Gate log: one shuttle still at the gate, two departed ────────────
    await client.query(`DELETE FROM gate_logs`);
    const guardId = USERS[1]!.id;

    await client.query(
      `INSERT INTO gate_logs
         (gate_id, shuttle_id, driver_id, guard_user_id, checked_in_at, checked_out_at,
          passenger_count, remark)
       VALUES
         ($1, $2, $3, $4, $5, NULL, 0,  NULL),
         ($1, $6, $7, $4, $8, $9,   9,  NULL),
         ($1, $2, $3, $4, $10, $11, 5,  'Arrived 6 min late, traffic at north gate')`,
      [
        GATE_MB,
        SHUTTLES.one, DRIVERS[0]!.id, guardId, minutesAgo(3),
        SHUTTLES.two, DRIVERS[1]!.id, minutesAgo(26), minutesAgo(24),
        minutesAgo(71), minutesAgo(68),
      ],
    );

    // ── One unread notification per employee with a live request ─────────
    await client.query(`DELETE FROM notifications`);
    await client.query(
      `INSERT INTO notifications (user_id, kind, title, body)
       VALUES
         ($1, 'request_accepted', 'Shuttle 1 accepted your pickup', 'Arriving at Parking Lot A in about 6 minutes'),
         ($2, 'shuttle_arrived',  'Shuttle 2 has arrived',          'Board at Parking Lot B')`,
      [EMPLOYEES[1]!.userId, EMPLOYEES[2]!.userId],
    );
  });

  logger.info(
    { password: DEMO_PASSWORD },
    'seed complete — every demo account shares this password',
  );
  logger.info(
    {
      admin: 'kc@wiwynn.com',
      guard: 'wei.chen@wiwynn.com',
      driver: 'marcus.lin@wiwynn.com',
      employee: 'j.lee@wiwynn.com',
    },
    'sign in with any of these',
  );
}

run()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    logger.error({ err }, 'seed failed');
    await closePool().catch(() => undefined);
    process.exit(1);
  });
