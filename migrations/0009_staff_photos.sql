-- One small profile picture per employee (resized to ~256px by the browser before upload), stored as base64.
CREATE TABLE staff_photos (
  staff_id   INTEGER PRIMARY KEY REFERENCES staff(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
