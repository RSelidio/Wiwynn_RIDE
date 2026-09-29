/**
 * API client for the driver app.
 *
 * Separate from `@shuttle/client` on purpose: that one keeps the refresh token
 * in an httpOnly cookie, which has no equivalent on a native device. Here the
 * refresh token is held in the platform keystore through expo-secure-store, so
 * a driver stays signed in across restarts without the token sitting in
 * AsyncStorage in plain text.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type {
  ApiResponse,
  AuthSession,
  ClearOnboardPassengersResult,
  OnboardPassenger,
  PickupRequestView,
  ShuttleEtaBoard,
  ShuttleStatusView,
  Shuttle,
  Route,
  RouteWithStops,
  ScanPassengerBadgeResult,
} from '@shuttle/shared-types';
import { config } from './config';

const REFRESH_KEY = 'shuttle.refreshToken';

export class DriverApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'DriverApiError';
    this.status = status;
    this.code = code;
  }
}

let accessToken: string | null = null;
let onSignedOut: (() => void) | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function setSignedOutHandler(handler: (() => void) | null): void {
  onSignedOut = handler;
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh token storage
// ─────────────────────────────────────────────────────────────────────────────

export async function storeRefreshToken(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(REFRESH_KEY, token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED,
    });
  } catch {
    // A device without a secure keystore still works for the current session;
    // the driver simply has to sign in again next launch.
  }
}

export async function readRefreshToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(REFRESH_KEY);
  } catch {
    return null;
  }
}

export async function clearRefreshToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(REFRESH_KEY);
  } catch {
    // Nothing further to do — the in-memory token is dropped regardless.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core request
// ─────────────────────────────────────────────────────────────────────────────

interface Options {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  skipRefresh?: boolean;
}

let refreshInFlight: Promise<boolean> | null = null;

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Exchange the stored refresh token for a new access token.
 *
 * The backend rotates refresh tokens, so the new one must be stored or the
 * next refresh fails. Shared across callers so a burst of 401s triggers one
 * refresh, not several that invalidate each other.
 */
