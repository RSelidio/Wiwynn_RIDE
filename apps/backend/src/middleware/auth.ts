/**
 * Authentication and role guards (spec §12).
 *
 * `requireAuth` establishes who is calling; `requireRole` narrows to who may.
 * Both are cheap — the access token carries the role and profile ids, so an
 * authenticated request costs no database round trip.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Role } from '@shuttle/shared-types';
import { forbidden, unauthorized } from '../http/errors';
import { verifyAccessToken } from '../services/auth.service';

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7).trim() || null;
  }
  return null;
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = bearerToken(req);
  if (token == null) return next(unauthorized('Missing bearer token'));

  const claims = verifyAccessToken(token);
  req.auth = {
    userId: claims.sub,
    role: claims.role,
    employeeId: claims.employeeId,
    driverId: claims.driverId,
    // The token does not carry the display name; routes that need it read the
    // user row. Kept on the context so socket and HTTP auth share one shape.
    displayName: '',
  };
  next();
};

/**
 * Attach `req.auth` when a valid token is present, but do not reject when it is
 * absent. For endpoints that answer differently to a signed-in caller.
 */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = bearerToken(req);
  if (token == null) return next();
  try {
    const claims = verifyAccessToken(token);
    req.auth = {
      userId: claims.sub,
      role: claims.role,
      employeeId: claims.employeeId,
      driverId: claims.driverId,
      displayName: '',
    };
  } catch {
    // An expired token on an optional route is the same as no token.
  }
  next();
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (req.auth == null) return next(unauthorized());
    if (!roles.includes(req.auth.role)) {
      return next(forbidden(`This endpoint requires the ${roles.join(' or ')} role`));
    }
    next();
  };
}

export const requireAdmin = requireRole('admin');
export const requireDriver = requireRole('driver');
export const requireEmployee = requireRole('employee');
export const requireGuard = requireRole('guard', 'admin');

/** Read the caller's auth context, or throw if the route forgot requireAuth. */
export function auth(req: Request): Express.AuthContext {
  if (req.auth == null) throw unauthorized();
  return req.auth;
}

/** The caller's employee id, or 403 if they have no employee profile. */
export function employeeId(req: Request): string {
  const ctx = auth(req);
  if (ctx.employeeId == null) throw forbidden('This account has no employee profile');
  return ctx.employeeId;
}

/** The caller's driver id, or 403 if they have no driver profile. */
export function driverId(req: Request): string {
  const ctx = auth(req);
  if (ctx.driverId == null) throw forbidden('This account has no driver profile');
  return ctx.driverId;
}

/**
 * Guard an "own resource or admin" access rule.
 *
 * Used where an employee may read their own request but not anyone else's,
 * while an admin may read all of them.
 */
export function assertOwnerOrAdmin(
  req: Request,
  ownerEmployeeId: string | null,
  ownerDriverId: string | null = null,
): void {
  const ctx = auth(req);
  if (ctx.role === 'admin') return;
  if (ownerEmployeeId != null && ctx.employeeId === ownerEmployeeId) return;
  if (ownerDriverId != null && ctx.driverId === ownerDriverId) return;
  throw forbidden();
}

/** Helper for routes that take `(req, res, next)` but only need `next` on failure. */
export type Guard = (req: Request, res: Response, next: NextFunction) => void;
