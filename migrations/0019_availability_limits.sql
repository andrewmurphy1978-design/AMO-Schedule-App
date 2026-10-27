-- Time off can cover part of a day (from/to time on every day of the range); empty = whole day.
ALTER TABLE time_off_requests ADD COLUMN start_time TEXT;
ALTER TABLE time_off_requests ADD COLUMN end_time TEXT;

-- Weekly recurring times when an employee cannot work (school schedule, other job...), optionally for a date range (a semester).
CREATE TABLE staff_availability (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  dow        INTEGER NOT NULL CHECK (dow BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL,
  note       TEXT,
  kind       TEXT NOT NULL DEFAULT 'unavailable' CHECK (kind IN ('unavailable', 'day_off')), -- day_off = fixed weekly day off (all day)
  replacement_ok INTEGER NOT NULL DEFAULT 0, -- on a fixed day off: still available to be asked as a replacement
  valid_from TEXT,
  valid_to   TEXT,
  CHECK (start_time < end_time)
);
CREATE INDEX idx_availability_staff ON staff_availability(staff_id);

-- Maximum hours per week for one employee (e.g. 17 h for under 16 during the school year). Enforced strictly for replacements.
CREATE TABLE staff_limits (
  staff_id         INTEGER PRIMARY KEY REFERENCES staff(id) ON DELETE CASCADE,
  max_weekly_hours REAL NOT NULL CHECK (max_weekly_hours > 0 AND max_weekly_hours <= 168)
);

-- Administration department (management and office work) with its own schedule.
INSERT INTO departments (id, name_fr, name_en) VALUES ('admin', 'Administration', 'Administration');
INSERT INTO roles (department_id, name_fr, name_en) VALUES
  ('admin', 'Gérant / gérante', 'Manager'),
  ('admin', 'Adjoint / adjointe', 'Assistant manager'),
  ('admin', 'Bureau / administration', 'Office');
