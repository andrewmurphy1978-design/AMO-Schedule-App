-- Social Insurance Numbers are never stored in clear: only a keyed hash (to match pay slips) and the last 3 digits (to show).
CREATE TABLE staff_sin (
  staff_id INTEGER PRIMARY KEY REFERENCES staff(id) ON DELETE CASCADE,
  sin_hash TEXT NOT NULL,
  last3    TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_staff_sin_hash ON staff_sin(sin_hash);

-- Uploaded pay slips (PDF). status: 'review' = waiting for an admin to confirm the employee, 'assigned' = visible to that employee.
CREATE TABLE payslips (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id       INTEGER REFERENCES staff(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  content_b64    TEXT NOT NULL, -- PDF as base64 (D1 rows hold up to 2 MB)
  size           INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review', 'assigned')),
  period_label   TEXT,
  pay_date       TEXT,
  extracted_name TEXT,
  extracted_last3 TEXT,
  suggested_staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  match_kind     TEXT NOT NULL DEFAULT 'none' CHECK (match_kind IN ('sin', 'name', 'none')),
  uploaded_by    INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  uploaded_at    INTEGER NOT NULL,
  assigned_at    INTEGER
);
CREATE INDEX idx_payslips_staff ON payslips(staff_id, status);
