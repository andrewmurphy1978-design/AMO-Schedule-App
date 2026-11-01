-- Boxes, trays, lids, bags and bundles come from GFS (the folded boxes are made in the restaurant: no supplier).
INSERT OR IGNORE INTO ingredient_suppliers (ingredient_id, supplier_id)
  SELECT i.id, s.id FROM ingredients i JOIN ingredient_groups g ON g.id = i.group_id JOIN restaurants r ON r.id = g.restaurant_id JOIN suppliers s ON s.client_id = r.client_id AND s.name LIKE 'GFS%'
  WHERE i.category = 'boxes' AND i.homemade = 0;
