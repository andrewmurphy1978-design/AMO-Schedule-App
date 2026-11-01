-- Assisted phone calls: the owner types, the other person hears it read aloud and answers out loud; the answer comes back as text.
ALTER TABLE staff ADD COLUMN voice_assist INTEGER NOT NULL DEFAULT 0;
CREATE TABLE voice_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   INTEGER NOT NULL,
  caller_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  to_staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  to_name     TEXT NOT NULL,
  to_phone    TEXT NOT NULL,
  lang        TEXT NOT NULL DEFAULT 'fr',
  call_sid    TEXT,
  status      TEXT NOT NULL DEFAULT 'queued',   -- queued | in_progress | ending | completed | failed | no_answer | busy
  created_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX idx_voice_calls ON voice_calls (caller_id, id);
CREATE TABLE voice_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id    INTEGER NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL,                      -- out = typed and read aloud | in = heard and written | sys = what happened
  text       TEXT NOT NULL,
  delivered  INTEGER NOT NULL DEFAULT 0,         -- out: already spoken on the line
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_voice_messages ON voice_messages (call_id, id);
