-- Opening time per restaurant (the timeline shades the hours before opening and after closing).
ALTER TABLE restaurants ADD COLUMN open_time TEXT NOT NULL DEFAULT '07:00';
