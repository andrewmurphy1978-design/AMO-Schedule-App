-- All shift times are naive local restaurant time, 'YYYY-MM-DDTHH:MM'.
-- Strings in this format sort and compare correctly as text.

CREATE TABLE restaurants (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE departments (
  id      TEXT PRIMARY KEY,
  name_fr TEXT NOT NULL,
  name_en TEXT NOT NULL
);

CREATE TABLE roles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id TEXT NOT NULL REFERENCES departments(id),
  name_fr       TEXT NOT NULL,
  name_en       TEXT NOT NULL
);

CREATE TABLE staff (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  email    TEXT UNIQUE,
  phone    TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0
);

-- A person can hold several roles, across departments and restaurants.
CREATE TABLE staff_roles (
  staff_id      INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  PRIMARY KEY (staff_id, restaurant_id, role_id)
);

-- A manager edits the schedule of one department at one restaurant.
-- Several rows = several schedules / restaurants.
CREATE TABLE managers (
  staff_id      INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL REFERENCES departments(id),
  PRIMARY KEY (staff_id, restaurant_id, department_id)
);

CREATE TABLE shifts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id      INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  notes         TEXT,
  CHECK (start_at < end_at)
);
CREATE INDEX idx_shifts_staff ON shifts(staff_id, start_at);
CREATE INDEX idx_shifts_restaurant ON shifts(restaurant_id, start_at);

INSERT INTO departments (id, name_fr, name_en) VALUES
  ('floor',    'Salle',     'Floor'),
  ('kitchen',  'Cuisine',   'Kitchen'),
  ('delivery', 'Livraison', 'Delivery');

INSERT INTO roles (department_id, name_fr, name_en) VALUES
  ('floor',    'Serveur / serveuse',   'Waiter / waitress'),
  ('floor',    'Hôte / hôtesse',       'Host / hostess'),
  ('floor',    'Aide-serveur / aide-serveuse', 'Busboy / busgirl'),
  ('kitchen',  'Chef',                 'Chef'),
  ('kitchen',  'Cuisinier / cuisinière', 'Cook'),
  ('kitchen',  'Plongeur / plongeuse', 'Dishwasher'),
  ('delivery', 'Livreur / livreuse',   'Delivery driver');
