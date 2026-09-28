-- ============================================================================
-- Company Shuttle — initial schema
--
-- Target: PostgreSQL 14 or newer (gen_random_uuid() is core from 13).
-- Run with: npm run db:migrate
--
-- Conventions
--   * snake_case everywhere; the backend maps rows to camelCase DTOs in one
--     place (src/db/rows.ts) so no route does its own renaming.
--   * Every mutable table carries created_at / updated_at, maintained by the
--     touch_updated_at() trigger rather than by application code.
--   * Human-facing identifiers (REQ-1042, TRP-0447, LOG-0215) come from
--     sequences, so two concurrent inserts can never collide on one.
-- ============================================================================

BEGIN;

-- ── Helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE SEQUENCE IF NOT EXISTS request_code_seq  START 1001;
CREATE SEQUENCE IF NOT EXISTS trip_code_seq     START 401;
CREATE SEQUENCE IF NOT EXISTS gate_log_code_seq START 201;

-- ── Identity and access control (spec §12) ─────────────────────────────────

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  -- Null for SSO-only accounts: there is no local password to verify.
  password_hash text,
  display_name  text NOT NULL,
  -- 'guard' is the gate-tablet role: stamp shuttles in/out, nothing else.
  role          text NOT NULL CHECK (role IN ('employee', 'driver', 'admin', 'guard')),
  provider      text NOT NULL DEFAULT 'local' CHECK (provider IN ('local', 'entra')),
  -- Entra object id once SSO is enabled.
  external_id   text,
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- A local account must have a password; an SSO account must have an external id.
  CONSTRAINT users_credentials_present CHECK (
    (provider = 'local' AND password_hash IS NOT NULL)
    OR (provider = 'entra' AND external_id IS NOT NULL)
  )
);

-- Email is unique case-insensitively: Wei.Chen@ and wei.chen@ are one person.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE UNIQUE INDEX users_external_id_key ON users (provider, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX users_role_idx ON users (role) WHERE is_active;

CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Refresh tokens are stored hashed, so a database leak cannot be replayed
-- as a live session.
CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id)
  WHERE revoked_at IS NULL;

-- ── Stops (spec §4) ────────────────────────────────────────────────────────

