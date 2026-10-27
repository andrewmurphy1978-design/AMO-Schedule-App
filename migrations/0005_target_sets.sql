-- Seasons and special days that override the base staffing targets.
-- rule is JSON, validated by the API:
--   season : {"type":"range","from":"06-21","to":"09-22"}            (repeats every year; may wrap new year)
--   special: {"type":"fixed","md":"12-25","days":1}                   (same date every year)
--            {"type":"nth","month":5,"weekday":6,"n":2,"days":1}      (2nd Sunday of May; weekday 0=Mon..6=Sun; n=-1 is last)
--            {"type":"easter","from":-2,"to":1}                       (days relative to Easter Sunday)
--            {"type":"date","date":"2026-12-24"}                      (one-off)
CREATE TABLE target_sets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('season', 'special')),
  rule          TEXT NOT NULL
);

-- set_id 0 = the base targets; otherwise a target_sets.id.
CREATE TABLE staffing_targets_v2 (
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL REFERENCES departments(id),
  set_id        INTEGER NOT NULL DEFAULT 0,
  dow           INTEGER NOT NULL CHECK (dow BETWEEN -1 AND 6),
  slot          TEXT NOT NULL,
  count         INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (restaurant_id, department_id, set_id, dow, slot)
);
INSERT INTO staffing_targets_v2 (restaurant_id, department_id, set_id, dow, slot, count)
  SELECT restaurant_id, department_id, 0, dow, slot, count FROM staffing_targets;
DROP TABLE staffing_targets;
ALTER TABLE staffing_targets_v2 RENAME TO staffing_targets;
