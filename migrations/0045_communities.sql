-- Communities: a message board per restaurant and group of departments. People get in automatically through their roles.
CREATE TABLE communities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE community_departments (
  community_id  INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL,
  PRIMARY KEY (community_id, department_id)
);
CREATE TABLE community_posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  parent_id    INTEGER REFERENCES community_posts(id) ON DELETE CASCADE,
  staff_id     INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  pinned       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_community_posts ON community_posts (community_id, parent_id, id);
CREATE TABLE community_reads (
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  staff_id     INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  last_post_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (community_id, staff_id)
);

-- Seed for the current restaurants. The admin department (managers, owner) belongs to every community.
INSERT INTO communities (restaurant_id, name, position) SELECT id, 'Salle', 1 FROM restaurants WHERE name LIKE '%Sauveur%' OR name LIKE '%Agathe%';
INSERT INTO communities (restaurant_id, name, position) SELECT id, 'Cuisine, Plonge et Livraison', 2 FROM restaurants WHERE name LIKE '%Sauveur%';
INSERT INTO communities (restaurant_id, name, position) SELECT id, 'Cuisine et Plonge', 2 FROM restaurants WHERE name LIKE '%Agathe%';
INSERT INTO communities (restaurant_id, name, position) SELECT id, 'Livraison', 3 FROM restaurants WHERE name LIKE '%Agathe%';
INSERT INTO communities (restaurant_id, name, position) SELECT id, 'Équipe', 1 FROM restaurants WHERE name NOT LIKE '%Sauveur%' AND name NOT LIKE '%Agathe%';
INSERT INTO community_departments (community_id, department_id) SELECT c.id, d.v FROM communities c JOIN restaurants r ON r.id = c.restaurant_id, (SELECT 'floor' AS v UNION ALL SELECT 'admin') d WHERE c.name = 'Salle';
INSERT INTO community_departments (community_id, department_id) SELECT c.id, d.v FROM communities c, (SELECT 'kitchen' AS v UNION ALL SELECT 'prep' UNION ALL SELECT 'delivery' UNION ALL SELECT 'admin') d WHERE c.name = 'Cuisine, Plonge et Livraison';
INSERT INTO community_departments (community_id, department_id) SELECT c.id, d.v FROM communities c, (SELECT 'kitchen' AS v UNION ALL SELECT 'prep' UNION ALL SELECT 'admin') d WHERE c.name = 'Cuisine et Plonge';
INSERT INTO community_departments (community_id, department_id) SELECT c.id, d.v FROM communities c, (SELECT 'delivery' AS v UNION ALL SELECT 'admin') d WHERE c.name = 'Livraison';
INSERT INTO community_departments (community_id, department_id) SELECT c.id, d.v FROM communities c, (SELECT 'floor' AS v UNION ALL SELECT 'kitchen' UNION ALL SELECT 'prep' UNION ALL SELECT 'delivery' UNION ALL SELECT 'admin') d WHERE c.name = 'Équipe';
