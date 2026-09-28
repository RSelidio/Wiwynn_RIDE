-- Distinguish RFID check-outs from a driver clearing the onboard roster.
BEGIN;

ALTER TABLE shuttle_passenger_boardings
  ADD COLUMN alight_method text NOT NULL DEFAULT 'rfid'
  CHECK (alight_method IN ('rfid', 'manual_clear'));

COMMIT;
