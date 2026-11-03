-- Stock taking: a count of the ingredients of a restaurant (one open count at a time, shared by whoever counts), kept as history.
CREATE TABLE inventory_counts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  started_by    INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  completed_by  INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  note          TEXT
);
CREATE INDEX idx_inventory_counts ON inventory_counts (restaurant_id, completed_at);
CREATE TABLE inventory_lines (
  count_id INTEGER NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,        -- lower-case ingredient name
  name     TEXT NOT NULL,
  location TEXT,
  category TEXT,
  qty      REAL NOT NULL,
  unit     TEXT,
  PRIMARY KEY (count_id, key)
);
