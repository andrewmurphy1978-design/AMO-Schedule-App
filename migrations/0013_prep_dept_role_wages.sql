-- A separate "Plonge / Préparation" department (dishwashing and food prep) with its own schedule.
INSERT INTO departments (id, name_fr, name_en) VALUES ('prep', 'Plonge / Préparation', 'Dish / Prep');
-- The existing dishwasher role moves to it (its shifts and people follow); a prep role is added.
UPDATE roles SET department_id = 'prep' WHERE department_id = 'kitchen' AND name_en = 'Dishwasher';
INSERT INTO roles (department_id, name_fr, name_en) VALUES ('prep', 'Préparateur / préparatrice', 'Prep cook');

-- Optional hourly rate per role (e.g. delivery vs cook). Falls back to the employee's general rate.
-- Admin-only, like staff_wages.
CREATE TABLE staff_role_wages (
  staff_id     INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  role_id      INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  hourly_cents INTEGER NOT NULL CHECK (hourly_cents >= 0 AND hourly_cents <= 100000),
  PRIMARY KEY (staff_id, role_id)
);