CREATE TABLE stops (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  description   text,
  latitude      double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude     double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  kind          text NOT NULL DEFAULT 'both' CHECK (kind IN ('pickup', 'dropoff', 'both')),
  -- Null falls back to the system-wide STOP_GEOFENCE_M setting.
  geofence_m    integer CHECK (geofence_m IS NULL OR geofence_m BETWEEN 5 AND 1000),
  is_active     boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stops_active_order_idx ON stops (display_order) WHERE is_active;

CREATE TRIGGER stops_touch BEFORE UPDATE ON stops
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── People ─────────────────────────────────────────────────────────────────

CREATE TABLE employees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  badge_no        text NOT NULL UNIQUE,
  display_name    text NOT NULL,
  department      text,
  -- Pre-selects the pickup stop in the PWA; ON DELETE SET NULL so retiring a
  -- stop does not delete employees.
  default_stop_id uuid REFERENCES stops (id) ON DELETE SET NULL,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX employees_department_idx ON employees (department) WHERE is_active;

CREATE TRIGGER employees_touch BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE drivers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  driver_no    text NOT NULL UNIQUE,
  display_name text NOT NULL,
  license_no   text,
  phone        text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER drivers_touch BEFORE UPDATE ON drivers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── Fleet ──────────────────────────────────────────────────────────────────

CREATE TABLE shuttles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  plate_no   text NOT NULL UNIQUE,
  model      text,
  capacity   integer NOT NULL DEFAULT 12 CHECK (capacity > 0 AND capacity <= 200),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER shuttles_touch BEFORE UPDATE ON shuttles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── Routes (spec §5) ───────────────────────────────────────────────────────

CREATE TABLE routes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER routes_touch BEFORE UPDATE ON routes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE route_stops (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id             uuid NOT NULL REFERENCES routes (id) ON DELETE CASCADE,
  stop_id              uuid NOT NULL REFERENCES stops (id) ON DELETE RESTRICT,
  stop_order           integer NOT NULL CHECK (stop_order >= 0),
  distance_from_prev_m integer CHECK (distance_from_prev_m IS NULL OR distance_from_prev_m >= 0),
  typical_travel_sec   integer CHECK (typical_travel_sec IS NULL OR typical_travel_sec >= 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- Two stops cannot share a position in the same route.
  CONSTRAINT route_stops_order_key UNIQUE (route_id, stop_order)
);

CREATE INDEX route_stops_route_idx ON route_stops (route_id, stop_order);
CREATE INDEX route_stops_stop_idx ON route_stops (stop_id);

CREATE TRIGGER route_stops_touch BEFORE UPDATE ON route_stops
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Observed travel times, folded in by the ETA engine (spec §6). One row per
-- ordered stop pair; the engine blends mean_travel_sec with the configured time.
CREATE TABLE route_segment_stats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id        uuid NOT NULL REFERENCES routes (id) ON DELETE CASCADE,
  from_stop_id    uuid NOT NULL REFERENCES stops (id) ON DELETE CASCADE,
  to_stop_id      uuid NOT NULL REFERENCES stops (id) ON DELETE CASCADE,
  sample_count    integer NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  mean_travel_sec double precision,
  -- Kept alongside the mean so an outlier can be judged without re-reading trips.
  stddev_sec      double precision,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT route_segment_stats_key UNIQUE (route_id, from_stop_id, to_stop_id)
);

-- ── Shifts ─────────────────────────────────────────────────────────────────

CREATE TABLE driver_shifts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id  uuid NOT NULL REFERENCES drivers (id) ON DELETE RESTRICT,
  shuttle_id uuid NOT NULL REFERENCES shuttles (id) ON DELETE RESTRICT,
  route_id   uuid REFERENCES routes (id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz,
  is_online  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT driver_shifts_ends_after_start CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- A driver may hold only one open shift, and a shuttle may be driven by only
-- one person at a time. Enforced in the database so a double-tapped
-- "Start shift" cannot create two.
CREATE UNIQUE INDEX driver_shifts_one_open_per_driver
  ON driver_shifts (driver_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX driver_shifts_one_open_per_shuttle
  ON driver_shifts (shuttle_id) WHERE ended_at IS NULL;
CREATE INDEX driver_shifts_started_idx ON driver_shifts (started_at DESC);

CREATE TRIGGER driver_shifts_touch BEFORE UPDATE ON driver_shifts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── GPS history (spec §3) ──────────────────────────────────────────────────

-- The latest fix per shuttle lives in backend memory and is broadcast at the
-- device's push cadence. This table receives a sample only every
-- GPS_HISTORY_PERSIST_SEC, so a 5-second push does not become a 5-second write.
CREATE TABLE shuttle_locations (
  id          bigserial PRIMARY KEY,
  shuttle_id  uuid NOT NULL REFERENCES shuttles (id) ON DELETE CASCADE,
  driver_id   uuid REFERENCES drivers (id) ON DELETE SET NULL,
  shift_id    uuid REFERENCES driver_shifts (id) ON DELETE SET NULL,
  latitude    double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude   double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  speed_kmh   double precision CHECK (speed_kmh IS NULL OR speed_kmh >= 0),
  heading_deg double precision CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg < 360)),
  accuracy_m  double precision CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  recorded_at timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Supports "the track of shuttle X over window W", the only read shape used.
CREATE INDEX shuttle_locations_shuttle_time_idx
  ON shuttle_locations (shuttle_id, recorded_at DESC);
CREATE INDEX shuttle_locations_shift_idx ON shuttle_locations (shift_id)
  WHERE shift_id IS NOT NULL;

-- ── Trips (spec §18) ───────────────────────────────────────────────────────

CREATE TABLE trips (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL UNIQUE
                        DEFAULT ('TRP-' || lpad(nextval('trip_code_seq')::text, 4, '0')),
  shuttle_id          uuid NOT NULL REFERENCES shuttles (id) ON DELETE RESTRICT,
  driver_id           uuid NOT NULL REFERENCES drivers (id) ON DELETE RESTRICT,
  shift_id            uuid REFERENCES driver_shifts (id) ON DELETE SET NULL,
  route_id            uuid REFERENCES routes (id) ON DELETE SET NULL,
  origin_stop_id      uuid NOT NULL REFERENCES stops (id) ON DELETE RESTRICT,
  destination_stop_id uuid NOT NULL REFERENCES stops (id) ON DELETE RESTRICT,
  status              text NOT NULL DEFAULT 'in_progress'
                        CHECK (status IN ('in_progress', 'completed', 'cancelled')),
  passenger_count     integer NOT NULL DEFAULT 0 CHECK (passenger_count >= 0),
  departed_at         timestamptz NOT NULL DEFAULT now(),
  arrived_at          timestamptz,
  distance_m          integer CHECK (distance_m IS NULL OR distance_m >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trips_arrives_after_departure CHECK (arrived_at IS NULL OR arrived_at >= departed_at),
  -- A closed trip must have an arrival time; an open one must not.
  CONSTRAINT trips_arrival_matches_status CHECK (
    (status = 'in_progress' AND arrived_at IS NULL)
    OR (status <> 'in_progress')
  )
);

CREATE INDEX trips_departed_idx ON trips (departed_at DESC);
CREATE INDEX trips_shuttle_idx ON trips (shuttle_id, departed_at DESC);
CREATE INDEX trips_driver_idx ON trips (driver_id, departed_at DESC);
CREATE INDEX trips_open_idx ON trips (shuttle_id) WHERE status = 'in_progress';

CREATE TRIGGER trips_touch BEFORE UPDATE ON trips
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── Pickup requests (spec §18) ─────────────────────────────────────────────

CREATE TABLE pickup_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL UNIQUE
                        DEFAULT ('REQ-' || lpad(nextval('request_code_seq')::text, 4, '0')),
  employee_id         uuid NOT NULL REFERENCES employees (id) ON DELETE RESTRICT,
  pickup_stop_id      uuid NOT NULL REFERENCES stops (id) ON DELETE RESTRICT,
  destination_stop_id uuid NOT NULL REFERENCES stops (id) ON DELETE RESTRICT,
  passenger_count     integer NOT NULL DEFAULT 1 CHECK (passenger_count BETWEEN 1 AND 50),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN (
                        'pending', 'accepted', 'arrived', 'boarding',
                        'completed', 'cancelled', 'rejected', 'expired')),
  shuttle_id          uuid REFERENCES shuttles (id) ON DELETE SET NULL,
  driver_id           uuid REFERENCES drivers (id) ON DELETE SET NULL,
  trip_id             uuid REFERENCES trips (id) ON DELETE SET NULL,
  source              text NOT NULL DEFAULT 'pwa' CHECK (source IN ('pwa', 'kiosk', 'admin')),
  note                text,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  accepted_at         timestamptz,
  arrived_at          timestamptz,
  boarded_at          timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  cancel_reason       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- A pickup that starts and ends at the same place is a data-entry mistake.
  CONSTRAINT pickup_requests_distinct_stops CHECK (pickup_stop_id <> destination_stop_id),
  -- Anything past 'pending' must name the shuttle that took it.
  CONSTRAINT pickup_requests_assigned_when_active CHECK (
    status NOT IN ('accepted', 'arrived', 'boarding', 'completed')
    OR shuttle_id IS NOT NULL
  )
);

CREATE INDEX pickup_requests_status_idx ON pickup_requests (status, requested_at DESC);
CREATE INDEX pickup_requests_employee_idx ON pickup_requests (employee_id, requested_at DESC);
CREATE INDEX pickup_requests_shuttle_idx ON pickup_requests (shuttle_id, requested_at DESC)
  WHERE shuttle_id IS NOT NULL;
CREATE INDEX pickup_requests_pickup_stop_idx ON pickup_requests (pickup_stop_id)
  WHERE status IN ('pending', 'accepted', 'arrived', 'boarding');
-- Dispatch reads "everything still open" constantly; keep it a tiny index scan.
CREATE INDEX pickup_requests_open_idx ON pickup_requests (requested_at DESC)
  WHERE status IN ('pending', 'accepted', 'arrived', 'boarding');
CREATE INDEX pickup_requests_trip_idx ON pickup_requests (trip_id) WHERE trip_id IS NOT NULL;

CREATE TRIGGER pickup_requests_touch BEFORE UPDATE ON pickup_requests
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- One employee should not hold two live requests at once — the second would
-- race the first for a seat.
CREATE UNIQUE INDEX pickup_requests_one_open_per_employee
  ON pickup_requests (employee_id)
  WHERE status IN ('pending', 'accepted', 'arrived', 'boarding');

CREATE TABLE trip_passengers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     uuid NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees (id) ON DELETE RESTRICT,
  request_id  uuid REFERENCES pickup_requests (id) ON DELETE SET NULL,
  boarded_at  timestamptz NOT NULL DEFAULT now(),
  dropped_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trip_passengers_key UNIQUE (trip_id, employee_id)
);

