/**
 * Driver-app routes: shifts and the GPS REST fallback (spec §2, §3).
 *
 * GPS normally flows over the socket. This REST endpoint exists because a
 * driver tablet on campus wifi does lose its connection, and the app queues
 * fixes locally; on reconnect it flushes the batch here in one request rather
 * than replaying dozens of socket events.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, conflict } from '../http/errors';
import { created, ok } from '../http/respond';
import { isoDateTime, latitude, longitude, parseBody, uuid, uuidParam } from '../http/validate';
import { auth, driverId as requireDriverId, requireAuth, requireRole } from '../middleware/auth';
import { recordFrom } from '../services/audit.service';
import { getBoard } from '../services/eta.service';
import { ingestFix } from '../services/gps.service';
import { realtime } from '../realtime/bus';
import * as requestsService from '../services/requests.service';
import * as passengersService from '../services/passengers.service';
import * as shifts from '../services/shifts.service';
import { getStatus } from '../services/shuttles.service';

export const driverRouter = Router();

driverRouter.use(requireAuth, requireRole('driver', 'admin'));

// ─────────────────────────────────────────────────────────────────────────────
// Shifts
// ─────────────────────────────────────────────────────────────────────────────

driverRouter.post(
  '/shifts',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({ shuttleId: uuid, routeId: uuid.optional().nullable() }),
    );
    const driver = requireDriverId(req);

    const shift = await shifts.startShift(driver, body.shuttleId, body.routeId ?? null);
    await recordFrom(req, 'shift.started', 'driver_shift', shift.id, {
      shuttleId: body.shuttleId,
    });

    // Dispatch should see the shuttle come on shift without waiting for a fix.
    realtime.shuttleStatus({ status: await getStatus(body.shuttleId) });
    created(res, shift);
  }),
);

/** The caller's open shift, or null. The driver app's first call on launch. */
driverRouter.get(
  '/shifts/current',
  asyncHandler(async (req, res) => {
    ok(res, await shifts.getOpenShiftForDriver(requireDriverId(req)));
  }),
);

driverRouter.get(
  '/shifts',
  asyncHandler(async (req, res) => {
    ok(res, await shifts.listShiftsForDriver(requireDriverId(req)));
  }),
);

driverRouter.post(
  '/shifts/:id/end',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req, 'id');
    const driver = requireDriverId(req);

    const open = await shifts.assertOwnedOpenShift(id, driver);
    const onboardCount = await passengersService.countOnboard(id);
    if (onboardCount > 0) {
      throw conflict('PASSENGERS_STILL_ONBOARD', `Scan ${onboardCount} passenger${onboardCount === 1 ? '' : 's'} OUT before ending the shift.`);
    }
    const shift = await shifts.endShift(id, driver);

    await recordFrom(req, 'shift.ended', 'driver_shift', id);
    realtime.shuttleStatus({ status: await getStatus(open.shuttleId) });
    ok(res, shift);
  }),
);

