-- A schedule (restaurant + department + week) is a draft, seen only by administrators and the managers of that
-- department, until someone publishes it. A row here means "published".
CREATE TABLE schedule_publications (
  restaurant_id INTEGER NOT NULL,
  department_id TEXT NOT NULL,
  week_start    TEXT NOT NULL,            -- the Monday, YYYY-MM-DD
  published_at  INTEGER NOT NULL,
  published_by  INTEGER,
  PRIMARY KEY (restaurant_id, department_id, week_start)
);
-- Everything planned before this feature existed stays visible: mark every schedule that already has shifts as published.
INSERT OR IGNORE INTO schedule_publications (restaurant_id, department_id, week_start, published_at)
  SELECT DISTINCT sh.restaurant_id, ro.department_id,
         date(substr(sh.start_at, 1, 10), '-' || ((CAST(strftime('%w', substr(sh.start_at, 1, 10)) AS INTEGER) + 6) % 7) || ' days'),
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM shifts sh JOIN roles ro ON ro.id = sh.role_id;
