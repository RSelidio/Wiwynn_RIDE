/**
 * Admin dashboard routes (spec §9).
 *
 * Monitoring reads, the management directories, reports and settings.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../http/errors';
import { created, csv, ok, paginated } from '../http/respond';
import { isoDate, pagination, parseBody, parseQuery, uuid, uuidParam } from '../http/validate';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { recordFrom } from '../services/audit.service';
import { buildSnapshot, getKpis, getStopWaiting, runAutoAssign } from '../services/dispatch.service';
import * as people from '../services/people.service';
import * as reports from '../services/reports.service';
import { getSettings, updateSettings } from '../services/settings.service';
import * as trips from '../services/trips.service';
import { query } from '../db/pool';
import { rowToAuditLog } from '../db/rows';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

const reportQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  stopId: uuid.optional(),
  shuttleId: uuid.optional(),
});

const localAccountPassword = z.string().min(12).max(200)
  .refine((value) => /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value), {
    message: 'Password must include uppercase, lowercase, and a number',
  });

const createEmployeeSchema = z.object({
  email: z.string().email().max(254),
  password: localAccountPassword,
  displayName: z.string().trim().min(1).max(120),
  badgeNo: z.string().trim().min(1).max(32),
  rfidTag: z.string().trim().min(1).max(128).optional().nullable(),
  department: z.string().trim().max(120).optional().nullable(),
  defaultStopId: uuid.nullable().optional(),
});

const createDriverSchema = z.object({
  email: z.string().email().max(254),
  password: localAccountPassword,
  displayName: z.string().trim().min(1).max(120),
  driverNo: z.string().trim().min(1).max(32),
  licenseNo: z.string().trim().max(80).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
});

const updateEmployeeSchema = createEmployeeSchema.partial().extend({ isActive: z.coerce.boolean().optional() }).refine((body) => Object.keys(body).length > 0, {
  message: 'Provide at least one field to update',
});

const updateDriverSchema = createDriverSchema.partial().extend({ isActive: z.coerce.boolean().optional() }).refine((body) => Object.keys(body).length > 0, {
  message: 'Provide at least one field to update',
});

// ─────────────────────────────────────────────────────────────────────────────
// Monitoring
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the overview page needs, in one request. */
adminRouter.get(
  '/snapshot',
  asyncHandler(async (_req, res) => {
    ok(res, await buildSnapshot());
  }),
);

adminRouter.get(
  '/kpis',
  asyncHandler(async (_req, res) => {
    ok(res, await getKpis());
  }),
);

adminRouter.get(
  '/stops/waiting',
  asyncHandler(async (_req, res) => {
    ok(res, await getStopWaiting());
  }),
);

/** Run auto-assignment now, rather than waiting for the scheduler. */
adminRouter.post(
  '/dispatch/auto-assign',
  asyncHandler(async (req, res) => {
    const assigned = await runAutoAssign();
    await recordFrom(req, 'dispatch.auto_assign_run', 'dispatch', null, { assigned });
    ok(res, { assigned });
  }),
);

adminRouter.patch(
  '/employees/:id',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req, 'id');
    const employee = await people.updateEmployee(id, parseBody(req, updateEmployeeSchema));
    await recordFrom(req, 'employee.updated', 'employee', id);
    ok(res, employee);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Trips
// ─────────────────────────────────────────────────────────────────────────────

adminRouter.get(
  '/trips',
  asyncHandler(async (req, res) => {
    const filters = parseQuery(
      req,
      pagination.extend({
        shuttleId: uuid.optional(),
        driverId: uuid.optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        q: z.string().max(120).optional(),
      }),
    );
    const { items, total } = await trips.list(filters);
    paginated(res, items, total, filters.limit, filters.offset);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Directories
// ─────────────────────────────────────────────────────────────────────────────

adminRouter.get(
  '/employees',
  asyncHandler(async (req, res) => {
    const { q, limit, offset } = parseQuery(
      req,
      pagination.extend({ q: z.string().max(120).optional() }),
    );
    const { items, total } = await people.listEmployees(q, limit, offset);
    paginated(res, items, total, limit, offset);
  }),
);

adminRouter.post(
  '/employees',
  asyncHandler(async (req, res) => {
    const employee = await people.createEmployee(parseBody(req, createEmployeeSchema));
    await recordFrom(req, 'employee.created', 'employee', employee.id, {
      badgeNo: employee.badgeNo,
      email: req.body.email,
    });
    created(res, employee);
  }),
);

adminRouter.patch(
  '/drivers/:id',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req, 'id');
    const driver = await people.updateDriver(id, parseBody(req, updateDriverSchema));
    await recordFrom(req, 'driver.updated', 'driver', id);
    ok(res, driver);
  }),
);

