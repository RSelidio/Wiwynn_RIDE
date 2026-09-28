/**
 * Express application.
 *
 * Built as a factory so tests can mount it without starting a listener or a
 * socket server.
 */

import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { config } from './config';
import { errorHandler, notFoundHandler } from './http/errors';
import { ok } from './http/respond';
import { logger } from './logger';
import { apiRouter } from './routes';
import { assertDatabaseReachable } from './db/pool';

export function createApp(): Express {
  const app = express();

  // IIS reverse-proxies to this process (spec §14), so the client address and
  // protocol arrive in X-Forwarded-*. Without this, rate limiting would see one
  // IP for the whole company and `secure` cookies would look insecure.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON, not documents, so a restrictive CSP here buys
      // nothing; the Next apps set their own.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and server-to-server calls arrive with no Origin header.
        if (origin == null) return callback(null, true);
        if (config.http.corsOrigins.includes(origin)) return callback(null, true);
        callback(new Error(`Origin ${origin} is not allowed`));
      },
      credentials: true,
      exposedHeaders: ['X-Unread-Count'],
    }),
  );

  // 256 KB is generous for the largest legitimate body (a queued GPS batch)
  // and small enough that a malformed upload cannot exhaust memory.
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  app.use(
    pinoHttp({
      logger,
      // Health polling every few seconds would otherwise drown the log.
      autoLogging: {
        ignore: (req) => req.url === '/api/health' || req.url === '/api/health/ready',
      },
      customLogLevel: (_req, res, err) => {
        if (err != null || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  // A blanket ceiling well above normal use. Login has its own tighter limit,
  // and GPS traffic goes over the socket rather than through here.
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      // A driver tablet flushing a queue should not be throttled alongside
      // browsers behind the same NAT address.
      skip: (req) => req.path === '/driver/gps',
    }),
  );

  app.use('/api', apiRouter);

  // Readiness: checks the database, so orchestration can tell "process is up"
  // from "process can actually serve traffic".
  app.get('/api/health/ready', (_req, res, next) => {
    assertDatabaseReachable()
      .then(() => ok(res, { status: 'ready' }))
      .catch(next);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
