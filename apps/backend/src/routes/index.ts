/**
 * API surface. One backend serves the employee PWA, the driver app and the
 * admin dashboard (spec §10).
 */

import { Router } from 'express';
import { config } from '../config';
import { ok } from '../http/respond';
import { adminRouter } from './admin.routes';
import { authRouter } from './auth.routes';
import { driverRouter } from './driver.routes';
import { fleetRouter } from './fleet.routes';
import { gateRouter } from './gate.routes';
import { meRouter } from './me.routes';
import { requestsRouter } from './requests.routes';

export const apiRouter = Router();

/**
 * Liveness and readiness.
 *
 * Unauthenticated on purpose so IIS and the process manager can poll it, and
 * deliberately free of database access — a readiness probe that queries
 * PostgreSQL turns a slow query into a restart loop. The database check lives
 * in /health/ready instead.
 */
apiRouter.get('/health', (_req, res) => {
  ok(res, {
    status: 'ok',
    env: config.env,
    uptimeSec: Math.round(process.uptime()),
    version: process.env.npm_package_version ?? '0.1.0',
  });
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/me', meRouter);
apiRouter.use('/requests', requestsRouter);
apiRouter.use('/fleet', fleetRouter);
apiRouter.use('/driver', driverRouter);
apiRouter.use('/gate', gateRouter);
apiRouter.use('/admin', adminRouter);
