/**
 * Create local-only test accounts for every role without resetting demo data.
 *
 * Run with `npm run db:seed:test-accounts` from the repository root.
 * These deliberately fictional accounts require the explicit development-only
 * ALLOW_DEMO_SEED=true opt-in and must never be created outside development.
 */

import bcrypt from 'bcryptjs';
import { config } from '../config';
import { logger } from '../logger';
import { closePool, withTransaction } from './pool';

const TEST_PASSWORD = 'test123';

const TEST_ACCOUNTS = [
  { email: 'test123.employee@wiwynn.com', name: 'Test Employee', role: 'employee' },
  { email: 'test123.admin@wiwynn.com', name: 'Test Admin', role: 'admin' },
  { email: 'test123.guard@wiwynn.com', name: 'Test Guard', role: 'guard' },
  { email: 'test123.driver@wiwynn.com', name: 'Test Driver', role: 'driver' },
] as const;

const TEST_SHUTTLE_CODE = 'SH-03';

async function run(): Promise<void> {
  if (config.env !== 'development' || process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Demo accounts disabled. Set NODE_ENV=development and ALLOW_DEMO_SEED=true to opt in.');
  }

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, config.auth.bcryptRounds);

  await withTransaction(async (client) => {
    for (const account of TEST_ACCOUNTS) {
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE lower(email) = lower($1)',
        [account.email],
      );

      const user = existing.rows[0]
        ? await client.query<{ id: string }>(
            `UPDATE users
             SET password_hash = $2, display_name = $3, role = $4,
                 provider = 'local', is_active = true
             WHERE id = $1
             RETURNING id`,
            [existing.rows[0].id, passwordHash, account.name, account.role],
          )
        : await client.query<{ id: string }>(
            `INSERT INTO users (email, password_hash, display_name, role, provider)
             VALUES ($1, $2, $3, $4, 'local')
             RETURNING id`,
            [account.email, passwordHash, account.name, account.role],
          );

      const userId = user.rows[0]!.id;

      if (account.role === 'employee') {
        await client.query(
          `INSERT INTO employees (user_id, badge_no, display_name, department)
           VALUES ($1, 'E-TEST123', $2, 'Testing')
           ON CONFLICT (user_id) DO UPDATE SET
             badge_no = EXCLUDED.badge_no,
             display_name = EXCLUDED.display_name,
             department = EXCLUDED.department`,
          [userId, account.name],
        );
      }

      if (account.role === 'driver') {
        await client.query(
          `INSERT INTO drivers (user_id, driver_no, display_name)
           VALUES ($1, 'D-TEST123', $2)
           ON CONFLICT (user_id) DO UPDATE SET
             driver_no = EXCLUDED.driver_no,
             display_name = EXCLUDED.display_name`,
          [userId, account.name],
        );
      }
    }

    // The reference seed keeps Shuttle 3 inactive. Enable it in development so
    // the test driver has an unused 12-seat vehicle available to start a shift.
    await client.query(`UPDATE shuttles SET is_active = true WHERE code = $1`, [TEST_SHUTTLE_CODE]);
  });

  logger.info(
    {
      accounts: TEST_ACCOUNTS.map(({ email, role }) => ({ email, role })),
      availableTestShuttle: TEST_SHUTTLE_CODE,
    },
    'local test accounts ready; use password test123',
  );
}

run()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    logger.error({ err }, 'test account seed failed');
    await closePool().catch(() => undefined);
    process.exit(1);
  });