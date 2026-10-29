-- Which schedules (restaurant + department) an employee can look at. By default ("auto") they see the schedules where they
-- hold a role; an administrator can switch an employee to "custom" and tick exactly the schedules they may see.
ALTER TABLE staff ADD COLUMN view_custom INTEGER NOT NULL DEFAULT 0;
CREATE TABLE staff_view_access (
  staff_id      INTEGER NOT NULL,
  restaurant_id INTEGER NOT NULL,
  department_id TEXT NOT NULL,
  PRIMARY KEY (staff_id, restaurant_id, department_id)
);
-- Fill the new list from what everybody already has: the restaurant + department of each role they hold.
INSERT OR IGNORE INTO staff_view_access (staff_id, restaurant_id, department_id)
  SELECT sr.staff_id, sr.restaurant_id, ro.department_id FROM staff_roles sr JOIN roles ro ON ro.id = sr.role_id;
