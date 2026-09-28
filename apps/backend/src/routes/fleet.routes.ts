/**
 * Shuttles, stops, routes and live status.
 *
 * Reads are open to any signed-in user — an employee needs the stop list and
 * the shuttle board to choose a pickup. Writes are admin-only.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, notFound } from '../http/errors';
import { created, ok } from '../http/respond';
import { latitude, longitude, parseBody, parseQuery, uuid, uuidParam } from '../http/validate';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { recordFrom } from '../services/audit.service';
import { getBoard } from '../services/eta.service';
import { getTrack } from '../services/gps.service';
import * as routesService from '../services/routes.service';
import * as shuttles from '../services/shuttles.service';

export const fleetRouter = Router();

fleetRouter.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// Stops (spec §4)
// ─────────────────────────────────────────────────────────────────────────────

const stopSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(120),
  description: z.string().max(400).optional().nullable(),
  latitude,
  longitude,
  kind: z.enum(['pickup', 'dropoff', 'both']).default('both'),
  geofenceM: z.coerce.number().int().min(5).max(1000).optional().nullable(),
  isActive: z.coerce.boolean().optional(),
  displayOrder: z.coerce.number().int().min(0).max(9999).optional(),
});

fleetRouter.get(
  '/stops',
  asyncHandler(async (req, res) => {
    const { includeInactive } = parseQuery(
      req,
      z.object({ includeInactive: z.coerce.boolean().default(false) }),
    );
    ok(res, await routesService.listStops(includeInactive));
  }),
);

fleetRouter.post(
  '/stops',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const stop = await routesService.createStop(parseBody(req, stopSchema));
    await recordFrom(req, 'stop.created', 'stop', stop.id, { code: stop.code, name: stop.name });
    created(res, stop);
  }),
);

fleetRouter.patch(
  '/stops/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = uuidParam(req, 'id');
    const stop = await routesService.updateStop(id, parseBody(req, stopSchema.partial()));
    await recordFrom(req, 'stop.updated', 'stop', id);
    ok(res, stop);
  }),
);

/** Retire a stop. Never a hard delete — history references it. */
fleetRouter.delete(
  '/stops/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = uuidParam(req, 'id');
    const stop = await routesService.deactivateStop(id);
    await recordFrom(req, 'stop.deactivated', 'stop', id, { name: stop.name });
    ok(res, stop);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Routes (spec §5)
// ─────────────────────────────────────────────────────────────────────────────

const routeSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(120),
  description: z.string().max(400).optional().nullable(),
  isLoop: z.coerce.boolean().default(false),
  isActive: z.coerce.boolean().optional(),
  stops: z
    .array(
      z.object({
        stopId: uuid,
        stopOrder: z.coerce.number().int().min(0).max(999),
        distanceFromPrevM: z.coerce.number().int().min(0).max(200_000).optional().nullable(),
        typicalTravelSec: z.coerce.number().int().min(0).max(7200).optional().nullable(),
      }),
    )
    .min(2, 'A route needs at least two stops'),
});

fleetRouter.get(
  '/routes',
  asyncHandler(async (req, res) => {
    const { includeInactive } = parseQuery(
      req,
      z.object({ includeInactive: z.coerce.boolean().default(false) }),
    );
    ok(res, await routesService.listRoutes(includeInactive));
  }),
);

fleetRouter.get(
  '/routes/:id',
  asyncHandler(async (req, res) => {
    ok(res, await routesService.getRoute(uuidParam(req, 'id')));
  }),
);

fleetRouter.post(
  '/routes',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const route = await routesService.upsertRoute(parseBody(req, routeSchema));
    await recordFrom(req, 'route.created', 'route', route.id, { code: route.code });
    created(res, route);
  }),
);

fleetRouter.put(
  '/routes/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = uuidParam(req, 'id');
    const route = await routesService.upsertRoute(parseBody(req, routeSchema), id);
    await recordFrom(req, 'route.updated', 'route', id, { stops: route.stops.length });
    ok(res, route);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Shuttles
// ─────────────────────────────────────────────────────────────────────────────

const shuttleSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(120),
  plateNo: z.string().min(1).max(32),
  model: z.string().max(120).optional().nullable(),
  capacity: z.coerce.number().int().min(1).max(200).default(12),
  defaultRouteId: uuid.nullable().optional(),
  isActive: z.coerce.boolean().optional(),
});

fleetRouter.get(
  '/shuttles',
  asyncHandler(async (req, res) => {
    const { includeInactive } = parseQuery(
      req,
      z.object({ includeInactive: z.coerce.boolean().default(false) }),
    );
    ok(res, await shuttles.listShuttles(includeInactive));
  }),
);

/** Live board: one entry per shuttle with position, seats, next stop and ETA. */
fleetRouter.get(
  '/shuttles/status',
  asyncHandler(async (req, res) => {
    const { includeInactive } = parseQuery(
      req,
      z.object({ includeInactive: z.coerce.boolean().default(false) }),
    );
    ok(res, await shuttles.listStatuses(includeInactive));
  }),
);

/** Live positions only — the admin map layer polls this if its socket drops. */
fleetRouter.get(
  '/shuttles/positions',
  asyncHandler(async (_req, res) => {
    ok(res, await shuttles.listPositions());
  }),
);

fleetRouter.get(
  '/shuttles/:id/status',
  asyncHandler(async (req, res) => {
    ok(res, await shuttles.getStatus(uuidParam(req, 'id')));
  }),
);

/** Live road route from the shuttle's current GPS fix to its next stop. */
fleetRouter.get(
  '/shuttles/:id/navigation-path',
  asyncHandler(async (req, res) => {
    const { destinationStopId } = parseQuery(req, z.object({ destinationStopId: uuid.optional() }));
    ok(res, await shuttles.getNavigationPath(uuidParam(req, 'id'), destinationStopId));
  }),
);

/** Arrival estimates for every stop on this shuttle's route (spec §6). */
fleetRouter.get(
  '/shuttles/:id/eta',
  asyncHandler(async (req, res) => {
    const board = await getBoard(uuidParam(req, 'id'));
    if (board == null) throw notFound('Shuttle is not on shift, so it has no ETA board');
    ok(res, board);
  }),
);

/** Recent GPS trail, for the admin map's trail layer. */
fleetRouter.get(
  '/shuttles/:id/track',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { minutes, limit } = parseQuery(
      req,
      z.object({
        minutes: z.coerce.number().int().min(1).max(1440).default(60),
        limit: z.coerce.number().int().min(1).max(2000).default(500),
      }),
    );
    ok(res, await getTrack(uuidParam(req, 'id'), minutes, limit));
  }),
);

fleetRouter.post(
  '/shuttles',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const shuttle = await shuttles.createShuttle(parseBody(req, shuttleSchema));
    await recordFrom(req, 'shuttle.created', 'shuttle', shuttle.id, { code: shuttle.code });
    created(res, shuttle);
  }),
);

fleetRouter.patch(
  '/shuttles/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = uuidParam(req, 'id');
    const shuttle = await shuttles.updateShuttle(id, parseBody(req, shuttleSchema.partial()));
    await recordFrom(req, 'shuttle.updated', 'shuttle', id);
    ok(res, shuttle);
  }),
);
