-- Which communities an employee sees. By default ("auto") the ones matching their roles; an administrator can switch an
-- employee to "custom" and tick exactly the communities they may see (managers keep the ones of the departments they manage).
ALTER TABLE staff ADD COLUMN community_custom INTEGER NOT NULL DEFAULT 0;
CREATE TABLE staff_community_access (
  staff_id     INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, community_id)
);