/** Online / offline toggle — the driver stays on shift but stops taking work. */
driverRouter.post(
  '/shifts/:id/online',
  asyncHandler(async (req, res) => {
    const body = parseBody(req, z.object({ isOnline: z.coerce.boolean() }));
    const id = uuidParam(req, 'id');
    const driver = requireDriverId(req);

    const shift = await shifts.setOnline(id, driver, body.isOnline);
    await recordFrom(req, 'shift.online_changed', 'driver_shift', id, { isOnline: body.isOnline });

    realtime.shuttleStatus({ status: await getStatus(shift.shuttleId) });
    ok(res, shift);
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GPS batch fallback (spec §3)
// ─────────────────────────────────────────────────────────────────────────────

const gpsSchema = z.object({
  shiftId: uuid,
  fixes: z
    .array(
      z.object({
        latitude,
        longitude,
        speedKmh: z.coerce.number().min(0).max(300).optional().nullable(),
        headingDeg: z.coerce.number().min(0).max(359.999).optional().nullable(),
        accuracyM: z.coerce.number().min(0).max(10_000).optional().nullable(),
        recordedAt: isoDateTime,
      }),
    )
    .min(1)
    // A queued batch from a long outage; anything larger is almost certainly a
    // client bug and should not be allowed to monopolise a connection.
    .max(200),
});

driverRouter.post(
  '/gps',
  asyncHandler(async (req, res) => {
    const body = parseBody(req, gpsSchema);
    const driver = requireDriverId(req);
    const caller = auth(req);

    const shift = await shifts.assertOwnedOpenShift(body.shiftId, driver);

    // Replay in chronological order so the odometer accumulates correctly and
    // the final stored position is genuinely the most recent one.
    const ordered = [...body.fixes].sort(
      (a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt),
    );

    let accepted = 0;
    for (const fix of ordered) {
      await ingestFix(
        {
          shuttleId: shift.shuttleId,
          shiftId: body.shiftId,
          latitude: fix.latitude,
          longitude: fix.longitude,
          speedKmh: fix.speedKmh ?? null,
          headingDeg: fix.headingDeg ?? null,
          accuracyM: fix.accuracyM ?? null,
          recordedAt: fix.recordedAt,
        },
        driver,
      );
      await requestsService.autoArriveAtPickupStops(shift.shuttleId, driver, caller.userId);
      accepted += 1;
    }

    // Broadcast once for the batch rather than once per queued fix — the
    // intermediate positions are already history by the time they arrive.
    const status = await getStatus(shift.shuttleId);
    if (status.position != null) {
      realtime.shuttlePosition({ shuttleId: shift.shuttleId, position: status.position });
    }
    const board = await getBoard(shift.shuttleId, true);
    if (board != null) {
      realtime.shuttleEta({
        shuttleId: board.shuttleId,
        estimates: board.estimates,
        computedAt: board.computedAt,
      });
    }

    ok(res, { accepted });
  }),
);

/** Tap an RFID badge to record IN, then tap it again to record OUT. */
driverRouter.post(
  '/passengers/scan',
  asyncHandler(async (req, res) => {
    const body = parseBody(req, z.object({ shiftId: uuid, rfidTag: z.string().trim().min(1).max(128) }));
    const driver = requireDriverId(req);
    const result = await passengersService.scanBadge(body.shiftId, driver, body.rfidTag);
    await recordFrom(req, `passenger.${result.action}`, 'employee', result.employeeId, {
      shuttleOnboard: result.onboardCount,
      shuttleCapacity: result.capacity,
      badgeNo: result.badgeNo,
    });
    ok(res, result);
  }),
);

driverRouter.post(
  '/passengers/clear-onboard',
  asyncHandler(async (req, res) => {
    const body = parseBody(req, z.object({ shiftId: uuid }));
    const driver = requireDriverId(req);
    const clearedCount = await passengersService.clearOnboard(body.shiftId, driver);
    await recordFrom(req, 'passengers.manual_clear', 'driver_shift', body.shiftId, { clearedCount });
    ok(res, { clearedCount, onboardCount: await passengersService.countOnboard(body.shiftId) });
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Driver's work list
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the driver app needs on one screen, in one round trip. */
driverRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const driver = requireDriverId(req);
    const shift = await shifts.getOpenShiftForDriver(driver);

    const [queue, offers] = await Promise.all([
      requestsService.listForDriver(driver),
      requestsService.listOffers(),
    ]);

    ok(res, {
      shift,
      status: shift == null ? null : await getStatus(shift.shuttleId),
      etaBoard: shift == null ? null : await getBoard(shift.shuttleId),
      queue,
      offers,
      gpsPushIntervalSec: Number(process.env.GPS_PUSH_INTERVAL_SEC ?? 8),
      onboardCount: shift == null ? 0 : await passengersService.countOnboard(shift.shiftId),
      onboardPassengers: shift == null ? [] : await passengersService.listOnboard(shift.shiftId),
    });
  }),
);

// A passenger-count correction is made when the driver taps "Picked up", via
// POST /api/requests/:id/board, which takes the real head-count. There is no
// separate endpoint, because changing the count after boarding would alter a
// trip's totals without a corresponding state change to audit.
