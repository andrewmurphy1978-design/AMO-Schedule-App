-- A shift can have different roles at different hours (Prep 10:30-11, Delivery + Dish 11-14, Cook 14-19:30).
-- One row per role per time range; parts of the shift not covered by a range keep the shift's own role(s).
CREATE TABLE shift_segments (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  start_at TEXT NOT NULL,
  end_at   TEXT NOT NULL,
  role_id  INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  no_count INTEGER NOT NULL DEFAULT 0,
  CHECK (start_at < end_at)
);
CREATE INDEX idx_segments_shift ON shift_segments(shift_id);
