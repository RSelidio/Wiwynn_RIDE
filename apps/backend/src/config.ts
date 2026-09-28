/**
 * Environment configuration.
 *
 * Parsed and validated once at startup. If a required value is missing the
 * process exits immediately with a readable list of problems — far better than
 * discovering at 07:30 that JWT_SECRET was blank and every login 500s.
 */

import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

// Load the repo-root .env, then any app-local override.
loadEnv({ path: path.resolve(__dirname, '../../../.env') });
loadEnv({ path: path.resolve(__dirname, '../.env'), override: true });

/** Coerce "true"/"1"/"yes" to a boolean; anything else is false. */
const boolish = z
  .string()
  .optional()
  .transform((v) => v != null && ['true', '1', 'yes', 'on'].includes(v.toLowerCase()));

const intIn = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: intIn(1, 65535, 4000),
  HOST: z.string().default('127.0.0.1'),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3001'),

  PGHOST: z.string().default('localhost'),
  PGPORT: intIn(1, 65535, 5432),
  PGDATABASE: z.string().min(1, 'PGDATABASE is required'),
  PGUSER: z.string().min(1, 'PGUSER is required'),
  PGPASSWORD: z.string().default(''),
  PGSSLMODE: z.enum(['disable', 'require']).default('disable'),
  PG_POOL_MAX: intIn(1, 100, 10),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  BCRYPT_ROUNDS: intIn(4, 15, 12),

  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  ENTRA_REDIRECT_URI: z.string().optional(),

  GPS_PUSH_INTERVAL_SEC: intIn(1, 120, 8),
  GPS_HISTORY_PERSIST_SEC: intIn(5, 600, 45),
  GPS_STALE_AFTER_SEC: intIn(5, 600, 30),
  STOP_GEOFENCE_M: intIn(5, 1000, 50),
  ETA_FALLBACK_SPEED_KMH: intIn(5, 120, 22),
  ETA_HISTORY_WEIGHT: z.coerce.number().min(0).max(1).default(0.6),
  /** Optional OSRM-compatible routing endpoint. Development defaults to the public demo; production should set a company-hosted endpoint. */
  OSRM_BASE_URL: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().url().optional(),
  ),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: boolish,
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console -- the logger is not up yet
  console.error(`\nInvalid environment configuration:\n${problems}\n\nSee .env.example.\n`);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',

  http: {
    port: env.PORT,
    host: env.HOST,
    /** Exact-match allowlist. An unlisted origin gets no CORS headers at all. */
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  db: {
    host: env.PGHOST,
    port: env.PGPORT,
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    ssl: env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false,
    max: env.PG_POOL_MAX,
  },

  auth: {
    jwtSecret: env.JWT_SECRET,
    accessTtl: env.JWT_ACCESS_TTL,
    refreshTtl: env.JWT_REFRESH_TTL,
    bcryptRounds: env.BCRYPT_ROUNDS,
    /** True once every Entra value is present; the SSO routes check this. */
    ssoConfigured: Boolean(
      env.ENTRA_TENANT_ID && env.ENTRA_CLIENT_ID && env.ENTRA_CLIENT_SECRET && env.ENTRA_REDIRECT_URI,
    ),
    entra: {
      tenantId: env.ENTRA_TENANT_ID ?? '',
      clientId: env.ENTRA_CLIENT_ID ?? '',
      clientSecret: env.ENTRA_CLIENT_SECRET ?? '',
      redirectUri: env.ENTRA_REDIRECT_URI ?? '',
    },
  },

  gps: {
    pushIntervalSec: env.GPS_PUSH_INTERVAL_SEC,
    historyPersistSec: env.GPS_HISTORY_PERSIST_SEC,
    staleAfterSec: env.GPS_STALE_AFTER_SEC,
  },

  eta: {
    fallbackSpeedKmh: env.ETA_FALLBACK_SPEED_KMH,
    historyWeight: env.ETA_HISTORY_WEIGHT,
    /** Assumed seconds standing at each intermediate stop. */
    dwellSecPerStop: 20,
    /** Recompute no more often than this per shuttle, however fast fixes arrive. */
    recomputeThrottleMs: 2_000,
  },

  routing: {
    osrmBaseUrl: env.OSRM_BASE_URL?.replace(/\/$/, '')
      ?? (env.NODE_ENV === 'production' ? '' : 'https://router.project-osrm.org'),
    requestTimeoutMs: 5_000,
    cacheTtlMs: 60_000,
  },

  geofenceM: env.STOP_GEOFENCE_M,

  log: {
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY || env.NODE_ENV === 'development',
  },
} as const;

export type Config = typeof config;
