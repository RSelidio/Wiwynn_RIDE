/**
 * Authentication and token handling (spec §12).
 *
 * Local password auth for DEV and initial PROD; the shape is deliberately
 * provider-agnostic so an Entra ID sign-in can populate the same session
 * without changing anything downstream — `verifyAccessToken` and the role
 * guards do not care how the user proved who they were.
 */

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { AuthSession, JwtClaims, Role, User } from '@shuttle/shared-types';
import { config } from '../config';
import { query, queryOne } from '../db/pool';
import { rowToDriver, rowToEmployee, rowToUser } from '../db/rows';
import { forbidden, unauthorized } from '../http/errors';

interface UserRow extends Record<string, unknown> {
  id: string;
  email: string;
  password_hash: string | null;
  display_name: string;
  role: Role;
  provider: 'local' | 'entra';
  external_id: string | null;
  is_active: boolean;
}

const USER_COLUMNS = `
  id, email, password_hash, display_name, role, provider, external_id,
  is_active, last_login_at, created_at, updated_at
`;

/** Strip the hash before a user object can escape this module. */
function publicUser(row: UserRow): User {
  const { password_hash: _ignored, ...rest } = row;
  return rowToUser.one(rest)!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokens
// ─────────────────────────────────────────────────────────────────────────────

export function signAccessToken(claims: Omit<JwtClaims, 'iat' | 'exp'>): string {
  return jwt.sign(claims, config.auth.jwtSecret, {
    expiresIn: config.auth.accessTtl,
    algorithm: 'HS256',
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): JwtClaims {
  try {
    // Pinning the algorithm stops an attacker presenting an unsigned token with
    // alg:none and having it accepted.
    return jwt.verify(token, config.auth.jwtSecret, { algorithms: ['HS256'] }) as JwtClaims;
  } catch {
    throw unauthorized('Session expired or invalid');
  }
}

/** Opaque refresh token; only its SHA-256 is stored. */
function newRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(48).toString('base64url');
  return { token, hash: crypto.createHash('sha256').update(token).digest('hex') };
}

function refreshExpiry(): Date {
  // Parse the "30d" / "12h" / "45m" form used in the environment.
  const match = /^(\d+)([smhd])$/.exec(config.auth.refreshTtl);
  const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  const ms = match ? Number(match[1]) * unitMs[match[2] as keyof typeof unitMs] : 30 * 86_400_000;
  return new Date(Date.now() + ms);
}

export async function issueRefreshToken(userId: string, userAgent?: string): Promise<string> {
  const { token, hash } = newRefreshToken();
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [userId, hash, refreshExpiry(), userAgent ?? null],
  );
  return token;
}

export async function revokeRefreshToken(token: string): Promise<void> {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await query(
    `UPDATE refresh_tokens SET revoked_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hash],
  );
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await query(
    `UPDATE refresh_tokens SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}

/**
 * Exchange a refresh token for a new session, rotating the token.
 *
 * Rotation means a stolen refresh token is usable at most once, and the
 * legitimate client's next refresh fails loudly rather than silently sharing
 * the session.
 */
export async function rotateRefreshToken(
  token: string,
  userAgent?: string,
): Promise<{ session: AuthSession; refreshToken: string }> {
  const hash = crypto.createHash('sha256').update(token).digest('hex');

  const row = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM refresh_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hash],
  );
  if (row == null) throw unauthorized('Refresh token is invalid or has expired');

  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, [hash]);

  const session = await buildSession(row.user_id);
  const refreshToken = await issueRefreshToken(row.user_id, userAgent);
  return { session, refreshToken };
}

/** Housekeeping: drop tokens that expired or were revoked over 30 days ago. */
export async function pruneRefreshTokens(): Promise<number> {
  const rows = await query<{ count: number }>(
    `WITH deleted AS (
       DELETE FROM refresh_tokens
       WHERE expires_at < now() - interval '30 days'
          OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')
       RETURNING 1
     )
     SELECT count(*)::int AS count FROM deleted`,
  );
  return rows[0]?.count ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

/** Assemble the session payload: user plus whichever profile their role implies. */
export async function buildSession(userId: string): Promise<AuthSession> {
  const row = await queryOne<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
    [userId],
  );
  if (row == null) throw unauthorized('Account no longer exists');
  if (!row.is_active) throw forbidden('This account has been deactivated');

  const user = publicUser(row);

  const employee = rowToEmployee.one(
    await queryOne(`SELECT * FROM employees WHERE user_id = $1`, [userId]),
  );
  const driver = rowToDriver.one(
    await queryOne(`SELECT * FROM drivers WHERE user_id = $1`, [userId]),
  );

  const accessToken = signAccessToken({
    sub: user.id,
    role: user.role,
    employeeId: employee?.id ?? null,
    driverId: driver?.id ?? null,
  });

  return {
    accessToken,
    // The client refreshes a little before this, so report seconds not a date.
    expiresIn: ttlSeconds(config.auth.accessTtl),
    user,
    employee,
    driver,
  };
}

function ttlSeconds(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return 900;
  const unit = { s: 1, m: 60, h: 3_600, d: 86_400 } as const;
  return Number(match[1]) * unit[match[2] as keyof typeof unit];
}

/**
 * Verify an email and password.
 *
 * The bcrypt comparison runs even when the account does not exist, against a
 * throwaway hash, so the response time does not reveal which emails are
 * registered.
 */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.7qkOZ1gGdXeEHj8LPPMBLpHVdmVb2XW';

export async function authenticateLocal(email: string, password: string): Promise<AuthSession> {
  const row = await queryOne<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1)`,
    [email],
  );

  const hash = row?.password_hash ?? DUMMY_HASH;
  const matches = await bcrypt.compare(password, hash);

  if (row == null || !matches || row.provider !== 'local') {
    throw unauthorized('Email or password is incorrect');
  }
  if (!row.is_active) throw forbidden('This account has been deactivated');

  await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [row.id]);
  return buildSession(row.id);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, config.auth.bcryptRounds);
}

export async function setPassword(userId: string, password: string): Promise<void> {
  await query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [
    userId,
    await hashPassword(password),
  ]);
  // Changing a password must not leave old sessions alive.
  await revokeAllRefreshTokens(userId);
}

/**
 * Find or create the local user record behind an Entra sign-in.
 *
 * Not wired to a route until company IT approves SSO; kept here so the shape of
 * the integration is fixed and `buildSession` already works for it.
 */
export async function upsertEntraUser(profile: {
  externalId: string;
  email: string;
  displayName: string;
  role?: Role;
}): Promise<AuthSession> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO users (email, display_name, role, provider, external_id)
     VALUES ($1, $2, $3, 'entra', $4)
     ON CONFLICT (provider, external_id) DO UPDATE SET
       email = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       last_login_at = now()
     RETURNING id`,
    [profile.email, profile.displayName, profile.role ?? 'employee', profile.externalId],
  );
  return buildSession(row!.id);
}
