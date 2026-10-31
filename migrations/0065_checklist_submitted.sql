-- "Terminé": the employee closes the end-of-shift list even when some tasks are not ticked.
CREATE TABLE shift_checklist_submitted (
  shift_id     INTEGER PRIMARY KEY REFERENCES shifts(id) ON DELETE CASCADE,
  submitted_by INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  submitted_at INTEGER NOT NULL
);
