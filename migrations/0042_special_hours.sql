-- Closed days (Christmas…) and special opening hours (Christmas Eve closes at 17:00, New Year's Day opens at 10:00) per restaurant.
-- yearly = 1: the same month-day every year (the year of "date" is only the first occurrence).
CREATE TABLE restaurant_special_hours (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  yearly        INTEGER NOT NULL DEFAULT 0,
  closed        INTEGER NOT NULL DEFAULT 0,
  open_time     TEXT,
  close_time    TEXT,
  note          TEXT,
  UNIQUE (restaurant_id, date)
);
