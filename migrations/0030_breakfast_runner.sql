-- Breakfast posts (eggs, back post) and a Runner role for busy days.
ALTER TABLE posts ADD COLUMN kind TEXT NOT NULL DEFAULT 'main';   -- 'main' | 'breakfast'
INSERT INTO posts (department_id, code, name_fr, name_en, sort, all_posts, kind) VALUES
  ('kitchen', 'bf_eggs', 'Déjeuner (œufs)',           'Breakfast (eggs)',      7, 0, 'breakfast'),
  ('kitchen', 'bf_back', 'Déjeuner (poste arrière)',  'Breakfast (back post)', 8, 0, 'breakfast');

-- Breakfast hours per weekday (0 = Monday ... 6 = Sunday); a day without a row has no breakfast.
-- While breakfast is served the breakfast posts are the ones to cover in the kitchen.
CREATE TABLE restaurant_breakfast (
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  dow           INTEGER NOT NULL CHECK (dow BETWEEN 0 AND 6),
  start_time    TEXT NOT NULL,
  end_time      TEXT NOT NULL,
  PRIMARY KEY (restaurant_id, dow),
  CHECK (start_time < end_time)
);

-- The runner: an extra person on busy days, competent at every post and fast.
INSERT INTO roles (department_id, name_fr, name_en) VALUES ('kitchen', 'Coureur / coureuse', 'Runner');
