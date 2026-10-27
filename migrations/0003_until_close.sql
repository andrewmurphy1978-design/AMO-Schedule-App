-- 'F' (fermeture) shifts have no fixed end. end_at holds a provisional closing time
-- until per-restaurant closing hours are configured.
ALTER TABLE shifts ADD COLUMN until_close INTEGER NOT NULL DEFAULT 0;
