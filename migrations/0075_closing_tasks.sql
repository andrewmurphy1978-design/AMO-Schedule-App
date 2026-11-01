-- The mop is no longer in every kitchen post list: it is one closing task a day, given in turn to someone of the closing crew.
DELETE FROM checklist_items WHERE text_fr = 'Passer la moppe autour de mon poste' AND checklist_id IN (SELECT id FROM checklists WHERE kind = 'post');
CREATE TABLE closing_tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL,
  text_fr       TEXT NOT NULL,
  text_en       TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0
);
-- who got it on which day (a day without a row is still to be given); the history is what makes the rotation fair
CREATE TABLE closing_task_assignments (
  task_id       INTEGER NOT NULL REFERENCES closing_tasks(id) ON DELETE CASCADE,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  staff_id      INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  assigned_by   INTEGER REFERENCES staff(id) ON DELETE SET NULL,   -- null = automatic rotation
  assigned_at   INTEGER NOT NULL,
  PRIMARY KEY (task_id, restaurant_id, date)
);
CREATE INDEX idx_closing_assignments ON closing_task_assignments (task_id, restaurant_id, staff_id, date);
CREATE TABLE closing_task_done (
  shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  task_id  INTEGER NOT NULL REFERENCES closing_tasks(id) ON DELETE CASCADE,
  done_by  INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  done_at  INTEGER NOT NULL,
  PRIMARY KEY (shift_id, task_id)
);
INSERT INTO closing_tasks (client_id, department_id, text_fr, text_en, position) SELECT 1, 'kitchen', 'Passer la moppe dans la cuisine (tâche de fermeture)', 'Mop the kitchen floor (closing task)', 1 WHERE EXISTS (SELECT 1 FROM clients WHERE id = 1);
