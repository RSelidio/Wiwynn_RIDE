-- RFID credentials and shuttle passenger in/out history.
BEGIN;

ALTER TABLE employees
  ADD COLUMN rfid_tag text;

CREATE UNIQUE INDEX employees_rfid_tag_key
  ON employees (lower(rfid_tag))
  WHERE rfid_tag IS NOT NULL;

CREATE TABLE shuttle_passenger_boardings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shuttle_id    uuid NOT NULL REFERENCES shuttles (id) ON DELETE RESTRICT,
  shift_id      uuid NOT NULL REFERENCES driver_shifts (id) ON DELETE RESTRICT,
  driver_id     uuid NOT NULL REFERENCES drivers (id) ON DELETE RESTRICT,
  employee_id   uuid NOT NULL REFERENCES employees (id) ON DELETE RESTRICT,
  rfid_tag      text NOT NULL,
  boarded_at    timestamptz NOT NULL DEFAULT now(),
  alighted_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT passenger_alight_after_board CHECK (alighted_at IS NULL OR alighted_at >= boarded_at)
);

-- A person may be on only one shuttle at a time.
CREATE UNIQUE INDEX shuttle_passenger_one_open_boarding
  ON shuttle_passenger_boardings (employee_id)
  WHERE alighted_at IS NULL;

CREATE INDEX shuttle_passenger_current_count
  ON shuttle_passenger_boardings (shuttle_id, shift_id)
  WHERE alighted_at IS NULL;

CREATE INDEX shuttle_passenger_history
  ON shuttle_passenger_boardings (employee_id, boarded_at DESC);

COMMIT;
