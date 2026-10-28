-- Kitchen posts and who is competent at each. The five posts must each have someone competent present while the kitchen works;
-- a "runner" is competent at every post.
CREATE TABLE posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id TEXT NOT NULL REFERENCES departments(id),
  code          TEXT NOT NULL UNIQUE,
  name_fr       TEXT NOT NULL,
  name_en       TEXT NOT NULL,
  sort          INTEGER NOT NULL DEFAULT 0,
  all_posts     INTEGER NOT NULL DEFAULT 0     -- 1 = the runner: counts as competent at every post
);
INSERT INTO posts (department_id, code, name_fr, name_en, sort, all_posts) VALUES
  ('kitchen', 'subs',     'Sous-marins',       'Submarines',       1, 0),
  ('kitchen', 'starters', 'Entrées / friteuse', 'Starters / fryer', 2, 0),
  ('kitchen', 'pasta',    'Pâtes',             'Pasta',            3, 0),
  ('kitchen', 'pizza',    'Pizza',             'Pizza',            4, 0),
  ('kitchen', 'oven',     'Sortie du four',    'Out of the oven',  5, 0),
  ('kitchen', 'runner',   'Coureur (tous les postes)', 'Runner (all posts)', 6, 1);

CREATE TABLE staff_post_skills (
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  post_id  INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, post_id)
);

-- Assistant cook, next to the cook.
INSERT INTO roles (department_id, name_fr, name_en) VALUES ('kitchen', 'Aide-cuisinier / aide-cuisinière', 'Assistant cook');
