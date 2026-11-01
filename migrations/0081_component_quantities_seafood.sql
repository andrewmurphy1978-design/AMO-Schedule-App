-- Quantity of each component of a home-made product, e.g. {"Oignons": {"qty": 5, "unit": "kg"}}.
ALTER TABLE ingredients ADD COLUMN component_qty TEXT;
-- Category "seafood" (Poissons et fruits de mer): the fish and seafood already in the lists move there, and three more products.
UPDATE ingredients SET category = 'seafood' WHERE name IN ('Saumon', 'Saumon à déjeuner', 'Saumon à déjeuner portionné', 'Poissons', 'Crevettes 31/40');
INSERT INTO ingredients (group_id, name, location, category, position)
  SELECT g.id, 'Goberge', 'freezer', 'seafood', COALESCE((SELECT MAX(i.position) FROM ingredients i WHERE i.group_id = g.id), 0) + 1
  FROM ingredient_groups g JOIN restaurants r ON r.id = g.restaurant_id WHERE g.name_fr = 'Congélateur de cuisine' AND (r.name LIKE '%Sauveur%' OR r.name LIKE '%Agathe%') AND NOT EXISTS (SELECT 1 FROM ingredients i WHERE i.group_id = g.id AND i.name = 'Goberge');
INSERT INTO ingredients (group_id, name, location, category, position)
  SELECT g.id, 'Pétoncles', 'freezer', 'seafood', COALESCE((SELECT MAX(i.position) FROM ingredients i WHERE i.group_id = g.id), 0) + 1
  FROM ingredient_groups g JOIN restaurants r ON r.id = g.restaurant_id WHERE g.name_fr = 'Congélateur de cuisine' AND (r.name LIKE '%Sauveur%' OR r.name LIKE '%Agathe%') AND NOT EXISTS (SELECT 1 FROM ingredients i WHERE i.group_id = g.id AND i.name = 'Pétoncles');
INSERT INTO ingredients (group_id, name, location, category, position)
  SELECT g.id, 'Crevettes nordiques', 'freezer', 'seafood', COALESCE((SELECT MAX(i.position) FROM ingredients i WHERE i.group_id = g.id), 0) + 1
  FROM ingredient_groups g JOIN restaurants r ON r.id = g.restaurant_id WHERE g.name_fr = 'Congélateur de cuisine' AND (r.name LIKE '%Sauveur%' OR r.name LIKE '%Agathe%') AND NOT EXISTS (SELECT 1 FROM ingredients i WHERE i.group_id = g.id AND i.name = 'Crevettes nordiques');
