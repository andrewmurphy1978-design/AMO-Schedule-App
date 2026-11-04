-- Suppliers: several ways to order, a web portal / site, the order calendar; ingredients: the supplier's product numbers;
-- and the history of the orders placed.
ALTER TABLE suppliers ADD COLUMN order_methods TEXT;
ALTER TABLE suppliers ADD COLUMN portal_url TEXT;
ALTER TABLE suppliers ADD COLUMN website_url TEXT;
ALTER TABLE suppliers ADD COLUMN order_settings TEXT;
UPDATE suppliers SET order_methods = json_array(order_method) WHERE order_method IS NOT NULL;
ALTER TABLE ingredients ADD COLUMN codes TEXT;
CREATE TABLE supplier_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  method        TEXT NOT NULL,
  placed_by     INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  placed_at     INTEGER NOT NULL,
  delivery_date TEXT,
  note          TEXT,
  items         TEXT NOT NULL
);
CREATE INDEX idx_supplier_orders ON supplier_orders (supplier_id, restaurant_id, placed_at);
ALTER TABLE order_requests ADD COLUMN order_id INTEGER;
