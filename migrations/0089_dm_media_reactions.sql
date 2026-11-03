-- Personal messages like Messenger: photos, videos and voice messages, reactions, and replies to a message.
ALTER TABLE dm_messages ADD COLUMN reply_to INTEGER;
CREATE TABLE dm_reactions (
  message_id INTEGER NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
  staff_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  PRIMARY KEY (message_id, staff_id, emoji)
);
-- Files are kept in D1 in chunks (message_id stays NULL until the message is sent), only readable by the members of the conversation.
CREATE TABLE dm_media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  INTEGER NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES dm_messages(id) ON DELETE CASCADE,
  staff_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,            -- image | video | audio
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  transcript TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_dm_media_message ON dm_media (message_id);
CREATE TABLE dm_media_chunks (
  media_id INTEGER NOT NULL REFERENCES dm_media(id) ON DELETE CASCADE,
  idx      INTEGER NOT NULL,
  data     TEXT NOT NULL,              -- base64 of up to 600000 bytes
  PRIMARY KEY (media_id, idx)
);
