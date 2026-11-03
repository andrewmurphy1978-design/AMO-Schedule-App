-- Automatic creation of next week's schedules (night of Wednesday to Thursday by default): one row per client and week.
CREATE TABLE auto_schedule_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   INTEGER NOT NULL,
  week        TEXT NOT NULL,        -- the Monday that was planned, YYYY-MM-DD
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL,        -- running | done | partial | failed
  summary     TEXT,                 -- JSON: { results: [...], error }
  notify_at   TEXT,                 -- local 'YYYY-MM-DDTHH:MM'; NULL = nobody is told (manual run)
  notified_at INTEGER,
  run_date    TEXT,                 -- local date the schedules were made, to count the days for the reminders
  reminders_sent TEXT NOT NULL DEFAULT '[]', -- JSON: the day numbers (1 = one day after) already reminded
  UNIQUE (client_id, week)
);
