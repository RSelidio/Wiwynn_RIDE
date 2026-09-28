/**
 * GPS ingest (spec §3).
 *
 * Devices push a fix every 5–10 s while a shift is open. Two things happen with
 * it, at deliberately different rates:
 *
 *   * The latest fix per shuttle is kept in this process and broadcast at once,
 *     so employees watch a live marker.
 *   * History is written to `shuttle_locations` at most every
 *     GPS_HISTORY_PERSIST_SEC. Persisting every push would mean roughly
 *     10,000 rows per shuttle per day for no analytical gain.
 *
 * Because the latest position lives in memory, it is lost on restart. That is
 * acceptable: the next push (within ~10 s) restores it, and the reader treats a
 * missing position as "no signal", which is the honest answer in the interim.
 */

import type { GpsPushPayload, LivePosition } from '@shuttle/shared-types';
import { distanceMeters } from '@shuttle/shared-utils';
import { config } from '../config';
import { query } from '../db/pool';
import { logger } from '../logger';

interface StoredPosition {
  shuttleId: string;
  driverId: string | null;
  shiftId: string | null;
  latitude: number;
  longitude: number;
  speedKmh: number | null;
  headingDeg: number | null;
  accuracyM: number | null;
  /** Server clock at receipt. Staleness is measured against this, not the device. */
  receivedAt: number;
  /** Device-reported time, passed through for the record. */
  recordedAt: string;
  /** When history was last written for this shuttle. */
  lastPersistedAt: number;
  /** Metres accumulated since the shift started, for trip distance. */
  odometerM: number;
}

const positions = new Map<string, StoredPosition>();

/** A fix further than this from the last one is treated as a GPS glitch. */
const MAX_JUMP_M = 2_000;

function toLivePosition(p: StoredPosition, now = Date.now()): LivePosition {
  const ageSec = Math.max(0, (now - p.receivedAt) / 1000);
  return {
    shuttleId: p.shuttleId,
    driverId: p.driverId,
    shiftId: p.shiftId,
    latitude: p.latitude,
    longitude: p.longitude,
    speedKmh: p.speedKmh,
    headingDeg: p.headingDeg,
    accuracyM: p.accuracyM,
    recordedAt: p.recordedAt,
    ageSec: Math.round(ageSec),
    isStale: ageSec > config.gps.staleAfterSec,
  };
}

export function getPosition(shuttleId: string): LivePosition | null {
  const stored = positions.get(shuttleId);
  return stored == null ? null : toLivePosition(stored);
}

export function getAllPositions(): LivePosition[] {
  const now = Date.now();
  return [...positions.values()].map((p) => toLivePosition(p, now));
}

export function getOdometerM(shuttleId: string): number {
  return positions.get(shuttleId)?.odometerM ?? 0;
}

/** Drop a shuttle's position when its shift ends, so it reads as off-shift. */
export function clearPosition(shuttleId: string): void {
  positions.delete(shuttleId);
}

export interface IngestResult {
  position: LivePosition;
  /** True when this fix was also written to history. */
  persisted: boolean;
  /** Metres moved since the previous fix, 0 for the first. */
  movedM: number;
}

/**
 * Accept one fix.
 *
 * Returns the resulting live position so the caller can broadcast it; this
 * function does not emit, which keeps it usable from both the socket handler
 * and the REST batch endpoint without double-broadcasting.
 */
export async function ingestFix(
  payload: GpsPushPayload,
  driverId: string | null,
): Promise<IngestResult> {
  const now = Date.now();
  const previous = positions.get(payload.shuttleId);

  const next: StoredPosition = {
    shuttleId: payload.shuttleId,
    driverId,
    shiftId: payload.shiftId,
    latitude: payload.latitude,
    longitude: payload.longitude,
    speedKmh: payload.speedKmh ?? null,
    headingDeg: payload.headingDeg ?? null,
    accuracyM: payload.accuracyM ?? null,
    receivedAt: now,
    recordedAt: payload.recordedAt,
    lastPersistedAt: previous?.lastPersistedAt ?? 0,
    odometerM: previous?.odometerM ?? 0,
  };

  let movedM = 0;
  if (previous != null) {
    movedM = distanceMeters(previous, next);
    if (movedM > MAX_JUMP_M) {
      // A multi-kilometre jump between two fixes seconds apart is a bad fix,
      // not a fast vehicle. Keep the position but do not credit the distance,
      // so one glitch cannot inflate a trip's mileage.
      logger.warn(
        { shuttleId: payload.shuttleId, movedM: Math.round(movedM) },
        'implausible GPS jump — distance not accumulated',
      );
      movedM = 0;
    }
    next.odometerM = previous.odometerM + movedM;
  }

  positions.set(payload.shuttleId, next);

  const sincePersistSec = (now - next.lastPersistedAt) / 1000;
  const shouldPersist = sincePersistSec >= config.gps.historyPersistSec;

  if (shouldPersist) {
    next.lastPersistedAt = now;
    try {
      await query(
        `INSERT INTO shuttle_locations
           (shuttle_id, driver_id, shift_id, latitude, longitude,
            speed_kmh, heading_deg, accuracy_m, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          payload.shuttleId,
          driverId,
          payload.shiftId,
          payload.latitude,
          payload.longitude,
          payload.speedKmh ?? null,
          payload.headingDeg ?? null,
          payload.accuracyM ?? null,
          payload.recordedAt,
        ],
      );
    } catch (err) {
      // A failed history write must not reject the fix — the live marker is
      // the part employees are watching.
      logger.error({ err, shuttleId: payload.shuttleId }, 'GPS history write failed');
      next.lastPersistedAt = previous?.lastPersistedAt ?? 0;
    }
  }

  return { position: toLivePosition(next, now), persisted: shouldPersist, movedM };
}

/** Recent track for a shuttle, newest first — the admin GPS trail. */
export async function getTrack(
  shuttleId: string,
  sinceMinutes = 60,
  limit = 500,
): Promise<Array<{ latitude: number; longitude: number; recordedAt: string; speedKmh: number | null }>> {
  const rows = await query<{
    latitude: number;
    longitude: number;
    recorded_at: Date;
    speed_kmh: number | null;
  }>(
    `SELECT latitude, longitude, recorded_at, speed_kmh
     FROM shuttle_locations
     WHERE shuttle_id = $1 AND recorded_at > now() - ($2 || ' minutes')::interval
     ORDER BY recorded_at DESC
     LIMIT $3`,
    [shuttleId, String(sinceMinutes), limit],
  );

  return rows.map((r) => ({
    latitude: r.latitude,
    longitude: r.longitude,
    recordedAt: r.recorded_at.toISOString(),
    speedKmh: r.speed_kmh,
  }));
}

/**
 * Delete history older than `days`.
 *
 * Called by the scheduler. Without this the table grows without bound; two
 * shuttles at 45-second sampling is roughly 3,800 rows a day.
 */
export async function pruneHistory(days = 90): Promise<number> {
  const rows = await query<{ count: number }>(
    `WITH deleted AS (
       DELETE FROM shuttle_locations
       WHERE recorded_at < now() - ($1 || ' days')::interval
       RETURNING 1
     )
     SELECT count(*)::int AS count FROM deleted`,
    [String(days)],
  );
  return rows[0]?.count ?? 0;
}
