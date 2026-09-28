/**
 * Typed HTTP client.
 *
 * Every call unwraps the `ApiSuccess`/`ApiError` envelope, so callers get data
 * or a thrown `ApiRequestError` and never have to check `ok` themselves.
 *
 * Token handling: the access token is held in memory only. The refresh token is
 * an httpOnly cookie the browser sends automatically, so it is never readable
 * from JavaScript. On a 401 the client refreshes once and retries the original
 * request, which keeps a 15-minute access token invisible to the user.
 */

import type {
  ApiResponse,
  AuthSession,
  CreateDriverBody,
  CreateEmployeeBody,
  UpdateDriverBody,
  UpdateEmployeeBody,
  DashboardKpis,
  DispatchSnapshotPayload,
  Driver,
  Employee,
  Gate,
  GateLogView,
  Notification,
  Paginated,
  PickupRequestView,
  ReportsSummary,
  Route,
  RouteWithStops,
  ScanPassengerBadgeBody,
  ScanPassengerBadgeResult,
  Shuttle,
  ShuttleEtaBoard,
  ShuttleStatusView,
  Stop,
  StopWaitingSummary,
  SystemSettings,
  TripView,
  UpsertRouteBody,
  UpsertShuttleBody,
  UpsertStopBody,
} from '@shuttle/shared-types';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, string[]>;

  constructor(status: number, code: string, message: string, details?: Record<string, string[]>) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }

  /** The first message for a given field, for inline form errors. */
  fieldError(field: string): string | undefined {
    return this.details?.[field]?.[0];
  }
}

function baseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  return url.replace(/\/$/, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Token store
// ─────────────────────────────────────────────────────────────────────────────

let accessToken: string | null = null;
let onUnauthenticated: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Called when even a refresh fails, so the app can send the user to sign in. */
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler;
}

/**
 * In-flight refresh, shared by every caller.
 *
 * Without this, five parallel requests hitting 401 would fire five refreshes,
 * and token rotation would invalidate four of them.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${baseUrl()}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) return false;

      const body = (await response.json()) as ApiResponse<AuthSession>;
      if (!body.ok) return false;

      accessToken = body.data.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      // Clear on the next tick so concurrent callers all observe this result.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();

  return refreshInFlight;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core request
// ─────────────────────────────────────────────────────────────────────────────

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Query parameters; undefined and null entries are dropped. */
  params?: Record<string, string | number | boolean | undefined | null | string[]>;
  signal?: AbortSignal;
  /** Internal: prevents a refresh loop on the refresh call itself. */
  skipRefresh?: boolean;
}

function buildUrl(path: string, params?: RequestOptions['params']): string {
  const url = new URL(`${baseUrl()}/api${path.startsWith('/') ? path : `/${path}`}`);
  if (params != null) {
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, item);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, params, signal, skipRefresh } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken != null) headers.Authorization = `Bearer ${accessToken}`;

  const response = await fetch(buildUrl(path, params), {
    method,
    headers,
    credentials: 'include',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });

  if (response.status === 401 && !skipRefresh) {
    if (await refreshSession()) {
      return request<T>(path, { ...options, skipRefresh: true });
    }
    onUnauthenticated?.();
    throw new ApiRequestError(401, 'UNAUTHORIZED', 'Your session has expired. Please sign in again.');
  }

  if (response.status === 204) return undefined as T;

  // A proxy error or a crash can return HTML; do not let JSON.parse throw an
  // error that hides the real status code.
  const text = await response.text();
  let parsed: ApiResponse<T> | null = null;
  try {
    parsed = text.length > 0 ? (JSON.parse(text) as ApiResponse<T>) : null;
  } catch {
    parsed = null;
  }

  if (parsed == null) {
    throw new ApiRequestError(
      response.status,
      'BAD_RESPONSE',
      response.ok ? 'The server returned an unreadable response.' : `Request failed (${response.status}).`,
    );
  }

  if (!parsed.ok) {
    throw new ApiRequestError(
      response.status,
      parsed.error.code,
      parsed.error.message,
      parsed.error.details,
    );
  }

  return parsed.data;
}

