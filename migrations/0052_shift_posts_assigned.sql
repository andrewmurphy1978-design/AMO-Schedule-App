-- Who put a kitchen post on a shift (a manager assigning it, or the employee choosing it in the end-of-shift checklist).
ALTER TABLE shift_checklists ADD COLUMN assigned_by INTEGER REFERENCES staff(id) ON DELETE SET NULL;
