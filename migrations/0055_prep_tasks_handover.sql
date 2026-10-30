-- Prep tasks a manager assigns to someone on a shift (e.g. "cut the onions for the evening"), due at a given time.
CREATE TABLE shift_prep_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id    INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  text_fr     TEXT NOT NULL,
  due_at      TEXT,                     -- local time "YYYY-MM-DDTHH:MM"; null = end of the shift
  assigned_by INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  done_by     INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  done_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_prep_tasks_shift ON shift_prep_tasks (shift_id);
-- One "ends soon" reminder per list due time of a shift (a post handed over at 17:00 has its own due time, before the shift ends).
CREATE TABLE shift_reminder_log_new (
  reminder_id INTEGER NOT NULL,
  shift_id    INTEGER NOT NULL,
  slot        TEXT NOT NULL DEFAULT '',
  sent_at     INTEGER NOT NULL,
  PRIMARY KEY (reminder_id, shift_id, slot)
);
INSERT INTO shift_reminder_log_new (reminder_id, shift_id, slot, sent_at) SELECT reminder_id, shift_id, '', sent_at FROM shift_reminder_log;
DROP TABLE shift_reminder_log;
ALTER TABLE shift_reminder_log_new RENAME TO shift_reminder_log;
