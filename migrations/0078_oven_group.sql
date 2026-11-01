-- A "Sortie du four" post in the products (after Entrées), linked to the kitchen post of the same name.
UPDATE ingredient_groups SET position = position + 1
  WHERE position > (SELECT position FROM ingredient_groups e WHERE e.restaurant_id = ingredient_groups.restaurant_id AND e.name_fr = 'Entrées')
    AND restaurant_id IN (SELECT restaurant_id FROM ingredient_groups WHERE name_fr = 'Entrées')
    AND restaurant_id NOT IN (SELECT restaurant_id FROM ingredient_groups WHERE name_fr = 'Sortie du four');
INSERT INTO ingredient_groups (restaurant_id, name_fr, name_en, post_id, position)
  SELECT g.restaurant_id, 'Sortie du four', 'Out of the oven', (SELECT id FROM posts WHERE code = 'oven' LIMIT 1), g.position + 1
  FROM ingredient_groups g WHERE g.name_fr = 'Entrées' AND NOT EXISTS (SELECT 1 FROM ingredient_groups x WHERE x.restaurant_id = g.restaurant_id AND x.name_fr = 'Sortie du four');