/** Download an endpoint that answers with a file (the CSV exports). */
export async function download(path: string, params?: RequestOptions['params']): Promise<void> {
  const headers: Record<string, string> = {};
  if (accessToken != null) headers.Authorization = `Bearer ${accessToken}`;

  const response = await fetch(buildUrl(path, params), { headers, credentials: 'include' });
  if (!response.ok) {
    throw new ApiRequestError(response.status, 'DOWNLOAD_FAILED', 'The export could not be generated.');
  }

  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename="?([^"]+)"?/.exec(disposition);

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = match?.[1] ?? 'export.csv';
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────────────────────────────────────

export interface EmployeeHome {
  stops: Stop[];
  activeRequest: PickupRequestView | null;
  shuttles: ShuttleStatusView[];
  recentTrips: TripView[];
  notifications: Notification[];
  unreadCount: number;
}

export interface DriverDashboard {
  shift: {
    shiftId: string;
    shuttleId: string;
    shuttleName: string;
    capacity: number;
    driverId: string;
    driverName: string;
    routeId: string | null;
    routeName: string | null;
    isOnline: boolean;
    startedAt: string;
  } | null;
  status: ShuttleStatusView | null;
  etaBoard: ShuttleEtaBoard | null;
  queue: PickupRequestView[];
  offers: PickupRequestView[];
  gpsPushIntervalSec: number;
}

