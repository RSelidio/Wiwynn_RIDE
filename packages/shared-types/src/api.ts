/**
 * HTTP API contract — request bodies, query shapes and response envelopes.
 *
 * Every endpoint answers with ApiSuccess<T> or ApiError, so clients have one
 * unwrapping path and one error path regardless of which route they called.
 */

import type {
  DashboardKpis,
  Driver,
  Employee,
  Gate,
  GateLogView,
  Notification,
  PickupRequestView,
  RequestSource,
  RequestStatus,
  Role,
  Route,
  RouteWithStops,
  Shuttle,
  ShuttleEtaBoard,
  ShuttleStatusView,
  Stop,
  StopKind,
  StopWaitingSummary,
  SystemSettings,
  TripView,
  User,
} from './domain';

// ─────────────────────────────────────────────────────────────────────────────
// Envelope
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: {
    /** Stable machine-readable code, e.g. 'REQUEST_ALREADY_ASSIGNED'. */
    code: string;
    message: string;
    /** Field-level problems, keyed by dotted field path. */
    details?: Record<string, string[]>;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface PaginationQuery {
  limit?: number;
  offset?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth (spec §12)
// ─────────────────────────────────────────────────────────────────────────────

export interface LoginBody {
  email: string;
  password: string;
}

/** What a signed-in client holds. The refresh token is an httpOnly cookie. */
export interface AuthSession {
  accessToken: string;
  expiresIn: number;
  user: User;
  employee: Employee | null;
  driver: Driver | null;
}

export interface JwtClaims {
  sub: string;
  role: Role;
  employeeId: string | null;
  driverId: string | null;
  iat: number;
  exp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pickup requests
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateRequestBody {
  pickupStopId: string;
  destinationStopId: string;
  passengerCount: number;
  note?: string | null;
  source?: RequestSource;
  /** Admin-only: raise a request on an employee's behalf. */
  employeeId?: string;
}

export interface ListRequestsQuery extends PaginationQuery {
  status?: RequestStatus | RequestStatus[];
  shuttleId?: string;
  driverId?: string;
  employeeId?: string;
  stopId?: string;
  /** Free-text over code, employee name, stop names and status. */
  q?: string;
  /** ISO dates, inclusive. Defaults to today in server time. */
  from?: string;
  to?: string;
}

export interface AssignRequestBody {
  shuttleId: string;
  /** Defaults to the driver on shift for that shuttle. */
  driverId?: string;
}

export interface CancelRequestBody {
  reason?: string;
}

export interface RejectRequestBody {
  reason?: string;
}

/** Driver sets the real head-count at boarding, which may differ from the ask. */
export interface BoardRequestBody {
  passengerCount?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shifts + GPS
// ─────────────────────────────────────────────────────────────────────────────

export interface StartShiftBody {
  shuttleId: string;
  routeId?: string | null;
}

export interface SetOnlineBody {
  isOnline: boolean;
}

/**
 * REST fallback for a GPS fix. The socket path is primary; this exists so a
 * driver device on a flaky connection can still flush a queued batch.
 */
export interface PostGpsBody {
  shiftId: string;
  fixes: Array<{
    latitude: number;
    longitude: number;
    speedKmh?: number | null;
    headingDeg?: number | null;
    accuracyM?: number | null;
    recordedAt: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stops + routes
// ─────────────────────────────────────────────────────────────────────────────

export interface UpsertStopBody {
  code: string;
  name: string;
  description?: string | null;
  latitude: number;
  longitude: number;
  kind: StopKind;
  geofenceM?: number | null;
  isActive?: boolean;
  displayOrder?: number;
}

export interface UpsertRouteBody {
  code: string;
  name: string;
  description?: string | null;
  /** When true, the last stop connects back to the first along the road network. */
  isLoop?: boolean;
  isActive?: boolean;
  /** Full ordered leg list. Replaces the existing sequence wholesale. */
  stops: Array<{
    stopId: string;
    stopOrder: number;
    distanceFromPrevM?: number | null;
    typicalTravelSec?: number | null;
  }>;
}

export interface UpsertShuttleBody {
  code: string;
  name: string;
  plateNo: string;
  model?: string | null;
  capacity?: number;
  defaultRouteId?: string | null;
  isActive?: boolean;
}

/** Admin-created local account and employee profile. */
export interface CreateEmployeeBody {
  email: string;
  password: string;
  displayName: string;
  badgeNo: string;
  rfidTag?: string | null;
  department?: string | null;
  defaultStopId?: string | null;
}

/** Admin-created local account and driver profile. */
export interface CreateDriverBody {
  email: string;
  password: string;
  displayName: string;
  driverNo: string;
  licenseNo?: string | null;
  phone?: string | null;
}

export type UpdateEmployeeBody = Partial<Omit<CreateEmployeeBody, 'password'>> & { password?: string; isActive?: boolean };
export type UpdateDriverBody = Partial<Omit<CreateDriverBody, 'password'>> & { password?: string; isActive?: boolean };

export interface ScanPassengerBadgeBody {
  shiftId: string;
  rfidTag: string;
}

export interface ScanPassengerBadgeResult {
  action: 'in' | 'out';
  employeeId: string;
  employeeName: string;
  badgeNo: string;
  onboardCount: number;
  capacity: number;
}

export interface OnboardPassenger {
  boardingId: string;
  employeeId: string;
  displayName: string;
  badgeNo: string;
  rfidTag: string;
  boardedAt: string;
}

export interface ClearOnboardPassengersResult {
  clearedCount: number;
  onboardCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate log (design doc §4a)
// ─────────────────────────────────────────────────────────────────────────────

export interface GateCheckInBody {
  gateId: string;
  shuttleId: string;
  driverId?: string | null;
  /** Defaults to server time; a guard may back-date a missed stamp. */
  checkedInAt?: string;
}

export interface GateCheckOutBody {
  checkedOutAt?: string;
  passengerCount?: number;
  remark?: string | null;
}

export interface UpdateGateLogBody {
  checkedInAt?: string;
  checkedOutAt?: string | null;
  passengerCount?: number;
  remark?: string | null;
}

export interface ListGateLogsQuery extends PaginationQuery {
  gateId?: string;
  shuttleId?: string;
  from?: string;
  to?: string;
  /** 'open' = still at the gate, 'closed' = departed. */
  state?: 'open' | 'closed';
}

// ─────────────────────────────────────────────────────────────────────────────
// Reports
// ─────────────────────────────────────────────────────────────────────────────

export interface ReportQuery {
  from?: string;
  to?: string;
  stopId?: string;
  shuttleId?: string;
}

export interface WaitTimeReport {
  bucket: string;
  requests: number;
  avgWaitSec: number | null;
  p90WaitSec: number | null;
}

export interface UtilizationReport {
  shuttleId: string;
  shuttleName: string;
  trips: number;
  passengers: number;
  seatUtilizationPct: number | null;
  activeMinutes: number;
}

export interface PopularStopReport {
  stopId: string;
  stopName: string;
  pickups: number;
  dropoffs: number;
}

export interface ReportsSummary {
  kpis: DashboardKpis;
  waitTimes: WaitTimeReport[];
  utilization: UtilizationReport[];
  popularStops: PopularStopReport[];
  from: string;
  to: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response aliases — what each route actually returns
// ─────────────────────────────────────────────────────────────────────────────

export type LoginResponse = ApiResponse<AuthSession>;
export type MeResponse = ApiResponse<AuthSession>;
export type StopsResponse = ApiResponse<Stop[]>;
export type RoutesResponse = ApiResponse<RouteWithStops[]>;
export type RouteResponse = ApiResponse<RouteWithStops>;
export type ShuttlesResponse = ApiResponse<Shuttle[]>;
export type ShuttleStatusesResponse = ApiResponse<ShuttleStatusView[]>;
export type ShuttleEtaResponse = ApiResponse<ShuttleEtaBoard>;
export type RequestsResponse = ApiResponse<Paginated<PickupRequestView>>;
export type RequestResponse = ApiResponse<PickupRequestView>;
export type TripsResponse = ApiResponse<Paginated<TripView>>;
export type GateLogsResponse = ApiResponse<Paginated<GateLogView>>;
export type GateLogResponse = ApiResponse<GateLogView>;
export type GatesResponse = ApiResponse<Gate[]>;
export type NotificationsResponse = ApiResponse<Paginated<Notification>>;
export type SettingsResponse = ApiResponse<SystemSettings>;
export type KpisResponse = ApiResponse<DashboardKpis>;
export type StopWaitingResponse = ApiResponse<StopWaitingSummary[]>;
export type ReportsResponse = ApiResponse<ReportsSummary>;
export type DriversResponse = ApiResponse<Paginated<Driver>>;
export type EmployeesResponse = ApiResponse<Paginated<Employee>>;
export type RoutesListResponse = ApiResponse<Route[]>;
