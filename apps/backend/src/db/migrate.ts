/**
 * Migration runner.
 *
 * Applies every `database/migrations/*.sql` file exactly once, in filename
 * order, each inside its own transaction. Applied filenames are recorded in
 * `schema_migrations`, so re-running is a no-op.
 *
 *   npm run db:migrate            apply pending migrations
 *   npm run db:migrate -- --reset drop the schema first (DEV only)
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import { logger } from '../logger';
import { closePool, pool } from './pool';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../database/migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedFilenames(): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations',
  );
  return new Set(rows.map((r) => r.filename));
}

async function resetSchema(): Promise<void> {
  if (config.isProduction) {
    throw new Error('Refusing to --reset with NODE_ENV=production');
  }
  if (config.env !== 'development' || process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Refusing destructive reset. Use a disposable development database and set ALLOW_DEMO_SEED=true to opt in.');
  }
  logger.warn({ database: config.db.database }, 'dropping and recreating schema public');
  // CASCADE also removes the sequences and functions the schema defines.
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  // Restore the default grants a fresh database would have had.
  await pool.query(`GRANT ALL ON SCHEMA public TO ${quoteIdent(config.db.user)}`);
  await pool.query('GRANT ALL ON SCHEMA public TO public');
}

/** Quote an identifier for interpolation — role names cannot be bound as params. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function run(): Promise<void> {
  const shouldReset = process.argv.includes('--reset');

  if (shouldReset) await resetSchema();

  await ensureMigrationsTable();
  const done = await appliedFilenames();

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));

  if (files.length === 0) {
    logger.warn({ dir: MIGRATIONS_DIR }, 'no migration files found');
    return;
  }

  let applied = 0;

  for (const filename of files) {
    if (done.has(filename)) {
      logger.debug({ filename }, 'migration already applied');
      continue;
    }

    const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
    const client = await pool.connect();

    try {
      // Each file manages its own BEGIN/COMMIT; the bookkeeping insert joins
      // that transaction so a failed migration is never recorded as applied.
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      logger.info({ filename }, 'migration applied');
      applied += 1;
    } catch (err) {
      logger.error({ err, filename }, 'migration failed — nothing further applied');
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info({ applied, total: files.length }, 'migrations up to date');
}

run()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    logger.error({ err }, 'migrate failed');
    await closePool().catch(() => undefined);
    process.exit(1);
  });
