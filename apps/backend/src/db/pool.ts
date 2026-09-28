/**
 * PostgreSQL access (spec §11).
 *
 * One pool for the process. Every query goes through `query` or `withTransaction`
 * so timing, error logging and client release are handled in one place and no
 * route can leak a client by forgetting a `finally`.
 */

import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import { APP_TIME_ZONE } from '@shuttle/shared-utils';
import { config } from '../config';
import { logger } from '../logger';

// node-postgres returns bigint and numeric as strings to avoid precision loss.
// Our bigints are row ids and our numerics are coordinates and durations, all
// comfortably inside IEEE-754 exact range, so parse them to numbers and keep
// the application code free of `Number(row.count)` noise.
types.setTypeParser(types.builtins.INT8, (v) => Number.parseInt(v, 10));
types.setTypeParser(types.builtins.NUMERIC, (v) => Number.parseFloat(v));

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  ssl: config.db.ssl,
  max: config.db.max,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // A runaway query should not hold a pool slot forever.
  statement_timeout: 20_000,
  application_name: 'shuttle-backend',
  // Keep date_trunc and date-to-timestamptz conversions on El Paso time.
  options: `-c timezone=${APP_TIME_ZONE}`,
});

pool.on('error', (err) => {
  // Fires for idle clients dropped by the server or the network. The pool
  // replaces them itself; log it so a flapping link is visible.
  logger.error({ err }, 'idle postgres client errored');
});

const SLOW_QUERY_MS = 300;

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const startedAt = process.hrtime.bigint();
  try {
    const result = await pool.query<T>(sql, params as unknown[]);
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (ms > SLOW_QUERY_MS) {
      logger.warn({ ms: Math.round(ms), sql: collapse(sql) }, 'slow query');
    }
    return result.rows;
  } catch (err) {
    logger.error({ err, sql: collapse(sql) }, 'query failed');
    throw err;
  }
}

/** Run a query expected to return at most one row. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on any
 * throw. The callback receives the client, so every statement inside shares the
 * transaction — using the module-level `query` inside would silently run outside it.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Verify connectivity at startup so a bad DSN fails loudly, not on first request. */
export async function assertDatabaseReachable(): Promise<void> {
  const row = await queryOne<{ version: string }>('SELECT version() AS version');
  logger.info(
    { database: config.db.database, host: config.db.host, server: row?.version?.split(',')[0] },
    'postgres connected',
  );
}

export async function closePool(): Promise<void> {
  await pool.end();
}

function collapse(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/**
 * PostgreSQL error codes we translate into user-facing API errors.
 * Referenced by the HTTP error mapper.
 */
export const PG_ERRORS = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
} as const;

export function isPgError(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}
