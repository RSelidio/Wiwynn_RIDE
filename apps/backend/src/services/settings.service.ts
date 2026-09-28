/**
 * System settings — the admin-editable dispatch switches and thresholds.
 *
 * Cached in memory because the ETA engine, the geofence check and the scheduler
 * consult them on every GPS fix. A write invalidates the cache and broadcasts,
 * so a toggle in the dashboard takes effect on the next fix rather than at the
 * next restart.
 */

import type { SystemSettings } from '@shuttle/shared-types';
import { config } from '../config';
import { query, queryOne } from '../db/pool';
import { rowToSettings } from '../db/rows';
import { realtime } from '../realtime/bus';

const CACHE_TTL_MS = 10_000;

let cache: { value: SystemSettings; readAt: number } | null = null;

/** Defaults matching the schema, used before the first read succeeds. */
const FALLBACK: SystemSettings = {
  autoAssign: false,
  requireGateLog: true,
  pushEtaEnabled: true,
  nightService: false,
  gpsGapAlertSec: config.gps.staleAfterSec,
  longWaitAlertMin: 10,
  stopGeofenceM: config.geofenceM,
  requestExpiryMin: 20,
  approachingNoticeMin: 2,
};

const COLUMNS = `
  auto_assign, require_gate_log, push_eta_enabled, night_service,
  gps_gap_alert_sec, long_wait_alert_min, stop_geofence_m,
  request_expiry_min, approaching_notice_min
`;

export async function getSettings(): Promise<SystemSettings> {
  if (cache != null && Date.now() - cache.readAt < CACHE_TTL_MS) return cache.value;

  const row = await queryOne(`SELECT ${COLUMNS} FROM system_settings WHERE id = true`);
  const value = rowToSettings.one(row) ?? FALLBACK;
  cache = { value, readAt: Date.now() };
  return value;
}

/**
 * Read settings without awaiting.
 *
 * The GPS ingest path runs many times a second and cannot afford an await per
 * fix. It uses this, accepting settings that may be up to CACHE_TTL_MS stale —
 * a geofence radius one tick out of date changes nothing that matters.
 */
export function getSettingsSync(): SystemSettings {
  return cache?.value ?? FALLBACK;
}

export async function updateSettings(patch: Partial<SystemSettings>): Promise<SystemSettings> {
  const columnFor: Record<keyof SystemSettings, string> = {
    autoAssign: 'auto_assign',
    requireGateLog: 'require_gate_log',
    pushEtaEnabled: 'push_eta_enabled',
    nightService: 'night_service',
    gpsGapAlertSec: 'gps_gap_alert_sec',
    longWaitAlertMin: 'long_wait_alert_min',
    stopGeofenceM: 'stop_geofence_m',
    requestExpiryMin: 'request_expiry_min',
    approachingNoticeMin: 'approaching_notice_min',
  };

  const sets: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(patch)) {
    const column = columnFor[key as keyof SystemSettings];
    if (column == null || value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }

  if (sets.length === 0) return getSettings();

  sets.push('updated_at = now()');
  await query(`UPDATE system_settings SET ${sets.join(', ')} WHERE id = true`, values);

  cache = null;
  const next = await getSettings();
  realtime.settingsChanged(next);
  return next;
}

/** Warm the cache at startup so getSettingsSync is useful from the first fix. */
export async function primeSettings(): Promise<SystemSettings> {
  cache = null;
  return getSettings();
}
