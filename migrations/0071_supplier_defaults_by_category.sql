-- Default suppliers by category of ingredient (home-made ingredients have none): fruits, vegetables and salads from Duval;
-- breads from the breakfast-bread supplier, except the submarine buns which come from GFS.
INSERT OR IGNORE INTO ingredient_suppliers (ingredient_id, supplier_id)
  SELECT i.id, s.id FROM ingredients i JOIN ingredient_groups g ON g.id = i.group_id JOIN restaurants r ON r.id = g.restaurant_id JOIN suppliers s ON s.client_id = r.client_id AND s.name LIKE 'Duval%'
  WHERE i.homemade = 0 AND i.category IN ('fruits', 'vegetables', 'salads');
INSERT OR IGNORE INTO ingredient_suppliers (ingredient_id, supplier_id)
  SELECT i.id, s.id FROM ingredients i JOIN ingredient_groups g ON g.id = i.group_id JOIN restaurants r ON r.id = g.restaurant_id JOIN suppliers s ON s.client_id = r.client_id AND s.name LIKE 'GFS%'
  WHERE i.homemade = 0 AND i.category = 'breads' AND i.name LIKE 'Pains à sous-marins%';
INSERT OR IGNORE INTO ingredient_suppliers (ingredient_id, supplier_id)
  SELECT i.id, s.id FROM ingredients i JOIN ingredient_groups g ON g.id = i.group_id JOIN restaurants r ON r.id = g.restaurant_id JOIN suppliers s ON s.client_id = r.client_id AND s.name LIKE 'À préciser (pains%'
  WHERE i.homemade = 0 AND i.category = 'breads' AND i.name NOT LIKE 'Pains à sous-marins%';
