-- Remove roles that repeat another one: Assistant cook (= Prep cook / Cook), Runner (is now only a competency), Assistant manager (= Office).
-- Their shifts and people move to the role that replaces them.

-- Assistant cook -> Cook
UPDATE shifts SET role_id = (SELECT id FROM roles WHERE name_en = 'Cook') WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant cook') AND (SELECT id FROM roles WHERE name_en = 'Assistant cook') IS NOT NULL;
UPDATE coverage_requests SET role_id = (SELECT id FROM roles WHERE name_en = 'Cook') WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant cook') AND (SELECT id FROM roles WHERE name_en = 'Assistant cook') IS NOT NULL;
INSERT OR IGNORE INTO staff_roles (staff_id, restaurant_id, role_id) SELECT staff_id, restaurant_id, (SELECT id FROM roles WHERE name_en = 'Cook') FROM staff_roles WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant cook') AND (SELECT id FROM roles WHERE name_en = 'Assistant cook') IS NOT NULL;
DELETE FROM staff_roles WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant cook');
UPDATE OR IGNORE shift_roles SET role_id = (SELECT id FROM roles WHERE name_en = 'Cook') WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant cook');
DELETE FROM shift_roles WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant cook');
UPDATE shift_segments SET role_id = (SELECT id FROM roles WHERE name_en = 'Cook') WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant cook');
UPDATE OR IGNORE staff_role_wages SET role_id = (SELECT id FROM roles WHERE name_en = 'Cook') WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant cook');
DELETE FROM staff_role_wages WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant cook');
DELETE FROM roles WHERE name_en = 'Assistant cook';

-- Runner -> Cook
UPDATE shifts SET role_id = (SELECT id FROM roles WHERE name_en = 'Cook') WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Runner') AND (SELECT id FROM roles WHERE name_en = 'Runner') IS NOT NULL;
UPDATE coverage_requests SET role_id = (SELECT id FROM roles WHERE name_en = 'Cook') WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Runner') AND (SELECT id FROM roles WHERE name_en = 'Runner') IS NOT NULL;
INSERT OR IGNORE INTO staff_roles (staff_id, restaurant_id, role_id) SELECT staff_id, restaurant_id, (SELECT id FROM roles WHERE name_en = 'Cook') FROM staff_roles WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Runner') AND (SELECT id FROM roles WHERE name_en = 'Runner') IS NOT NULL;
DELETE FROM staff_roles WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Runner');
UPDATE OR IGNORE shift_roles SET role_id = (SELECT id FROM roles WHERE name_en = 'Cook') WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Runner');
DELETE FROM shift_roles WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Runner');
UPDATE shift_segments SET role_id = (SELECT id FROM roles WHERE name_en = 'Cook') WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Runner');
UPDATE OR IGNORE staff_role_wages SET role_id = (SELECT id FROM roles WHERE name_en = 'Cook') WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Runner');
DELETE FROM staff_role_wages WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Runner');
DELETE FROM roles WHERE name_en = 'Runner';

-- Assistant manager -> Office
UPDATE shifts SET role_id = (SELECT id FROM roles WHERE name_en = 'Office') WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant manager') AND (SELECT id FROM roles WHERE name_en = 'Assistant manager') IS NOT NULL;
UPDATE coverage_requests SET role_id = (SELECT id FROM roles WHERE name_en = 'Office') WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant manager') AND (SELECT id FROM roles WHERE name_en = 'Assistant manager') IS NOT NULL;
INSERT OR IGNORE INTO staff_roles (staff_id, restaurant_id, role_id) SELECT staff_id, restaurant_id, (SELECT id FROM roles WHERE name_en = 'Office') FROM staff_roles WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant manager') AND (SELECT id FROM roles WHERE name_en = 'Assistant manager') IS NOT NULL;
DELETE FROM staff_roles WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant manager');
UPDATE OR IGNORE shift_roles SET role_id = (SELECT id FROM roles WHERE name_en = 'Office') WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant manager');
DELETE FROM shift_roles WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant manager');
UPDATE shift_segments SET role_id = (SELECT id FROM roles WHERE name_en = 'Office') WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant manager');
UPDATE OR IGNORE staff_role_wages SET role_id = (SELECT id FROM roles WHERE name_en = 'Office') WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant manager');
DELETE FROM staff_role_wages WHERE role_id = (SELECT id FROM roles WHERE name_en = 'Assistant manager');
DELETE FROM roles WHERE name_en = 'Assistant manager';
