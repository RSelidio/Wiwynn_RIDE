/**
 * Gate log routes — the security guard tablet (design doc §4a).
 *
 * Deliberately narrow. A guard can list, check in, check out, correct and
 * remove entries at their gate, and nothing else: no dispatch, no employee
 * records, no settings.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../http/errors';
import { created, csv, noContent, ok, paginated } from '../http/respond';
import { isoDate, isoDateTime, pagination, parseBody, parseQuery, uuid, uuidParam } from '../http/validate';
import { auth, requireAdmin, requireAuth, requireGuard } from '../middleware/auth';
import * as gate from '../services/gate.service';
import { joinGateRoom } from '../realtime/io';

export const gateRouter = Router();

gateRouter.use(requireAuth, requireGuard);

const listSchema = pagination.extend({
  gateId: uuid.optional(),
  shuttleId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  state: z.enum(['open', 'closed']).optional(),
});

gateRouter.get(
  '/gates',
  asyncHandler(async (_req, res) => {
    ok(res, await gate.listGates());
  }),
);

/**
 * Subscribe the caller's sockets to a gate's room.
 *
 * Called when the tablet picks its gate, so a check-in made on one tablet at
 * the same gate appears on the other.
 */
gateRouter.post(
  '/gates/:id/watch',
  asyncHandler(async (req, res) => {
    const gateId = uuidParam(req, 'id');
    await joinGateRoom(auth(req).userId, gateId);
    ok(res, { watching: gateId });
  }),
);

gateRouter.get(
  '/logs',
  asyncHandler(async (req, res) => {
    const filters = parseQuery(req, listSchema);
    const { items, total } = await gate.list(filters);
    paginated(res, items, total, filters.limit, filters.offset);
  }),
);

/** Entries still standing at a gate — the tablet's "at gate" cards. */
gateRouter.get(
  '/gates/:id/open',
  asyncHandler(async (req, res) => {
    ok(res, await gate.listOpenAtGate(uuidParam(req, 'id')));
  }),
);

gateRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const { gateId } = parseQuery(req, z.object({ gateId: uuid.optional() }));
    ok(res, await gate.todaySummary(gateId));
  }),
);

gateRouter.post(
  '/logs',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({
        gateId: uuid,
        shuttleId: uuid,
        driverId: uuid.optional().nullable(),
        checkedInAt: isoDateTime.optional(),
      }),
    );
    created(res, await gate.checkIn(body, auth(req).userId));
  }),
);

gateRouter.post(
  '/logs/:id/checkout',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({
        checkedOutAt: isoDateTime.optional(),
        passengerCount: z.coerce.number().int().min(0).max(200).optional(),
        remark: z.string().max(120).optional().nullable(),
      }),
    );
    ok(res, await gate.checkOut(uuidParam(req, 'id'), body, auth(req).userId));
  }),
);

/** Live head-count adjustment while the shuttle is still at the gate. */
gateRouter.post(
  '/logs/:id/passengers',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({ passengerCount: z.coerce.number().int().min(0).max(200) }),
    );
    ok(
      res,
      await gate.setPassengerCount(uuidParam(req, 'id'), body.passengerCount, auth(req).userId),
    );
  }),
);

/** Correct an entry. `checkedOutAt: null` re-opens one closed by mistake. */
gateRouter.patch(
  '/logs/:id',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({
        checkedInAt: isoDateTime.optional(),
        checkedOutAt: isoDateTime.nullable().optional(),
        passengerCount: z.coerce.number().int().min(0).max(200).optional(),
        remark: z.string().max(120).nullable().optional(),
      }),
    );
    ok(res, await gate.update(uuidParam(req, 'id'), body, auth(req).userId));
  }),
);

gateRouter.delete(
  '/logs/:id',
  asyncHandler(async (req, res) => {
    await gate.remove(uuidParam(req, 'id'), auth(req).userId);
    noContent(res);
  }),
);

/** CSV export. Admin-only: the guard tablet has no reporting surface. */
gateRouter.get(
  '/logs.csv',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const filters = parseQuery(req, listSchema.partial());
    const body = await gate.exportCsv(filters);
    csv(res, 'gate-log.csv', body);
  }),
);