async function refresh(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const isWeb = Platform.OS === 'web';
      const stored = isWeb ? null : await readRefreshToken();
      if (!isWeb && stored == null) return false;

      let response: Response;
      response = await fetchWithTimeout(`${config.apiUrl}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(!isWeb && stored != null ? { Cookie: `shuttle_refresh=${stored}` } : {}),
        },
      });
      if (!response.ok) return false;

      const body = (await response.json()) as ApiResponse<AuthSession>;
      if (!body.ok) return false;

      accessToken = body.data.accessToken;
      if (!isWeb) {
        const setCookie = response.headers.get('set-cookie');
        const match = setCookie == null ? null : /shuttle_refresh=([^;]+)/.exec(setCookie);
        if (match?.[1] != null) await storeRefreshToken(match[1]);
      }
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();

  return refreshInFlight;
}

export async function request<T>(path: string, options: Options = {}): Promise<T> {
  const { method = 'GET', body, skipRefresh } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken != null) headers.Authorization = `Bearer ${accessToken}`;

  const response = await fetchWithTimeout(`${config.apiUrl}/api${path}`, {
    method,
    headers,
    ...(Platform.OS === 'web' ? { credentials: 'include' as const } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 401 && skipRefresh !== true) {
    if (await refresh()) return request<T>(path, { ...options, skipRefresh: true });
    accessToken = null;
    await clearRefreshToken();
    onSignedOut?.();
    throw new DriverApiError(401, 'UNAUTHORIZED', 'Your session expired. Please sign in again.');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: ApiResponse<T> | null = null;
  try {
    parsed = text.length > 0 ? (JSON.parse(text) as ApiResponse<T>) : null;
  } catch {
    parsed = null;
  }

  if (parsed == null) {
    throw new DriverApiError(
      response.status,
      'BAD_RESPONSE',
      response.ok ? 'Unreadable response from the server.' : `Request failed (${response.status}).`,
    );
  }

  if (!parsed.ok) {
    throw new DriverApiError(response.status, parsed.error.code, parsed.error.message);
  }

  return parsed.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────────────────────────────────────

export interface DriverShiftInfo {
  shiftId: string;
  shuttleId: string;
  shuttleName: string;
  shuttleCode: string;
  capacity: number;
  driverId: string;
  driverName: string;
  routeId: string | null;
  routeName: string | null;
  isOnline: boolean;
  startedAt: string;
}

export interface DriverDashboard {
  shift: DriverShiftInfo | null;
  status: ShuttleStatusView | null;
  etaBoard: ShuttleEtaBoard | null;
  queue: PickupRequestView[];
  offers: PickupRequestView[];
  gpsPushIntervalSec: number;
  onboardCount: number;
  onboardPassengers: OnboardPassenger[];
}

export interface GpsFix {
  latitude: number;
  longitude: number;
  speedKmh?: number | null;
  headingDeg?: number | null;
  accuracyM?: number | null;
  recordedAt: string;
}

export const driverApi = {
  login: async (email: string, password: string): Promise<AuthSession> => {
    const response = await fetchWithTimeout(`${config.apiUrl}/api/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const body = (await response.json()) as ApiResponse<AuthSession>;
    if (!body.ok) {
      throw new DriverApiError(response.status, body.error.code, body.error.message);
    }

    accessToken = body.data.accessToken;

    // The backend sets the refresh token as a Set-Cookie. React Native does not
    // manage a cookie jar for us, so pull it out and put it in the keystore.
    if (Platform.OS !== 'web') {
      const setCookie = response.headers.get('set-cookie');
      const match = setCookie == null ? null : /shuttle_refresh=([^;]+)/.exec(setCookie);
      if (match?.[1] != null) await storeRefreshToken(match[1]);
    }

    return body.data;
  },

  restore: async (): Promise<AuthSession | null> => {
    if (!(await refresh())) return null;
    try {
      return await request<AuthSession>('/auth/me');
    } catch {
      return null;
    }
  },

  logout: async (): Promise<void> => {
    try {
      await request('/auth/logout', { method: 'POST' });
    } catch {
      // Sign out locally regardless.
    }
    accessToken = null;
    await clearRefreshToken();
  },

  dashboard: () => request<DriverDashboard>('/driver/dashboard'),
  currentShift: () => request<DriverShiftInfo | null>('/driver/shifts/current'),

  shuttles: () => request<Shuttle[]>('/fleet/shuttles'),
  routes: () => request<Route[]>('/fleet/routes'),
  routeDetails: () => request<RouteWithStops[]>('/fleet/routes'),

  startShift: (shuttleId: string, routeId: string | null) =>
    request<{ id: string }>('/driver/shifts', { method: 'POST', body: { shuttleId, routeId } }),
  endShift: (shiftId: string) =>
    request<{ id: string }>(`/driver/shifts/${shiftId}/end`, { method: 'POST' }),
  setOnline: (shiftId: string, isOnline: boolean) =>
    request<{ id: string }>(`/driver/shifts/${shiftId}/online`, { method: 'POST', body: { isOnline } }),

  pushGpsBatch: (shiftId: string, fixes: GpsFix[]) =>
    request<{ accepted: number }>('/driver/gps', { method: 'POST', body: { shiftId, fixes } }),

  scanPassengerBadge: (shiftId: string, rfidTag: string) =>
    request<ScanPassengerBadgeResult>('/driver/passengers/scan', {
      method: 'POST',
      body: { shiftId, rfidTag },
    }),

  clearOnboardPassengers: (shiftId: string) =>
    request<ClearOnboardPassengersResult>('/driver/passengers/clear-onboard', {
      method: 'POST',
      body: { shiftId },
    }),

  accept: (id: string) => request<PickupRequestView>(`/requests/${id}/accept`, { method: 'POST' }),
  reject: (id: string, reason?: string) =>
    request<PickupRequestView>(`/requests/${id}/reject`, { method: 'POST', body: { reason } }),
  arrived: (id: string) => request<PickupRequestView>(`/requests/${id}/arrived`, { method: 'POST' }),
  board: (id: string, passengerCount?: number) =>
    request<PickupRequestView>(`/requests/${id}/board`, { method: 'POST', body: { passengerCount } }),
  complete: (id: string) => request<PickupRequestView>(`/requests/${id}/complete`, { method: 'POST' }),
};
