-- Delivery vehicles: tires (winter / summer, changed before the legal dates), problems reported by drivers, and the reminders sent.
CREATE TABLE vehicles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id    INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  plate            TEXT,
  notes            TEXT,
  tires            TEXT NOT NULL DEFAULT 'summer',   -- summer | winter: what is on the vehicle now
  tires_changed_on TEXT,                              -- YYYY-MM-DD
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_vehicles_restaurant ON vehicles (restaurant_id);
CREATE TABLE vehicle_tire_changes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  to_tires   TEXT NOT NULL,
  changed_on TEXT NOT NULL,
  staff_id   INTEGER,
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE vehicle_issues (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id      INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  staff_id        INTEGER NOT NULL,                  -- who reported it
  severity        TEXT NOT NULL,                     -- urgent (do not use the vehicle) | normal
  category        TEXT NOT NULL,
  description     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',      -- open | in_progress | resolved
  created_at      INTEGER NOT NULL,
  resolved_at     INTEGER,
  resolved_by     INTEGER,
  resolution_note TEXT
);
CREATE INDEX idx_vehicle_issues ON vehicle_issues (vehicle_id, status);
-- which tire reminders were already sent: one per company, season of the year and "days before" mark
CREATE TABLE vehicle_notices (
  client_id   INTEGER NOT NULL,
  season_key  TEXT NOT NULL,           -- e.g. fall-2026
  offset_days INTEGER NOT NULL,        -- days before the deadline (999 = the day the spring change opens)
  sent_at     INTEGER NOT NULL,
  PRIMARY KEY (client_id, season_key, offset_days)
);
