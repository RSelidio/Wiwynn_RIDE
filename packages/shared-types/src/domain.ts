/**
 * Domain models — one type per database entity (spec §11).
 *
 * These mirror `database/schema.sql`. Timestamps cross the wire as ISO-8601
 * strings, never as `Date`, so the same type is valid in Node, in the browser
 * and in React Native without a serialisation step in between.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Identity + access control (spec §12)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Access roles (spec §12 names employee, driver and admin).
 *
 * `guard` is added for the security team on the Main Building gate tablet. They
 * need to stamp shuttles in and out but must not reach dispatch, employee
 * records or settings, so folding them into `admin` would over-grant badly.
 */
export const ROLES = ['employee', 'driver', 'admin', 'guard'] as const;
export type Role = (typeof ROLES)[number];

/** How a user's credentials were verified. Local is DEV; Entra is the PROD target. */
export type AuthProvider = 'local' | 'entra';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  provider: AuthProvider;
  /** Set only for provider === 'entra'; the Entra object id. */
  externalId: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Employee {
  id: string;
  userId: string;
  badgeNo: string;
  /** Unique RFID badge token used by the driver boarding scanner. */
  rfidTag: string | null;
  displayName: string;
  department: string | null;
  /** Stop the employee is most often picked up from; pre-selects the UI. */
  defaultStopId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Driver {
  id: string;
  userId: string;
  driverNo: string;
  displayName: string;
  licenseNo: string | null;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fleet
// ─────────────────────────────────────────────────────────────────────────────

export interface Shuttle {
  id: string;
  code: string;
  name: string;
  plateNo: string;
  model: string | null;
  capacity: number;
  /** Route preselected for the driver at shift start; driver may still choose another. */
  defaultRouteId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A GPS fix from a driver device (spec §3).
 *
 * The *latest* fix per shuttle is held in memory by the backend and broadcast
 * immediately; rows are written to `shuttle_locations` at a lower frequency
 * (GPS_HISTORY_PERSIST_SEC) so a 5-second push cadence does not turn into a
 * 5-second write cadence.
 */
export interface ShuttleLocation {
  id: string;
  shuttleId: string;
  driverId: string | null;
  shiftId: string | null;
  latitude: number;
  longitude: number;
  /** km/h as reported by the device, or null when the device omits it. */
  speedKmh: number | null;
  /** Degrees clockwise from true north, 0–359. */
  headingDeg: number | null;
  /** Horizontal accuracy in metres. */
  accuracyM: number | null;
  recordedAt: string;
  createdAt: string;
}

/** The in-memory "where is it right now" record. Not a database row. */
export interface LivePosition {
  shuttleId: string;
  driverId: string | null;
  shiftId: string | null;
  latitude: number;
  longitude: number;
  speedKmh: number | null;
  headingDeg: number | null;
  accuracyM: number | null;
  recordedAt: string;
  /** Seconds since `recordedAt`, computed at read time. */
  ageSec: number;
  /** True once ageSec exceeds GPS_STALE_AFTER_SEC. */
  isStale: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stops + routes (spec §4, §5)
// ─────────────────────────────────────────────────────────────────────────────

export type StopKind = 'pickup' | 'dropoff' | 'both';

export interface Stop {
  id: string;
  code: string;
  name: string;
  description: string | null;
  latitude: number;
  longitude: number;
  kind: StopKind;
  /** Metres around the stop that count as arrived; falls back to STOP_GEOFENCE_M. */
  geofenceM: number | null;
  isActive: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Route {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** Route returns from its final stop to the first stop. */
  isLoop: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One ordered leg of a route: "at position N, stop X, and it takes M seconds to reach". */
export interface RouteStop {
  id: string;
  routeId: string;
  stopId: string;
  stopOrder: number;
  /** Metres from the previous stop; on stop 1 of a loop this is the return leg from the final stop. */
  distanceFromPrevM: number | null;
  /** Configured seconds from the previous stop; on stop 1 of a loop this is the return leg. */
  typicalTravelSec: number | null;
  createdAt: string;
  updatedAt: string;
}

/** A route with its legs resolved — what the ETA engine and admin UI consume. */
export interface RouteWithStops extends Route {
  stops: Array<RouteStop & { stop: Stop }>;
  /** Road-snapped route geometry from the configured OSRM routing service; null when unavailable. */
  roadPath?: Array<{ latitude: number; longitude: number }> | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shifts
// ─────────────────────────────────────────────────────────────────────────────

export interface DriverShift {
  id: string;
  driverId: string;
  shuttleId: string;
  routeId: string | null;
  startedAt: string;
  endedAt: string | null;
  /** Driver-controlled availability; a shift can be open but the driver offline. */
  isOnline: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pickup requests + trips (spec §18)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Request lifecycle. The only legal transitions are encoded in
 * REQUEST_TRANSITIONS below — the backend refuses anything else, so a
 * double-tapped button cannot move a request backwards.
 */
export const REQUEST_STATUSES = [
  'pending',
  'accepted',
  'arrived',
  'boarding',
  'completed',
  'cancelled',
  'rejected',
  'expired',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const REQUEST_TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  pending: ['accepted', 'rejected', 'cancelled', 'expired'],
  accepted: ['arrived', 'cancelled'],
  arrived: ['boarding', 'cancelled'],
  boarding: ['completed'],
  completed: [],
  cancelled: [],
  rejected: [],
  expired: [],
};

/** Statuses that still need dispatcher or driver attention. */
export const OPEN_REQUEST_STATUSES: readonly RequestStatus[] = [
  'pending',
  'accepted',
  'arrived',
  'boarding',
];

export type RequestSource = 'pwa' | 'kiosk' | 'admin';

export interface PickupRequest {
  id: string;
  code: string;
  employeeId: string;
  pickupStopId: string;
  destinationStopId: string;
  passengerCount: number;
  status: RequestStatus;
  shuttleId: string | null;
  driverId: string | null;
  tripId: string | null;
  source: RequestSource;
  note: string | null;
  requestedAt: string;
  acceptedAt: string | null;
  arrivedAt: string | null;
  boardedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  /** Free-text reason captured on cancel/reject, shown in the admin timeline. */
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A request joined with the names every UI needs, so no client re-joins by hand. */
export interface PickupRequestView extends PickupRequest {
  employeeName: string;
  employeeBadgeNo: string;
  employeeDepartment: string | null;
  pickupStopName: string;
  destinationStopName: string;
  shuttleName: string | null;
  shuttleCode: string | null;
  driverName: string | null;
  /** Live ETA in seconds to the pickup stop; null when unassigned or arrived. */
  etaSec: number | null;
  /** Free seats on the assigned shuttle; null when unassigned. */
  seatsAvailable: number | null;
}

export const TRIP_STATUSES = ['in_progress', 'completed', 'cancelled'] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

export interface Trip {
  id: string;
  code: string;
  shuttleId: string;
  driverId: string;
  shiftId: string | null;
  routeId: string | null;
  originStopId: string;
  destinationStopId: string;
  status: TripStatus;
  passengerCount: number;
  departedAt: string;
  arrivedAt: string | null;
  /** Metres travelled, summed from GPS history when the trip closes. */
  distanceM: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TripView extends Trip {
  shuttleName: string;
  driverName: string;
  originStopName: string;
  destinationStopName: string;
}

export interface TripPassenger {
  id: string;
  tripId: string;
  employeeId: string;
  requestId: string | null;
  boardedAt: string;
  droppedAt: string | null;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate log (design doc §4a — security guard tablet at the Main Building gate)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A guard stamps a shuttle in and out at the gate. `checkedOutAt` is null while
 * the shuttle is still standing at the gate, which is what drives the
 * "At gate" / "Departed" badge on both the guard tablet and admin reports.
 */
export interface GateLog {
  id: string;
  code: string;
  gateId: string;
  shuttleId: string;
  driverId: string | null;
  guardUserId: string;
  checkedInAt: string;
  checkedOutAt: string | null;
  passengerCount: number;
  remark: string | null;
  /** Set once a guard corrects an entry, so reports can show "· edited". */
  wasEdited: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GateLogView extends GateLog {
  shuttleName: string;
  shuttlePlateNo: string;
  driverName: string | null;
  guardName: string;
  gateName: string;
  /** Seconds between check-in and check-out; null while still at the gate. */
  dwellSec: number | null;
}

export interface Gate {
  id: string;
  code: string;
  name: string;
  stopId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications + audit
// ─────────────────────────────────────────────────────────────────────────────

export const NOTIFICATION_KINDS = [
  'request_accepted',
  'request_rejected',
  'shuttle_approaching',
  'shuttle_arrived',
  'trip_completed',
  'request_cancelled',
  'shift_reminder',
  'system',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface Notification {
  id: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  /** Deep-link target inside the app, e.g. "/requests/REQ-1042". */
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  /** Null for system-initiated actions such as request expiry. */
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  /** Shallow before/after diff; never contains credentials. */
  changes: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings + thresholds (admin-editable, design doc §1c settings page)
// ─────────────────────────────────────────────────────────────────────────────

export interface SystemSettings {
  /** Nearest shuttle with free seats takes a pending request automatically. */
  autoAssign: boolean;
  /** Guards must check shuttles in/out at the Main Building gate. */
  requireGateLog: boolean;
  /** Notify an employee when their shuttle is N minutes out. */
  pushEtaEnabled: boolean;
  /** Keep one shuttle on call after 22:00. */
  nightService: boolean;
  /** Seconds without a GPS fix before the shuttle is flagged. */
  gpsGapAlertSec: number;
  /** Minutes an employee may wait before the request escalates. */
  longWaitAlertMin: number;
  /** Metres around a stop that count as arrived. */
  stopGeofenceM: number;
  /** Minutes before a pending request expires unassigned. */
  requestExpiryMin: number;
  /** Minutes out at which the "approaching" push fires. */
  approachingNoticeMin: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// ETA (spec §6)
// ─────────────────────────────────────────────────────────────────────────────

/** How an ETA was derived — surfaced so the UI can hedge low-confidence numbers. */
export type EtaBasis = 'gps_speed' | 'historical' | 'configured' | 'at_stop' | 'unavailable';

export interface EtaEstimate {
  shuttleId: string;
  stopId: string;
  /** Null when no estimate is possible (no fix, no route, shuttle off shift). */
  etaSec: number | null;
  /** Remaining distance along the route in metres. */
  distanceM: number | null;
  basis: EtaBasis;
  /** 0..1. Drops as the fix ages or the route match weakens. */
  confidence: number;
  computedAt: string;
}

/** Every stop's ETA for one shuttle — what the driver "next stops" list renders. */
export interface ShuttleEtaBoard {
  shuttleId: string;
  shuttleName: string;
  routeId: string | null;
  estimates: EtaEstimate[];
  computedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite read models
// ─────────────────────────────────────────────────────────────────────────────

export type ShuttleOperationalStatus =
  | 'off_shift'
  | 'offline'
  | 'en_route'
  | 'at_stop'
  | 'full';

/** The one shape every surface uses to render a shuttle card. */
export interface ShuttleStatusView {
  shuttle: Shuttle;
  driverId: string | null;
  driverName: string | null;
  shiftId: string | null;
  status: ShuttleOperationalStatus;
  position: LivePosition | null;
  seatsOccupied: number;
  seatsAvailable: number;
  routeId: string | null;
  routeName: string | null;
  /** Next stop along the route, with its ETA. */
  nextStopId: string | null;
  nextStopName: string | null;
  nextStopEtaSec: number | null;
  /** Stop the shuttle is currently standing at, when inside a geofence. */
  atStopId: string | null;
  atStopName: string | null;
  openRequestCount: number;
}

/** Admin overview KPI row (design doc §1c). */
export interface DashboardKpis {
  activeShuttles: number;
  totalShuttles: number;
  onlineDrivers: number;
  waitingEmployees: number;
  pendingRequests: number;
  avgWaitMin: number | null;
  avgWaitDeltaMin: number | null;
  tripsToday: number;
  passengersToday: number;
  seatUtilizationPct: number | null;
  computedAt: string;
}

export interface StopWaitingSummary {
  stopId: string;
  stopName: string;
  waitingPassengers: number;
  openRequests: number;
  /** ETA of the soonest shuttle inbound to this stop. */
  nextEtaSec: number | null;
}
