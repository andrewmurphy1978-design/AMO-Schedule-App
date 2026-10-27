-- Local test data only. Never apply to production.
INSERT INTO restaurants (name) VALUES ('Resto A'), ('Resto B');
INSERT INTO staff (name, email, is_admin) VALUES
  ('Andrew', 'andrew@test.dev', 1),
  ('Marc',   'marc@test.dev',   0),   -- cook + driver at A, waiter at B
  ('Julie',  'julie@test.dev',  0),   -- waiter-manager at A
  ('Sam',    'sam@test.dev',    0);   -- dishwasher at A
INSERT INTO staff_roles (staff_id, restaurant_id, role_id) VALUES
  (2,1,5),(2,1,7),(2,2,1),(3,1,1),(4,1,6);
INSERT INTO managers (staff_id, restaurant_id, department_id) VALUES (3,1,'floor');
