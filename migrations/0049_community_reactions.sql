-- Emoji reactions on community posts (one row per person and emoji).
CREATE TABLE community_reactions (
  post_id  INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  emoji    TEXT NOT NULL,
  PRIMARY KEY (post_id, staff_id, emoji)
);
