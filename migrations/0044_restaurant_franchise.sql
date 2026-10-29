-- Franchise of each restaurant (name and small logo): an owner can have restaurants of several franchises.
CREATE TABLE restaurant_franchise (
  restaurant_id INTEGER PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  name          TEXT,
  logo          TEXT,           -- base64
  logo_type     TEXT,
  logo_v        INTEGER NOT NULL DEFAULT 0
);
