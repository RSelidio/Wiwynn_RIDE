/**
 * Authentication routes (spec §12).
 *
 * The access token is returned in the body for the client to hold in memory;
 * the refresh token is an httpOnly cookie so JavaScript cannot read it and an
 * XSS bug cannot exfiltrate a long-lived credential.
 */

import { Router, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config';
import { asyncHandler, unauthorized } from '../http/errors';
import { ok } from '../http/respond';
import { parseBody } from '../http/validate';
import { auth, requireAuth } from '../middleware/auth';
import { recordFrom } from '../services/audit.service';
import {
  authenticateLocal,
  buildSession,
  revokeAllRefreshTokens,
  revokeRefreshToken,
  rotateRefreshToken,
  issueRefreshToken,
  setPassword,
} from '../services/auth.service';

const REFRESH_COOKIE = 'shuttle_refresh';

/**
 * Brute-force protection on the login endpoint. Counted per IP; behind IIS this
 * relies on `trust proxy` being set so the real client address is used.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again shortly.' } },
});

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(12, 'Use at least 12 characters')
    .max(200)
    .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), {
      message: 'Include an upper-case letter, a lower-case letter and a digit',
    }),
});

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    // Secure requires HTTPS, which IIS terminates in production. In local
    // development over http the cookie would otherwise be dropped.
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: 30 * 86_400_000,
  });
}

export const authRouter = Router();

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(req, loginSchema);
    const session = await authenticateLocal(body.email, body.password);

    const refreshToken = await issueRefreshToken(
      session.user.id,
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    );
    setRefreshCookie(res, refreshToken);

    await recordFrom(req, 'auth.login', 'user', session.user.id, { email: session.user.email });
    ok(res, session);
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (typeof token !== 'string' || token.length === 0) {
      throw unauthorized('No refresh token');
    }

    const { session, refreshToken } = await rotateRefreshToken(
      token,
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    );
    setRefreshCookie(res, refreshToken);
    ok(res, session);
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (typeof token === 'string' && token.length > 0) await revokeRefreshToken(token);

    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    ok(res, { loggedOut: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await buildSession(auth(req).userId));
  }),
);

authRouter.post(
  '/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = parseBody(req, passwordSchema);
    const { userId } = auth(req);

    // Re-authenticate with the current password so a hijacked access token
    // cannot be used to lock the real owner out.
    const session = await buildSession(userId);
    await authenticateLocal(session.user.email, body.currentPassword);

    await setPassword(userId, body.newPassword);
    await revokeAllRefreshTokens(userId);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });

    await recordFrom(req, 'auth.password_changed', 'user', userId);
    ok(res, { passwordChanged: true });
  }),
);

/**
 * Advertise whether SSO is available, so the sign-in screen can show or hide
 * the "Sign in with company account" button without hard-coding it.
 */
authRouter.get('/providers', (_req, res) => {
  ok(res, {
    local: true,
    entra: config.auth.ssoConfigured,
  });
});
