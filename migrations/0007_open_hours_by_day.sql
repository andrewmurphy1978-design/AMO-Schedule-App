-- Opening time per weekday (0 = Monday ... 6 = Sunday). Days without a row use restaurants.open_time.
CREATE TABLE restaurant_open_hours (
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  dow           INTEGER NOT NULL CHECK (dow BETWEEN 0 AND 6),
  open_time     TEXT NOT NULL,
  PRIMARY KEY (restaurant_id, dow)
);
