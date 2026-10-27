-- A shift can cover several roles (e.g. cook + dishwasher). shifts.role_id stays the main role; the others are listed here.
CREATE TABLE shift_roles (
  shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  role_id  INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (shift_id, role_id)
);
