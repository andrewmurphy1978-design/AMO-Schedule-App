-- Why an employee will be absent (chosen in the app). Only managers and administrators see it.
ALTER TABLE coverage_requests ADD COLUMN reason TEXT;
ALTER TABLE coverage_requests ADD COLUMN reason_note TEXT;
