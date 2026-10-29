-- A permanent record of every absence an employee announces (or a manager reports for them), kept even if the shift is later
-- removed or given to somebody else. Incidents entered by a manager (no-show, late arrival...) stay in the `incidents` table.
CREATE TABLE staff_absences (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id      INTEGER NOT NULL,
  restaurant_id INTEGER NOT NULL,
  role_id       INTEGER,
  start_at      TEXT NOT NULL,            -- the shift that was missed
  end_at        TEXT NOT NULL,
  reason        TEXT,
  note          TEXT,
  declared_by   INTEGER,                  -- the employee themself, or the manager who reported it
  declared_at   INTEGER NOT NULL,
  request_id    INTEGER,                  -- the replacement search, while it still exists
  outcome       TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'filled' | 'cancelled' | 'shift_removed'
  replaced_by   INTEGER
);
CREATE INDEX idx_staff_absences_staff ON staff_absences(staff_id, start_at);
INSERT INTO staff_absences (staff_id, restaurant_id, role_id, start_at, end_at, reason, note, declared_by, declared_at, request_id, outcome, replaced_by)
  SELECT sick_staff_id, restaurant_id, role_id, start_at, end_at, reason, reason_note, created_by, created_at, id,
         CASE status WHEN 'filled' THEN 'filled' WHEN 'open' THEN 'open' ELSE 'cancelled' END, filled_by
  FROM coverage_requests;
