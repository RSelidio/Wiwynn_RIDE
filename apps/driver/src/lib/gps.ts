/**
 * GPS tracking (spec §3).
 *
 * The device's own GPS — no paid location API. While a shift is active the app
 * reports position every few seconds, and keeps reporting with the screen off
 * via an Android foreground service, because a driver will put the tablet down.
 *
 * Fixes are queued and flushed in batches. A campus has dead spots, and a
 * dropped fix that is silently discarded is a shuttle that appears to teleport.
 */

import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { config } from './config';
import { driverApi, type GpsFix } from './api';

export const LOCATION_TASK = 'shuttle-location-updates';
/** Expo Go cannot run the background location task; use a foreground watcher there. */
export const backgroundTrackingSupported = Platform.OS !== 'web' && Constants.appOwnership !== 'expo';

/** Fixes waiting to be sent. Bounded so a long outage cannot exhaust memory. */
const MAX_QUEUE = 300;
let queue: GpsFix[] = [];
let activeShiftId: string | null = null;
let flushing = false;
let foregroundSubscription: Location.LocationSubscription | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** Listeners for the UI's "last fix" readout. */
type FixListener = (fix: GpsFix, queued: number) => void;
const listeners = new Set<FixListener>();
type UploadListener = (state: { uploading: boolean; error: string | null; lastSentAt: string | null }) => void;
const uploadListeners = new Set<UploadListener>();
let uploadState = { uploading: false, error: null as string | null, lastSentAt: null as string | null };

function publishUploadState(patch: Partial<typeof uploadState>): void {
  uploadState = { ...uploadState, ...patch };
  for (const listener of uploadListeners) listener(uploadState);
}

export function onFix(listener: FixListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function onUploadState(listener: UploadListener): () => void {
  uploadListeners.add(listener);
  listener(uploadState);
  return () => uploadListeners.delete(listener);
}

function toFix(location: Location.LocationObject): GpsFix {
  const { coords, timestamp } = location;
  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    // expo-location reports m/s; the API takes km/h.
    speedKmh: coords.speed == null || coords.speed < 0 ? null : (coords.speed * 3600) / 1000,
    headingDeg: coords.heading == null || coords.heading < 0 ? null : coords.heading,
    accuracyM: coords.accuracy ?? null,
    recordedAt: new Date(timestamp).toISOString(),
  };
}

export function enqueue(fix: GpsFix): void {
  queue.push(fix);
  // Drop the oldest first: a stale position is worth less than a recent one.
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);

  for (const listener of listeners) listener(fix, queue.length);
  void flush();
}

/**
 * Send whatever is queued.
 *
 * On failure the batch goes back on the front of the queue so ordering is
 * preserved and nothing is lost — the backend replays a batch chronologically.
 */
export async function flush(): Promise<void> {
  if (flushing || activeShiftId == null || queue.length === 0) return;

  flushing = true;
  const batch = queue;
  queue = [];
  publishUploadState({ uploading: true, error: null });

  try {
    const result = await driverApi.pushGpsBatch(activeShiftId, batch);
    if (result.accepted !== batch.length) {
      throw new Error(`Backend accepted ${result.accepted} of ${batch.length} GPS fixes.`);
    }
    publishUploadState({ uploading: false, error: null, lastSentAt: new Date().toISOString() });
  } catch (error) {
    queue = [...batch, ...queue].slice(-MAX_QUEUE);
    publishUploadState({
      uploading: false,
      error: error instanceof Error ? error.message : 'Could not send GPS to the server.',
    });
    if (retryTimer != null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush();
    }, 3_000);
  } finally {
    flushing = false;
  }
}

export function queueLength(): number {
  return queue.length;
}

// The background task runs outside React, so it reads the shift id from module
// state rather than from a hook.
if (Platform.OS !== 'web') {
  TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
    if (error != null) return;

    const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations;
    if (locations == null) return;

    for (const location of locations) enqueue(toFix(location));

    // Await the flush so the OS keeps the task alive until the fixes are sent —
    // returning early can have the process suspended mid-request.
    await flush();
  });
}

export interface PermissionResult {
  granted: boolean;
  background: boolean;
  message?: string;
}

/**
 * Ask for location permission.
 *
 * Foreground is requested first and background second, which is the order
 * Android requires — asking for background up front is rejected outright.
 */
export async function requestPermissions(): Promise<PermissionResult> {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (!foreground.granted) {
    return {
      granted: false,
      background: false,
      message: 'Location permission is required to run a shift.',
    };
  }

  // Expo Go has no background location service. Avoid calling its background
  // permission API; foreground watching is sufficient while the app stays open.
  if (!backgroundTrackingSupported) {
    return { granted: true, background: false };
  }

  const background = await Location.requestBackgroundPermissionsAsync();

  return {
    granted: true,
    background: background.granted,
    ...(background.granted
      ? {}
      : {
          message:
            'Background location is off, so tracking stops when the screen locks. Allow "Always" in Settings to keep reporting.',
        }),
  };
}

export async function startTracking(shiftId: string, intervalSec: number): Promise<void> {
  activeShiftId = shiftId;

  if (!backgroundTrackingSupported) {
    foregroundSubscription?.remove();
    foregroundSubscription = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: Math.max(1, intervalSec) * 1000,
        distanceInterval: config.gpsDistanceIntervalM,
      },
      (location) => enqueue(toFix(location)),
    );
    return;
  }

  const already = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  if (already) await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => undefined);

  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: Math.max(1, intervalSec) * 1000,
    distanceInterval: config.gpsDistanceIntervalM,
    // Android kills background location without a visible notification, and
    // the driver should know when the shuttle is being tracked anyway.
    foregroundService: {
      notificationTitle: 'Shift active',
      notificationBody: 'Your shuttle position is being shared with waiting employees.',
      notificationColor: '#006090',
    },
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
  });
}

export async function stopTracking(): Promise<void> {
  activeShiftId = null;
  foregroundSubscription?.remove();
  foregroundSubscription = null;
  if (retryTimer != null) clearTimeout(retryTimer);
  retryTimer = null;

  if (!backgroundTrackingSupported) {
    queue = [];
    return;
  }

  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => undefined);

  queue = [];
  publishUploadState({ uploading: false, error: null });
}

/** One immediate fix, so the map is populated the moment a shift starts. */
export async function pushOnce(shiftId: string): Promise<void> {
  activeShiftId = shiftId;
  try {
    const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    enqueue(toFix(location));
  } catch {
    // No fix yet — the periodic updates will supply one.
  }
}