export const api = {
  // ── Auth ─────────────────────────────────────────────────────────────────
  auth: {
    login: (email: string, password: string) =>
      request<AuthSession>('/auth/login', { method: 'POST', body: { email, password } }),
    logout: () => request<{ loggedOut: boolean }>('/auth/logout', { method: 'POST' }),
    me: () => request<AuthSession>('/auth/me'),
    refresh: () => request<AuthSession>('/auth/refresh', { method: 'POST', skipRefresh: true }),
    providers: () => request<{ local: boolean; entra: boolean }>('/auth/providers'),
    changePassword: (currentPassword: string, newPassword: string) =>
      request<{ passwordChanged: boolean }>('/auth/password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      }),
  },

  // ── Employee ─────────────────────────────────────────────────────────────
  me: {
    home: () => request<EmployeeHome>('/me/home'),
    trips: (limit = 20) => request<TripView[]>('/me/trips', { params: { limit } }),
    notifications: (limit = 30, offset = 0) =>
      request<Paginated<Notification>>('/me/notifications', { params: { limit, offset } }),
    markRead: (id: string) => request<{ read: boolean }>(`/me/notifications/${id}/read`, { method: 'POST' }),
    markAllRead: () => request<{ marked: number }>('/me/notifications/read-all', { method: 'POST' }),
  },

  // ── Requests ─────────────────────────────────────────────────────────────
  requests: {
    create: (body: {
      pickupStopId: string;
      destinationStopId: string;
      passengerCount: number;
      note?: string | null;
      employeeId?: string;
    }) => request<PickupRequestView>('/requests', { method: 'POST', body }),

    active: () => request<PickupRequestView | null>('/requests/active'),
    mine: (limit = 20, offset = 0) =>
      request<Paginated<PickupRequestView>>('/requests/mine', { params: { limit, offset } }),
    get: (idOrCode: string) => request<PickupRequestView>(`/requests/${idOrCode}`),
    list: (params: Record<string, string | number | string[] | undefined>) =>
      request<Paginated<PickupRequestView>>('/requests', { params }),
    open: () => request<PickupRequestView[]>('/requests/open'),

    offers: () => request<PickupRequestView[]>('/requests/offers'),
    queue: () => request<PickupRequestView[]>('/requests/queue'),

    accept: (id: string) => request<PickupRequestView>(`/requests/${id}/accept`, { method: 'POST' }),
    reject: (id: string, reason?: string) =>
      request<PickupRequestView>(`/requests/${id}/reject`, { method: 'POST', body: { reason } }),
    assign: (id: string, shuttleId: string) =>
      request<PickupRequestView>(`/requests/${id}/assign`, { method: 'POST', body: { shuttleId } }),
    arrived: (id: string) => request<PickupRequestView>(`/requests/${id}/arrived`, { method: 'POST' }),
    board: (id: string, passengerCount?: number) =>
      request<PickupRequestView>(`/requests/${id}/board`, { method: 'POST', body: { passengerCount } }),
    complete: (id: string) => request<PickupRequestView>(`/requests/${id}/complete`, { method: 'POST' }),
    cancel: (id: string, reason?: string) =>
      request<PickupRequestView>(`/requests/${id}/cancel`, { method: 'POST', body: { reason } }),
  },

  // ── Fleet ────────────────────────────────────────────────────────────────
  fleet: {
    stops: (includeInactive = false) =>
      request<Stop[]>('/fleet/stops', { params: { includeInactive } }),
    createStop: (body: UpsertStopBody) =>
      request<Stop>('/fleet/stops', { method: 'POST', body }),
    updateStop: (id: string, body: Partial<UpsertStopBody>) =>
      request<Stop>(`/fleet/stops/${id}`, { method: 'PATCH', body }),
    deactivateStop: (id: string) => request<Stop>(`/fleet/stops/${id}`, { method: 'DELETE' }),

    routes: (includeInactive = false) => request<RouteWithStops[]>('/fleet/routes', { params: { includeInactive } }),
    route: (id: string) => request<RouteWithStops>(`/fleet/routes/${id}`),
    saveRoute: (body: UpsertRouteBody, id?: string) =>
      id == null
        ? request<RouteWithStops>('/fleet/routes', { method: 'POST', body })
        : request<RouteWithStops>(`/fleet/routes/${id}`, { method: 'PUT', body }),

    shuttles: (includeInactive = false) =>
      request<Shuttle[]>('/fleet/shuttles', { params: { includeInactive } }),
    statuses: (includeInactive = false) =>
      request<ShuttleStatusView[]>('/fleet/shuttles/status', { params: { includeInactive } }),
    status: (id: string) => request<ShuttleStatusView>(`/fleet/shuttles/${id}/status`),
    navigationPath: (id: string, destinationStopId?: string) =>
      request<Array<{ latitude: number; longitude: number }> | null>(`/fleet/shuttles/${id}/navigation-path`, {
        params: { destinationStopId },
      }),
    eta: (id: string) => request<ShuttleEtaBoard>(`/fleet/shuttles/${id}/eta`),
    track: (id: string, minutes = 60) =>
      request<Array<{ latitude: number; longitude: number; recordedAt: string; speedKmh: number | null }>>(
        `/fleet/shuttles/${id}/track`,
        { params: { minutes } },
      ),
    createShuttle: (body: UpsertShuttleBody) =>
      request<Shuttle>('/fleet/shuttles', { method: 'POST', body }),
    updateShuttle: (id: string, body: Partial<UpsertShuttleBody>) =>
      request<Shuttle>(`/fleet/shuttles/${id}`, { method: 'PATCH', body }),
  },

  // ── Driver ───────────────────────────────────────────────────────────────
  driver: {
    dashboard: () => request<DriverDashboard>('/driver/dashboard'),
    currentShift: () => request<DriverDashboard['shift']>('/driver/shifts/current'),
    startShift: (shuttleId: string, routeId?: string | null) =>
      request<{ id: string }>('/driver/shifts', { method: 'POST', body: { shuttleId, routeId } }),
    endShift: (shiftId: string) =>
      request<{ id: string }>(`/driver/shifts/${shiftId}/end`, { method: 'POST' }),
    setOnline: (shiftId: string, isOnline: boolean) =>
      request<{ id: string }>(`/driver/shifts/${shiftId}/online`, { method: 'POST', body: { isOnline } }),
    pushGps: (shiftId: string, fixes: DriverGpsFix[]) =>
      request<{ accepted: number }>('/driver/gps', { method: 'POST', body: { shiftId, fixes } }),
    scanPassengerBadge: (body: ScanPassengerBadgeBody) =>
      request<ScanPassengerBadgeResult>('/driver/passengers/scan', { method: 'POST', body }),
  },

  // ── Gate log ─────────────────────────────────────────────────────────────
  gate: {
    gates: () => request<Gate[]>('/gate/gates'),
    watch: (gateId: string) =>
      request<{ watching: string }>(`/gate/gates/${gateId}/watch`, { method: 'POST' }),
    logs: (params: Record<string, string | number | undefined> = {}) =>
      request<Paginated<GateLogView>>('/gate/logs', { params }),
    openAt: (gateId: string) => request<GateLogView[]>(`/gate/gates/${gateId}/open`),
    summary: (gateId?: string) =>
      request<{
        checkIns: number;
        atGateNow: number;
        passengers: number;
        avgDwellSec: number | null;
        editedCount: number;
      }>('/gate/summary', { params: { gateId } }),
    checkIn: (gateId: string, shuttleId: string) =>
      request<GateLogView>('/gate/logs', { method: 'POST', body: { gateId, shuttleId } }),
    checkOut: (id: string, body: { passengerCount?: number; remark?: string | null } = {}) =>
      request<GateLogView>(`/gate/logs/${id}/checkout`, { method: 'POST', body }),
    setPassengers: (id: string, passengerCount: number) =>
      request<GateLogView>(`/gate/logs/${id}/passengers`, { method: 'POST', body: { passengerCount } }),
    update: (id: string, body: Record<string, unknown>) =>
      request<GateLogView>(`/gate/logs/${id}`, { method: 'PATCH', body }),
    remove: (id: string) => request<void>(`/gate/logs/${id}`, { method: 'DELETE' }),
    exportCsv: (params: Record<string, string | undefined> = {}) => download('/gate/logs.csv', params),
  },

  // ── Admin ────────────────────────────────────────────────────────────────
  admin: {
    snapshot: () => request<DispatchSnapshotPayload>('/admin/snapshot'),
    kpis: () => request<DashboardKpis>('/admin/kpis'),
    stopWaiting: () => request<StopWaitingSummary[]>('/admin/stops/waiting'),
    autoAssign: () => request<{ assigned: number }>('/admin/dispatch/auto-assign', { method: 'POST' }),

    trips: (params: Record<string, string | number | undefined> = {}) =>
      request<Paginated<TripView>>('/admin/trips', { params }),
    employees: (params: Record<string, string | number | undefined> = {}) =>
      request<Paginated<AdminEmployeeRow>>('/admin/employees', { params }),
    createEmployee: (body: CreateEmployeeBody) =>
      request<Employee>('/admin/employees', { method: 'POST', body }),
    updateEmployee: (id: string, body: UpdateEmployeeBody) =>
      request<Employee>(`/admin/employees/${id}`, { method: 'PATCH', body }),
    drivers: (params: Record<string, string | number | undefined> = {}) =>
      request<Paginated<AdminDriverRow>>('/admin/drivers', { params }),
    createDriver: (body: CreateDriverBody) =>
      request<Driver>('/admin/drivers', { method: 'POST', body }),
    updateDriver: (id: string, body: UpdateDriverBody) =>
      request<Driver>(`/admin/drivers/${id}`, { method: 'PATCH', body }),

    reports: (params: Record<string, string | undefined> = {}) =>
      request<ReportsSummary>('/admin/reports', { params }),
    exportTrips: (params: Record<string, string | undefined> = {}) =>
      download('/admin/reports/trips.csv', params),
    exportRequests: (params: Record<string, string | undefined> = {}) =>
      download('/admin/reports/requests.csv', params),

    settings: () => request<SystemSettings>('/admin/settings'),
    saveSettings: (patch: Partial<SystemSettings>) =>
      request<SystemSettings>('/admin/settings', { method: 'PATCH', body: patch }),

    routesFlat: () => request<Route[]>('/fleet/routes'),
  },
};

/** Row shapes the admin directories return — mirror the backend's list items. */
export interface AdminEmployeeRow extends Employee {
  email: string;
  lastRequestAt: string | null;
  tripsLast30d: number;
}

export interface AdminDriverRow extends Driver {
  email: string;
  currentShuttleName: string | null;
  currentShiftStartedAt: string | null;
  isOnShift: boolean;
  tripsLast30d: number;
}

export interface DriverGpsFix {
  latitude: number;
  longitude: number;
  speedKmh?: number | null;
  headingDeg?: number | null;
  accuracyM?: number | null;
  recordedAt: string;
}
