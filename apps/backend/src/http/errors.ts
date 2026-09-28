/**
 * Error types and the terminal error handler.
 *
 * Routes throw; nothing catches locally. The handler below turns a throw into
 * the `ApiError` envelope every client already knows how to read, and makes
 * sure an unexpected exception never leaks a stack trace or a SQL fragment to
 * the browser.
 */

import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import type { ApiError } from '@shuttle/shared-types';
import { logger } from '../logger';
import { isPgError, PG_ERRORS } from '../db/pool';

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, string[]>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

export const badRequest = (message: string, details?: Record<string, string[]>) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);

/** The request is well-formed but the entity is in the wrong state for it. */
export const conflict = (code: string, message: string) => new AppError(409, code, message);

export const tooMany = (message = 'Too many requests') =>
  new AppError(429, 'RATE_LIMITED', message);

/**
 * Wrap an async handler so a rejected promise reaches Express's error pipeline.
 * Express 4 does not await handlers, so without this an async throw becomes an
 * unhandled rejection and the request hangs until the client times out.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Flatten a Zod error into the envelope's `details` shape. */
function zodDetails(err: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '(root)';
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `No route matches ${req.method} ${req.path}`));
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express needs the 4-arg shape
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let body: ApiError = {
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
  };

  if (err instanceof AppError) {
    status = err.status;
    body = {
      ok: false,
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    };
  } else if (err instanceof ZodError) {
    status = 400;
    body = {
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'Request validation failed', details: zodDetails(err) },
    };
  } else if (isPgError(err, PG_ERRORS.uniqueViolation)) {
    // A duplicate is the client's problem to fix, not a server fault — but the
    // constraint name would expose schema internals, so it stays in the log.
    status = 409;
    body = { ok: false, error: { code: 'ALREADY_EXISTS', message: 'That record already exists' } };
  } else if (isPgError(err, PG_ERRORS.foreignKeyViolation)) {
    status = 400;
    body = {
      ok: false,
      error: { code: 'INVALID_REFERENCE', message: 'A referenced record does not exist' },
    };
  } else if (isPgError(err, PG_ERRORS.checkViolation)) {
    status = 400;
    body = {
      ok: false,
      error: { code: 'CONSTRAINT_FAILED', message: 'The submitted values are not valid' },
    };
  }

  const log = status >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
  log(
    {
      err,
      status,
      code: body.error.code,
      method: req.method,
      path: req.path,
      userId: req.auth?.userId,
    },
    'request failed',
  );

  res.status(status).json(body);
};
