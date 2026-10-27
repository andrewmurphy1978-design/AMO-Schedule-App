-- Sick-call replacement, messaging log, settings and calendar feed tokens.

-- 'ok' = normal; 'sick_open' = the employee called in sick and a replacement is being looked for.
ALTER TABLE shifts ADD COLUMN status TEXT NOT NULL DEFAULT 'ok';
-- When a replacement takes over a sick employee's shift, this keeps who it was originally.
ALTER TABLE shifts ADD COLUMN replaced_staff_id INTEGER REFERENCES staff(id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Every SMS / email the app tries to send, so admins can see what happened.
CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  staff_id   INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  channel    TEXT NOT NULL,             -- 'sms' | 'email'
  to_addr    TEXT,
  subject    TEXT,
  body       TEXT NOT NULL,
  kind       TEXT NOT NULL,             -- 'sick_notice' | 'offer' | 'filled' | 'escalation' | 'test' ...
  status     TEXT NOT NULL,             -- 'sent' | 'failed' | 'skipped'
  error      TEXT
);
CREATE INDEX idx_notifications_created ON notifications(created_at DESC);

CREATE TABLE coverage_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id      INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  sick_staff_id INTEGER NOT NULL REFERENCES staff(id),
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'filled' | 'cancelled'
  created_by    INTEGER REFERENCES staff(id),
  created_at    INTEGER NOT NULL,
  escalated_at  INTEGER,                         -- set once the "take action" message went out
  filled_by     INTEGER REFERENCES staff(id),
  filled_at     INTEGER
);
CREATE INDEX idx_coverage_open ON coverage_requests(status, created_at);

CREATE TABLE coverage_offers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id   INTEGER NOT NULL REFERENCES coverage_requests(id) ON DELETE CASCADE,
  staff_id     INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  token        TEXT NOT NULL UNIQUE,
  channel      TEXT NOT NULL,
  sent_at      INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'sent',     -- 'sent' | 'accepted' | 'declined' | 'closed'
  responded_at INTEGER
);
CREATE INDEX idx_offers_staff ON coverage_offers(staff_id, status);

-- Secret per-employee token for the personal calendar feed (.ics) that Google Calendar / Apple / Outlook subscribe to.
CREATE TABLE calendar_tokens (
  staff_id   INTEGER PRIMARY KEY REFERENCES staff(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
