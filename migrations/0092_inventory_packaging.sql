-- How an ingredient is packaged and counted (JSON: family, base_unit, pack_unit, pack_qty, pack_weight, unit_weight, min_qty, pack_cost, sku),
-- and a stock count line made of several quantities (3 bundles + 40 boxes).
ALTER TABLE ingredients ADD COLUMN inv TEXT;
ALTER TABLE inventory_lines ADD COLUMN parts TEXT;
