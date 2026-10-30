-- A kitchen post can be assigned to someone for part of the shift only (null = the whole shift).
ALTER TABLE shift_checklists ADD COLUMN start_at TEXT;
ALTER TABLE shift_checklists ADD COLUMN end_at TEXT;
