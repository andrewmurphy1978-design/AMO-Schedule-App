-- Personal messages between employees: a conversation of two people (direct) or of several (group), inside the Communities screen.
-- Only the members can read a conversation: administrators cannot, and API tokens never can.
CREATE TABLE dm_threads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id       INTEGER NOT NULL,
  title           TEXT,                 -- optional name of a group
  is_group        INTEGER NOT NULL DEFAULT 0,
  created_by      INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL
);
CREATE TABLE dm_members (
  thread_id    INTEGER NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  staff_id     INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  left_at      INTEGER,
  PRIMARY KEY (thread_id, staff_id)
);
CREATE INDEX idx_dm_members_staff ON dm_members (staff_id);
CREATE TABLE dm_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  INTEGER NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  staff_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_dm_messages ON dm_messages (thread_id, id);
