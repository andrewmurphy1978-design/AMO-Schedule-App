-- Time-off requests (congé demandé). Shown as C/D while requested and C/A once approved.
CREATE TABLE time_off_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id      INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'denied', 'cancelled')),
  created_at    INTEGER NOT NULL,
  decided_by    INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  decided_at    INTEGER,
  decision_note TEXT,
  CHECK (start_date <= end_date)
);
CREATE INDEX idx_time_off_staff ON time_off_requests(staff_id, start_date);
