-- Minutes before opening that a role should arrive (cook and waiter: 30). Used as the default start time of a shift and shown on the coverage view.
ALTER TABLE roles ADD COLUMN pre_open_minutes INTEGER NOT NULL DEFAULT 0 CHECK (pre_open_minutes >= 0 AND pre_open_minutes <= 180);
UPDATE roles SET pre_open_minutes = 30 WHERE name_en IN ('Cook', 'Waiter / waitress');
