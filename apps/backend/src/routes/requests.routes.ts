/**
 * Pickup request routes (spec §18).
 *
 * The lifecycle endpoints are separate verbs rather than one PATCH on `status`,
 * so each one can enforce its own role rule and carry its own payload — a
 * driver's "reject" takes a reason, an admin's "assign" takes a shuttle.
 */

import { Router, type Request } from 'express';
import { z } from 'zod';
import { REQUEST_STATUSES } from '@shuttle/shared-types';
import { asyncHandler, forbidden } from '../http/errors';
import { created, ok, paginated } from '../http/respond';
import { arrayOf, idOrCodeParam, pagination, parseBody, parseQuery, uuid, uuidParam } from '../http/validate';
import {
  auth,
  driverId as requireDriverId,
  employeeId as requireEmployeeId,
  requireAdmin,
  requireAuth,
  requireRole,
} from '../middleware/auth';
import * as requests from '../services/requests.service';
import type { Actor } from '../services/requests.service';

export const requestsRouter = Router();

requestsRouter.use(requireAuth);

function actorFrom(req: Request): Actor {
  const ctx = auth(req);
  return {
    userId: ctx.userId,
    role: ctx.role,
    driverId: ctx.driverId,
    employeeId: ctx.employeeId,
  };
}

const createSchema = z.object({
  pickupStopId: uuid,
  destinationStopId: uuid,
  passengerCount: z.coerce.number().int().min(1).max(20).default(1),
  note: z.string().max(240).optional().nullable(),
  source: z.enum(['pwa', 'kiosk', 'admin']).optional(),
  employeeId: uuid.optional(),
});

const listSchema = pagination.extend({
  status: arrayOf(z.enum(REQUEST_STATUSES)).optional(),
  shuttleId: uuid.optional(),
  driverId: uuid.optional(),
  employeeId: uuid.optional(),
  stopId: uuid.optional(),
  q: z.string().max(120).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const reasonSchema = z.object({ reason: z.string().max(240).optional().nullable() });

// ─────────────────────────────────────────────────────────────────────────────
// Employee
// ─────────────────────────────────────────────────────────────────────────────

/** Raise a request. An admin may raise one on an employee's behalf. */
requestsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parseBody(req, createSchema);
    const ctx = auth(req);

    let targetEmployeeId: string;
    if (body.employeeId != null) {
      if (ctx.role !== 'admin') throw forbidden('Only an administrator may request for someone else');
      targetEmployeeId = body.employeeId;
    } else {
      targetEmployeeId = requireEmployeeId(req);
    }

    const view = await requests.create(
      targetEmployeeId,
      { ...body, source: body.source ?? (ctx.role === 'admin' ? 'admin' : 'pwa') },
      actorFrom(req),
    );
    created(res, view);
  }),
);

/** The caller's own live request — what the PWA home screen polls as a fallback. */
requestsRouter.get(
  '/active',
  asyncHandler(async (req, res) => {
    ok(res, await requests.getActiveForEmployee(requireEmployeeId(req)));
  }),
);

/** The caller's own request history. */
requestsRouter.get(
  '/mine',
  asyncHandler(async (req, res) => {
    const { limit, offset } = parseQuery(req, pagination);
    const { items, total } = await requests.list({
      employeeId: requireEmployeeId(req),
      limit,
      offset,
    });
    paginated(res, items, total, limit, offset);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Driver
// ─────────────────────────────────────────────────────────────────────────────

/** Pending requests a driver may accept. */
requestsRouter.get(
  '/offers',
  requireRole('driver', 'admin'),
  asyncHandler(async (_req, res) => {
    ok(res, await requests.listOffers());
  }),
);

/** The driver's own queue. */
requestsRouter.get(
  '/queue',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    ok(res, await requests.listForDriver(requireDriverId(req)));
  }),
);

requestsRouter.post(
  '/:id/accept',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const ctx = auth(req);
    ok(res, await requests.acceptAsDriver(uuidParam(req, 'id'), requireDriverId(req), ctx.userId));
  }),
);

requestsRouter.post(
  '/:id/reject',
  requireRole('driver', 'admin'),
  asyncHandler(async (req, res) => {
    const { reason } = parseBody(req, reasonSchema);
    ok(res, await requests.reject(uuidParam(req, 'id'), actorFrom(req), reason));
  }),
);

requestsRouter.post(
  '/:id/arrived',
  requireRole('driver', 'admin'),
  asyncHandler(async (req, res) => {
    ok(res, await requests.markArrived(uuidParam(req, 'id'), actorFrom(req)));
  }),
);

requestsRouter.post(
  '/:id/board',
  requireRole('driver', 'admin'),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({ passengerCount: z.coerce.number().int().min(1).max(20).optional() }),
    );
    ok(
      res,
      await requests.board(uuidParam(req, 'id'), actorFrom(req), body.passengerCount),
    );
  }),
);

requestsRouter.post(
  '/:id/complete',
  requireRole('driver', 'admin'),
  asyncHandler(async (req, res) => {
    ok(res, await requests.complete(uuidParam(req, 'id'), actorFrom(req)));
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Shared
// ─────────────────────────────────────────────────────────────────────────────

/** Cancel. Employees may cancel their own; drivers and admins any assigned one. */
requestsRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const { reason } = parseBody(req, reasonSchema);
    ok(res, await requests.cancel(uuidParam(req, 'id'), actorFrom(req), reason));
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Admin
// ─────────────────────────────────────────────────────────────────────────────

requestsRouter.get(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const filters = parseQuery(req, listSchema);
    const { items, total } = await requests.list(filters);
    paginated(res, items, total, filters.limit, filters.offset);
  }),
);

requestsRouter.get(
  '/open',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    ok(res, await requests.listOpen());
  }),
);

requestsRouter.post(
  '/:id/assign',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(req, z.object({ shuttleId: uuid, driverId: uuid.optional() }));
    ok(
      res,
      await requests.assign(uuidParam(req, 'id'), body.shuttleId, actorFrom(req), body.driverId),
    );
  }),
);

/**
 * Fetch one request by id or code.
 *
 * Registered last so `/active`, `/mine`, `/offers`, `/queue` and `/open` are
 * matched as literal paths rather than being swallowed by `:id`.
 */
requestsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const view = await requests.getViewById(idOrCodeParam(req, 'id'));
    const ctx = auth(req);

    // An employee may read only their own; a driver only what is theirs.
    if (ctx.role === 'employee' && view.employeeId !== ctx.employeeId) throw forbidden();
    if (ctx.role === 'driver' && view.driverId != null && view.driverId !== ctx.driverId) {
      throw forbidden();
    }

    ok(res, view);
  }),
);
