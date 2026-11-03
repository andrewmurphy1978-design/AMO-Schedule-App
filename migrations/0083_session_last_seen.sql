-- When each browser session was last used (kept up to date at most every two minutes), to show who is signed in.
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
