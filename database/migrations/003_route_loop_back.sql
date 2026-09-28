-- Store whether a route explicitly closes back to its first stop.
-- Preserve the old convention: a non-null first-leg distance meant a loop.
BEGIN;

ALTER TABLE routes ADD COLUMN is_loop boolean NOT NULL DEFAULT false;

UPDATE routes r
SET is_loop = true
WHERE EXISTS (
  SELECT 1
  FROM route_stops rs
  WHERE rs.route_id = r.id
    AND rs.stop_order = 0
    AND rs.distance_from_prev_m IS NOT NULL
);

COMMIT;
