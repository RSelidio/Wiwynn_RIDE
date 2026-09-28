/**
 * "About me" routes — notifications, trip history and profile.
 *
 * Everything here is scoped to the caller by construction: the employee id
 * comes from the access token, never from a query parameter, so there is no
 * shape of request that reads someone else's data.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../http/errors';
import { ok, paginated } from '../http/respond';
import { pagination, parseQuery, uuidParam } from '../http/validate';
import { auth, employeeId as requireEmployeeId, requireAuth } from '../middleware/auth';
import * as notifications from '../services/notifications.service';
import { getActiveForEmployee } from '../services/requests.service';
import { listStops } from '../services/routes.service';
import { listStatuses } from '../services/shuttles.service';
import * as trips from '../services/trips.service';

export const meRouter = Router();

meRouter.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────────────────

meRouter.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const { limit, offset } = parseQuery(req, pagination);
    const { items, total, unread } = await notifications.listForUser(
      auth(req).userId,
      limit,
      offset,
    );
    // The unread count rides along so the bell badge needs no second request.
    res.setHeader('X-Unread-Count', String(unread));
    paginated(res, items, total, limit, offset);
  }),
);

meRouter.post(
  '/notifications/:id/read',
  asyncHandler(async (req, res) => {
    await notifications.markRead(auth(req).userId, uuidParam(req, 'id'));
    ok(res, { read: true });
  }),
);

meRouter.post(
  '/notifications/read-all',
  asyncHandler(async (req, res) => {
    ok(res, { marked: await notifications.markAllRead(auth(req).userId) });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Trips
// ─────────────────────────────────────────────────────────────────────────────

meRouter.get(
  '/trips',
  asyncHandler(async (req, res) => {
    const { limit } = parseQuery(req, z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }));
    ok(res, await trips.listForEmployee(requireEmployeeId(req), limit));
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Home screen bootstrap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One call that fills the employee PWA's home screen: the stop list, the
 * current live request, the shuttle board and recent trips.
 *
 * A phone on campus wifi pays for each round trip, so the first paint should
 * cost one request rather than five.
 */
meRouter.get(
  '/home',
  asyncHandler(async (req, res) => {
    const employeeId = requireEmployeeId(req);

    const [stops, activeRequest, shuttles, recentTrips, notes] = await Promise.all([
      listStops(),
      getActiveForEmployee(employeeId),
      listStatuses(),
      trips.listForEmployee(employeeId, 5),
      notifications.listForUser(auth(req).userId, 10, 0),
    ]);

    ok(res, {
      stops,
      activeRequest,
      shuttles,
      recentTrips,
      notifications: notes.items,
      unreadCount: notes.unread,
    });
  }),
);
