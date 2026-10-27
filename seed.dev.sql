-- Local test data only. Never apply to production.
INSERT INTO restaurants (name) VALUES ('Ste-Agathe-des-Monts'), ('Saint-Sauveur');
INSERT INTO staff (name, email, is_admin) VALUES
  ('Andrew', 'andrew@test.dev', 1),
  ('Marc Tremblay',  'marc@test.dev',   0),
  ('Julie Gagnon',   'julie@test.dev',  0),
  ('Sam Lavoie',     'sam@test.dev',    0),
  ('Léa Roy',        'lea@test.dev',    0);
-- roles: 1 waiter 2 host 3 busboy 4 chef 5 cook 6 dishwasher 7 driver
INSERT INTO staff_roles (staff_id, restaurant_id, role_id) VALUES
  (2,1,5),(2,1,7),(2,2,1),   -- Marc: cook+driver at Ste-Agathe, waiter at St-Sauveur
  (3,1,1),(3,1,2),           -- Julie: waiter+host at Ste-Agathe
  (4,1,6),(4,1,3),           -- Sam: dishwasher+busboy at Ste-Agathe
  (5,1,1),(5,2,1);           -- Léa: waiter at both
INSERT INTO managers (staff_id, restaurant_id, department_id) VALUES (3,1,'floor');
INSERT INTO shifts (staff_id, restaurant_id, role_id, start_at, end_at, notes) VALUES
  (3,1,1,'2026-10-26T11:00','2026-10-26T17:00',NULL),
  (5,1,1,'2026-10-26T17:00','2026-10-27T01:00','Soirée'),
  (3,1,2,'2026-10-27T11:00','2026-10-27T16:00',NULL),
  (5,1,1,'2026-10-28T11:00','2026-10-28T17:00',NULL),
  (4,1,3,'2026-10-29T17:00','2026-10-29T23:00',NULL),
  (2,1,5,'2026-10-27T10:00','2026-10-27T18:00',NULL),
  (2,1,5,'2026-10-28T10:00','2026-10-28T18:00',NULL),
  (4,1,6,'2026-10-27T17:00','2026-10-27T23:00',NULL),
  (2,1,7,'2026-10-30T17:00','2026-10-30T22:00','Livraisons');
