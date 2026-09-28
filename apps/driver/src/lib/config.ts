import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

/**
 * Runtime configuration.
 *
 * Read from `expo.extra` in app.json, overridden per EAS build profile. Note
 * the Android emulator default: 10.0.2.2 is how the emulator reaches the host
 * machine's localhost, which is the one setting that always trips people up on
 * first run.
 */
function extra(): Record<string, unknown> {
  return (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
}

function readUrl(key: string, fallback: string): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:4000`;
  }

  const settings = extra();
  const emulatorKey = key === 'apiUrl' ? 'androidEmulatorApiUrl' : 'androidEmulatorSocketUrl';
  const value = Platform.OS === 'android' && !Device.isDevice
    ? settings[emulatorKey] ?? settings[key]
    : settings[key];
  return (typeof value === 'string' && value.length > 0 ? value : fallback).replace(/\/$/, '');
}

export const config = {
  apiUrl: readUrl('apiUrl', 'http://10.0.2.2:4000'),
  socketUrl: readUrl('socketUrl', 'http://10.0.2.2:4000'),

  /** Fallback push cadence; the backend tells us the real one on connect. */
  defaultGpsIntervalSec: 8,

  /**
   * Minimum metres moved before Android will deliver a background update.
   * Kept small — a shuttle crawling in a queue still needs to appear to move.
   */
  gpsDistanceIntervalM: 15,
} as const;
