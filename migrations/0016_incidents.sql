-- Attendance incidents recorded by admins only: no call / no show, late arrival, early departure not granted.
CREATE TABLE incidents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id      INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  shift_id      INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE SET NULL,
  incident_date TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('no_call_no_show', 'late_arrival', 'early_departure')),
  minutes       INTEGER CHECK (minutes IS NULL OR (minutes >= 1 AND minutes <= 1440)),
  notes         TEXT,
  recorded_by   INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_incidents_staff ON incidents(staff_id, incident_date);
