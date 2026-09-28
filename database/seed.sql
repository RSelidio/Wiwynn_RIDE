-- ============================================================================
-- FICTIONAL DEVELOPMENT FIXTURES ONLY. Never use as production or campus data.
--
-- Idempotent: every row carries a fixed UUID and an ON CONFLICT clause, so this
-- file can be re-run after a schema change without duplicating anything.
--
-- User accounts are NOT here — passwords must be bcrypt-hashed, which is done
-- by apps/backend/src/db/seed.ts. That script runs this file first.
--
-- This file refuses to run unless the caller explicitly sets the transaction-
-- local app.allow_demo_seed setting. The coordinates below are Hsinchu sample
-- data, not verified company stops; the ETA engine will treat them as real.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF current_setting('app.allow_demo_seed', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Refusing fictional reference seed; use the development-only opt-in';
  END IF;
END
$$;

-- ── Stops (spec §4) ────────────────────────────────────────────────────────

INSERT INTO stops (id, code, name, description, latitude, longitude, kind, geofence_m, display_order) VALUES
  ('11111111-1111-4111-8111-000000000001', 'LOT-A',     'Parking Lot A', 'Main employee car park, west side',      24.78200, 121.00800, 'both',    50, 10),
  ('11111111-1111-4111-8111-000000000002', 'MAIN-GATE', 'Main Gate',     'Site entrance, visitor check-in',        24.78390, 121.00800, 'both',    50, 20),
  ('11111111-1111-4111-8111-000000000003', 'WAREHOUSE', 'Warehouse',     'Goods-in dock, east yard',               24.78390, 121.01450, 'both',    50, 30),
  ('11111111-1111-4111-8111-000000000004', 'MB-G1',     'Main Building', 'Main Building gate 1 — guard gate log',   24.78720, 121.01450, 'dropoff', 50, 40),
  ('11111111-1111-4111-8111-000000000005', 'LOT-B',     'Parking Lot B', 'Overflow car park, north side',          24.78720, 121.00950, 'both',    50, 50),
  ('11111111-1111-4111-8111-000000000006', 'BLDG-A',    'Building A',    'Engineering block A, lobby entrance',    24.78560, 121.00880, 'both',    50, 60),
  ('11111111-1111-4111-8111-000000000007', 'CAFETERIA', 'Cafeteria',     'Staff canteen, south entrance',          24.78380, 121.00880, 'both',    50, 70),
  ('11111111-1111-4111-8111-000000000008', 'BLDG-B',    'Building B',    'Engineering block B — not on the loop',  24.78800, 121.01100, 'both',    50, 80)
ON CONFLICT (id) DO UPDATE SET
  code = EXCLUDED.code, name = EXCLUDED.name, description = EXCLUDED.description,
  latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, kind = EXCLUDED.kind,
  geofence_m = EXCLUDED.geofence_m, display_order = EXCLUDED.display_order;

-- ── Route: Campus Loop (spec §5) ───────────────────────────────────────────

INSERT INTO routes (id, code, name, description, is_loop) VALUES
  ('66666666-6666-4666-8666-000000000001', 'CAMPUS-LOOP', 'Campus Loop',
   'Continuous clockwise loop serving all pickup stops and the Main Building drop-off.', true)
ON CONFLICT (id) DO UPDATE SET
  code = EXCLUDED.code, name = EXCLUDED.name, description = EXCLUDED.description,
  is_loop = EXCLUDED.is_loop;

-- Ordered legs. `distance_from_prev_m` / `typical_travel_sec` describe the leg
-- arriving AT this stop from the previous one in the sequence.
--
-- Because this route is a loop, stop_order 0 describes the *closing* leg
-- (Cafeteria → Parking Lot A) rather than being null. The ETA engine reads it
-- that way when it wraps past the last stop.
INSERT INTO route_stops (id, route_id, stop_id, stop_order, distance_from_prev_m, typical_travel_sec) VALUES
  ('66666666-6666-4666-8666-0000000000a0', '66666666-6666-4666-8666-000000000001', '11111111-1111-4111-8111-000000000001', 0, 216,  45),
  ('66666666-6666-4666-8666-0000000000a1', '66666666-6666-4666-8666-000000000001', '11111111-1111-4111-8111-000000000002', 1, 211,  45),
  ('66666666-6666-4666-8666-0000000000a2', '66666666-6666-4666-8666-000000000001', '11111111-1111-4111-8111-000000000003', 2, 659, 125),
  ('66666666-6666-4666-8666-0000000000a3', '66666666-6666-4666-8666-000000000001', '11111111-1111-4111-8111-000000000004', 3, 367,  75),
  ('66666666-6666-4666-8666-0000000000a4', '66666666-6666-4666-8666-000000000001', '11111111-1111-4111-8111-000000000005', 4, 507, 100),
  ('66666666-6666-4666-8666-0000000000a5', '66666666-6666-4666-8666-000000000001', '11111111-1111-4111-8111-000000000006', 5, 192,  45),
  ('66666666-6666-4666-8666-0000000000a6', '66666666-6666-4666-8666-000000000001', '11111111-1111-4111-8111-000000000007', 6, 200,  45)
ON CONFLICT (id) DO UPDATE SET
  stop_id = EXCLUDED.stop_id, stop_order = EXCLUDED.stop_order,
  distance_from_prev_m = EXCLUDED.distance_from_prev_m,
  typical_travel_sec = EXCLUDED.typical_travel_sec;

-- ── Fleet ──────────────────────────────────────────────────────────────────

INSERT INTO shuttles (id, code, name, plate_no, model, capacity) VALUES
  ('22222222-2222-4222-8222-000000000001', 'SH-01', 'Shuttle 1', 'RDA-5821', 'Toyota Hiace', 12),
  ('22222222-2222-4222-8222-000000000002', 'SH-02', 'Shuttle 2', 'RDA-5822', 'Toyota Hiace', 12),
  ('22222222-2222-4222-8222-000000000003', 'SH-03', 'Shuttle 3', 'RDA-5823', 'Toyota Hiace', 12)
ON CONFLICT (id) DO UPDATE SET
  code = EXCLUDED.code, name = EXCLUDED.name, plate_no = EXCLUDED.plate_no,
  model = EXCLUDED.model, capacity = EXCLUDED.capacity;

-- Shuttle 3 is on the books but out of service, so the fleet list has something
-- inactive in it and the UI's "active / total" counts are not trivially equal.
UPDATE shuttles SET is_active = false WHERE id = '22222222-2222-4222-8222-000000000003';

-- ── Gate (design doc §4a) ──────────────────────────────────────────────────

INSERT INTO gates (id, code, name, stop_id) VALUES
  ('77777777-7777-4777-8777-000000000001', 'MB-GATE-1', 'Main Building · Gate 1',
   '11111111-1111-4111-8111-000000000004')
ON CONFLICT (id) DO UPDATE SET
  code = EXCLUDED.code, name = EXCLUDED.name, stop_id = EXCLUDED.stop_id;

-- ── Settings ───────────────────────────────────────────────────────────────

INSERT INTO system_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

COMMIT;