adminRouter.get(
  '/drivers',
  asyncHandler(async (req, res) => {
    const { q, limit, offset } = parseQuery(
      req,
      pagination.extend({ q: z.string().max(120).optional() }),
    );
    const { items, total } = await people.listDrivers(q, limit, offset);
    paginated(res, items, total, limit, offset);
  }),
);

adminRouter.post(
  '/drivers',
  asyncHandler(async (req, res) => {
    const driver = await people.createDriver(parseBody(req, createDriverSchema));
    await recordFrom(req, 'driver.created', 'driver', driver.id, {
      driverNo: driver.driverNo,
      email: req.body.email,
    });
    created(res, driver);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Reports (spec §9, §20)
// ─────────────────────────────────────────────────────────────────────────────

adminRouter.get(
  '/reports',
  asyncHandler(async (req, res) => {
    ok(res, await reports.summary(parseQuery(req, reportQuerySchema)));
  }),
);

adminRouter.get(
  '/reports/wait-times',
  asyncHandler(async (req, res) => {
    ok(res, await reports.waitTimes(parseQuery(req, reportQuerySchema)));
  }),
);

adminRouter.get(
  '/reports/utilization',
  asyncHandler(async (req, res) => {
    ok(res, await reports.utilization(parseQuery(req, reportQuerySchema)));
  }),
);

adminRouter.get(
  '/reports/popular-stops',
  asyncHandler(async (req, res) => {
    ok(res, await reports.popularStops(parseQuery(req, reportQuerySchema)));
  }),
);

adminRouter.get(
  '/reports/trips.csv',
  asyncHandler(async (req, res) => {
    const filters = parseQuery(req, reportQuerySchema);
    csv(res, `trips-${filters.from ?? 'recent'}.csv`, await reports.tripsCsv(filters));
  }),
);

adminRouter.get(
  '/reports/requests.csv',
  asyncHandler(async (req, res) => {
    const filters = parseQuery(req, reportQuerySchema);
    csv(res, `requests-${filters.from ?? 'recent'}.csv`, await reports.requestsCsv(filters));
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

const settingsSchema = z
  .object({
    autoAssign: z.coerce.boolean(),
    requireGateLog: z.coerce.boolean(),
    pushEtaEnabled: z.coerce.boolean(),
    nightService: z.coerce.boolean(),
    gpsGapAlertSec: z.coerce.number().int().min(5).max(600),
    longWaitAlertMin: z.coerce.number().int().min(1).max(120),
    stopGeofenceM: z.coerce.number().int().min(5).max(1000),
    requestExpiryMin: z.coerce.number().int().min(1).max(240),
    approachingNoticeMin: z.coerce.number().int().min(1).max(30),
  })
  .partial();

adminRouter.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    ok(res, await getSettings());
  }),
);

adminRouter.patch(
  '/settings',
  asyncHandler(async (req, res) => {
    const patch = parseBody(req, settingsSchema);
    const before = await getSettings();
    const after = await updateSettings(patch);

    await recordFrom(req, 'settings.updated', 'system_settings', null, {
      changed: Object.keys(patch),
      before,
      after,
    });
    ok(res, after);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Audit trail
// ─────────────────────────────────────────────────────────────────────────────

adminRouter.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const { limit, offset, entityType, entityId } = parseQuery(
      req,
      pagination.extend({
        entityType: z.string().max(60).optional(),
        entityId: z.string().max(64).optional(),
      }),
    );

    const rows = await query(
      `SELECT a.*, u.display_name AS actor_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE ($1::text IS NULL OR a.entity_type = $1)
         AND ($2::text IS NULL OR a.entity_id = $2)
       ORDER BY a.created_at DESC
       LIMIT $3 OFFSET $4`,
      [entityType ?? null, entityId ?? null, limit, offset],
    );

    const countRow = await query<{ total: number }>(
      `SELECT count(*)::int AS total FROM audit_logs
       WHERE ($1::text IS NULL OR entity_type = $1)
         AND ($2::text IS NULL OR entity_id = $2)`,
      [entityType ?? null, entityId ?? null],
    );

    paginated(res, rowToAuditLog.many(rows), countRow[0]?.total ?? 0, limit, offset);
  }),
);
