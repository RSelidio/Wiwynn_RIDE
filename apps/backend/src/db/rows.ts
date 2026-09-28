/**
 * Row → DTO mapping.
 *
 * The database speaks snake_case and hands back `Date` objects; the shared DTOs
 * are camelCase with ISO-8601 strings. Converting in one place means no route
 * invents its own field names, and a `Date` can never escape to a client where
 * it would serialise differently depending on who called `JSON.stringify`.
 */

import type {
  AuditLog,
  Driver,
  DriverShift,
  Employee,
  Gate,
  GateLog,
  GateLogView,
  Notification,
  PickupRequest,
  PickupRequestView,
  Route,
  RouteStop,
  Shuttle,
  ShuttleLocation,
  Stop,
  SystemSettings,
  Trip,
  TripView,
  User,
} from '@shuttle/shared-types';

type Row = Record<string, unknown>;

function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Convert one row: snake_case keys to camelCase, `Date` values to ISO strings.
 *
 * The cast is unavoidable at the SQL boundary — nothing checks that a query's
 * select list matches `T`. Keeping every cast inside this file means there is
 * exactly one place to audit when a column is renamed.
 */
function camelize<T>(row: Row): T {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    out[toCamel(key)] = value instanceof Date ? value.toISOString() : value;
  }
  return out as T;
}

function mapper<T>(): { one: (row: Row | null) => T | null; many: (rows: Row[]) => T[] } {
  return {
    one: (row) => (row == null ? null : camelize<T>(row)),
    many: (rows) => rows.map((r) => camelize<T>(r)),
  };
}

export const rowToUser = mapper<User>();
export const rowToEmployee = mapper<Employee>();
export const rowToDriver = mapper<Driver>();
export const rowToShuttle = mapper<Shuttle>();
export const rowToStop = mapper<Stop>();
export const rowToRoute = mapper<Route>();
export const rowToRouteStop = mapper<RouteStop>();
export const rowToShift = mapper<DriverShift>();
export const rowToLocation = mapper<ShuttleLocation>();
export const rowToRequest = mapper<PickupRequest>();
export const rowToRequestView = mapper<PickupRequestView>();
export const rowToTrip = mapper<Trip>();
export const rowToTripView = mapper<TripView>();
export const rowToGate = mapper<Gate>();
export const rowToGateLog = mapper<GateLog>();
export const rowToGateLogView = mapper<GateLogView>();
export const rowToNotification = mapper<Notification>();
export const rowToAuditLog = mapper<AuditLog>();
export const rowToSettings = mapper<SystemSettings>();

// ─────────────────────────────────────────────────────────────────────────────
// Reusable select lists
//
// Joined reads are declared once here rather than inlined per route, so the
// shape a client receives cannot drift between "list requests" and
// "get one request".
// ─────────────────────────────────────────────────────────────────────────────

/** Columns for PickupRequestView, minus etaSec/seatsAvailable which are live. */
export const REQUEST_VIEW_SELECT = `
  r.id, r.code, r.employee_id, r.pickup_stop_id, r.destination_stop_id,
  r.passenger_count, r.status, r.shuttle_id, r.driver_id, r.trip_id, r.source,
  r.note, r.requested_at, r.accepted_at, r.arrived_at, r.boarded_at,
  r.completed_at, r.cancelled_at, r.cancel_reason, r.created_at, r.updated_at,
  e.display_name  AS employee_name,
  e.badge_no      AS employee_badge_no,
  e.department    AS employee_department,
  ps.name         AS pickup_stop_name,
  ds.name         AS destination_stop_name,
  sh.name         AS shuttle_name,
  sh.code         AS shuttle_code,
  dr.display_name AS driver_name
`;

export const REQUEST_VIEW_FROM = `
  FROM pickup_requests r
  JOIN employees e  ON e.id  = r.employee_id
  JOIN stops ps     ON ps.id = r.pickup_stop_id
  JOIN stops ds     ON ds.id = r.destination_stop_id
  LEFT JOIN shuttles sh ON sh.id = r.shuttle_id
  LEFT JOIN drivers dr  ON dr.id = r.driver_id
`;

export const TRIP_VIEW_SELECT = `
  t.id, t.code, t.shuttle_id, t.driver_id, t.shift_id, t.route_id,
  t.origin_stop_id, t.destination_stop_id, t.status, t.passenger_count,
  t.departed_at, t.arrived_at, t.distance_m, t.created_at, t.updated_at,
  sh.name         AS shuttle_name,
  dr.display_name AS driver_name,
  os.name         AS origin_stop_name,
  ds.name         AS destination_stop_name
`;

export const TRIP_VIEW_FROM = `
  FROM trips t
  JOIN shuttles sh ON sh.id = t.shuttle_id
  JOIN drivers dr  ON dr.id = t.driver_id
  JOIN stops os    ON os.id = t.origin_stop_id
  JOIN stops ds    ON ds.id = t.destination_stop_id
`;

export const GATE_LOG_VIEW_SELECT = `
  g.id, g.code, g.gate_id, g.shuttle_id, g.driver_id, g.guard_user_id,
  g.checked_in_at, g.checked_out_at, g.passenger_count, g.remark, g.was_edited,
  g.created_at, g.updated_at,
  sh.name         AS shuttle_name,
  sh.plate_no     AS shuttle_plate_no,
  dr.display_name AS driver_name,
  gu.display_name AS guard_name,
  ga.name         AS gate_name,
  CASE
    WHEN g.checked_out_at IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (g.checked_out_at - g.checked_in_at))::int
  END AS dwell_sec
`;

export const GATE_LOG_VIEW_FROM = `
  FROM gate_logs g
  JOIN gates ga    ON ga.id = g.gate_id
  JOIN shuttles sh ON sh.id = g.shuttle_id
  JOIN users gu    ON gu.id = g.guard_user_id
  LEFT JOIN drivers dr ON dr.id = g.driver_id
`;
