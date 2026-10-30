-- "Your shift starts soon" reminders: each employee chooses how long before a shift and by which channel (push, SMS, email).
CREATE TABLE shift_reminders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id       INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  minutes_before INTEGER NOT NULL CHECK (minutes_before BETWEEN 5 AND 2880),
  channel        TEXT NOT NULL DEFAULT 'push'
);
CREATE INDEX idx_shift_reminders_staff ON shift_reminders (staff_id);
-- One row per reminder actually sent for a shift, so it is never sent twice.
CREATE TABLE shift_reminder_log (
  reminder_id INTEGER NOT NULL,
  shift_id    INTEGER NOT NULL,
  sent_at     INTEGER NOT NULL,
  PRIMARY KEY (reminder_id, shift_id)
);
