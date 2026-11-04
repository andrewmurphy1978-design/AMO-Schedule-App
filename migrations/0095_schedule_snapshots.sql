-- A published schedule is kept as it was published (a snapshot of its shifts); changes made afterwards are found by comparing with the shifts now.
CREATE TABLE schedule_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL,
  department_id TEXT NOT NULL,
  week_start    TEXT NOT NULL,
  published_at  INTEGER NOT NULL,
  published_by  INTEGER,
  shifts        TEXT NOT NULL
);
CREATE INDEX idx_schedule_snapshots ON schedule_snapshots (restaurant_id, department_id, week_start, published_at);
INSERT INTO schedule_snapshots (restaurant_id, department_id, week_start, published_at, published_by, shifts)
SELECT p.restaurant_id, p.department_id, p.week_start, p.published_at, p.published_by,
  COALESCE((SELECT json_group_array(json_object('staff_id', sh.staff_id, 'role_id', sh.role_id, 'start_at', sh.start_at, 'end_at', sh.end_at, 'notes', sh.notes,
      'extra_role_ids', json(COALESCE((SELECT json_group_array(sr.role_id) FROM shift_roles sr WHERE sr.shift_id = sh.id), '[]'))))
    FROM shifts sh JOIN roles ro ON ro.id = sh.role_id
    WHERE sh.restaurant_id = p.restaurant_id AND ro.department_id = p.department_id AND sh.status = 'ok' AND sh.start_at >= p.week_start AND sh.start_at < date(p.week_start, '+7 days')), '[]')
FROM schedule_publications p;