CREATE INDEX trip_passengers_employee_idx ON trip_passengers (employee_id, boarded_at DESC);

-- ── Gate log (design doc §4a) ──────────────────────────────────────────────

CREATE TABLE gates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  stop_id    uuid REFERENCES stops (id) ON DELETE SET NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER gates_touch BEFORE UPDATE ON gates
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE gate_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE
                    DEFAULT ('LOG-' || lpad(nextval('gate_log_code_seq')::text, 4, '0')),
  gate_id         uuid NOT NULL REFERENCES gates (id) ON DELETE RESTRICT,
  shuttle_id      uuid NOT NULL REFERENCES shuttles (id) ON DELETE RESTRICT,
  driver_id       uuid REFERENCES drivers (id) ON DELETE SET NULL,
  -- The guard who stamped it; kept for accountability, hence RESTRICT.
  guard_user_id   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  checked_in_at   timestamptz NOT NULL DEFAULT now(),
  checked_out_at  timestamptz,
  passenger_count integer NOT NULL DEFAULT 0 CHECK (passenger_count >= 0),
  remark          text CHECK (remark IS NULL OR length(remark) <= 120),
  was_edited      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT gate_logs_out_after_in CHECK (checked_out_at IS NULL OR checked_out_at >= checked_in_at)
);

