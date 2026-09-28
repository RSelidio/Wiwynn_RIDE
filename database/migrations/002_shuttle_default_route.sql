-- Remember an admin-configured default route for each shuttle.
-- Drivers may still choose a different route when starting their shift.
BEGIN;

ALTER TABLE shuttles
  ADD COLUMN default_route_id uuid NULL REFERENCES routes(id) ON DELETE SET NULL;

CREATE INDEX shuttles_default_route_id_idx ON shuttles(default_route_id)
  WHERE default_route_id IS NOT NULL;

COMMIT;
