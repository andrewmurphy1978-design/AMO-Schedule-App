-- Fields used when the AI proposes next week's schedule: hours promised to the employee, and free notes for the planner.
ALTER TABLE staff ADD COLUMN promised_hours REAL CHECK (promised_hours IS NULL OR (promised_hours >= 0 AND promised_hours <= 168));
ALTER TABLE staff ADD COLUMN scheduling_notes TEXT;