CREATE INDEX gate_logs_gate_time_idx ON gate_logs (gate_id, checked_in_at DESC);
CREATE INDEX gate_logs_shuttle_idx ON gate_logs (shuttle_id, checked_in_at DESC);
-- "Which shuttles are standing at the gate right now."
CREATE INDEX gate_logs_open_idx ON gate_logs (gate_id) WHERE checked_out_at IS NULL;

-- A shuttle cannot be checked in twice at the same gate without leaving.
CREATE UNIQUE INDEX gate_logs_one_open_per_shuttle_gate
  ON gate_logs (gate_id, shuttle_id) WHERE checked_out_at IS NULL;

CREATE TRIGGER gate_logs_touch BEFORE UPDATE ON gate_logs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── Notifications ──────────────────────────────────────────────────────────

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN (
               'request_accepted', 'request_rejected', 'shuttle_approaching',
               'shuttle_arrived', 'trip_completed', 'request_cancelled',
               'shift_reminder', 'system')),
  title      text NOT NULL,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- ── Audit log ──────────────────────────────────────────────────────────────

CREATE TABLE audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Null for system actions such as request expiry or auto-assign.
  actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  changes       jsonb,
  ip_address    text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

-- ── System settings ────────────────────────────────────────────────────────

-- Single-row table: the CHECK on a constant primary key makes a second row
-- impossible, so no code has to guess which row is "the" settings row.
CREATE TABLE system_settings (
  id                     boolean PRIMARY KEY DEFAULT true CHECK (id),
  auto_assign            boolean NOT NULL DEFAULT false,
  require_gate_log       boolean NOT NULL DEFAULT true,
  push_eta_enabled       boolean NOT NULL DEFAULT true,
  night_service          boolean NOT NULL DEFAULT false,
  gps_gap_alert_sec      integer NOT NULL DEFAULT 30 CHECK (gps_gap_alert_sec BETWEEN 5 AND 600),
  long_wait_alert_min    integer NOT NULL DEFAULT 10 CHECK (long_wait_alert_min BETWEEN 1 AND 120),
  stop_geofence_m        integer NOT NULL DEFAULT 50 CHECK (stop_geofence_m BETWEEN 5 AND 1000),
  request_expiry_min     integer NOT NULL DEFAULT 20 CHECK (request_expiry_min BETWEEN 1 AND 240),
  approaching_notice_min integer NOT NULL DEFAULT 2 CHECK (approaching_notice_min BETWEEN 1 AND 30),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

INSERT INTO system_settings (id) VALUES (true) ON CONFLICT DO NOTHING;

COMMIT;
