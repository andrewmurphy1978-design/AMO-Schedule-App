-- Photos and videos in community posts. Files are kept in D1 in chunks (post_id stays NULL until the post is published).
CREATE TABLE community_media (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  post_id      INTEGER REFERENCES community_posts(id) ON DELETE CASCADE,
  staff_id     INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,          -- 'image' | 'video'
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_community_media_post ON community_media (post_id);
CREATE TABLE community_media_chunks (
  media_id INTEGER NOT NULL REFERENCES community_media(id) ON DELETE CASCADE,
  idx      INTEGER NOT NULL,
  data     TEXT NOT NULL,              -- base64 of up to 600000 bytes
  PRIMARY KEY (media_id, idx)
);
