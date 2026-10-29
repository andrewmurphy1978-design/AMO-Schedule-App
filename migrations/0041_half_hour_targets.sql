-- Staffing targets now use fixed 30-minute intervals: one row per interval, keyed by its start ("08:00", "08:30"...).
-- Each old period (open / HH:MM, ending at the next boundary of its restaurant) is spread over the intervals it covered.
CREATE TABLE staffing_targets_v3 (
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL REFERENCES departments(id),
  set_id        INTEGER NOT NULL DEFAULT 0,
  dow           INTEGER NOT NULL CHECK (dow BETWEEN -1 AND 6),
  slot          TEXT NOT NULL,
  count         INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (restaurant_id, department_id, set_id, dow, slot)
);
INSERT OR IGNORE INTO staffing_targets_v3 (restaurant_id, department_id, set_id, dow, slot, count)
WITH RECURSIVE grid(m) AS (SELECT 0 UNION ALL SELECT m + 30 FROM grid WHERE m < 1410),
t AS (
  SELECT restaurant_id, department_id, set_id, dow, count,
         CASE WHEN slot = 'open' THEN 0 ELSE CAST(substr(slot, 1, 2) AS INTEGER) * 60 + CAST(substr(slot, 4, 2) AS INTEGER) END AS ps
  FROM staffing_targets WHERE slot = 'open' OR slot GLOB '[0-2][0-9]:[0-5][0-9]'
),
bm AS (
  SELECT r.id AS rid, CAST(substr(j.value, 1, 2) AS INTEGER) * 60 + CAST(substr(j.value, 4, 2) AS INTEGER) AS b
  FROM restaurants r LEFT JOIN restaurant_periods rp ON rp.restaurant_id = r.id,
       json_each(coalesce(rp.boundaries, '["08:00","09:00","11:00","12:00","14:00","17:00","20:00"]')) j
)
SELECT t.restaurant_id, t.department_id, t.set_id, t.dow, printf('%02d:%02d', g.m / 60, g.m % 60), t.count
FROM t JOIN grid g ON g.m >= t.ps AND g.m < coalesce((SELECT min(b) FROM bm WHERE bm.rid = t.restaurant_id AND bm.b > t.ps), 1440);
DROP TABLE staffing_targets;
ALTER TABLE staffing_targets_v3 RENAME TO staffing_targets;
