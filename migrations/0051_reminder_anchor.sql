-- A reminder can count from the start of the shift (default) or from its end ("your shift ends soon, do your checklist").
ALTER TABLE shift_reminders ADD COLUMN anchor TEXT NOT NULL DEFAULT 'start';
