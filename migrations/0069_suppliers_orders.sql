-- Suppliers (one ingredient can come from several), and the ingredients employees report as missing so the manager orders them.
CREATE TABLE suppliers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  phone     TEXT,
  email     TEXT,
  notes     TEXT,
  position  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE ingredient_suppliers (
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  PRIMARY KEY (ingredient_id, supplier_id)
);
CREATE TABLE order_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  note          TEXT,
  reported_by   INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  reported_at   INTEGER NOT NULL,
  ordered_at    INTEGER,
  ordered_by    INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  supplier_id   INTEGER REFERENCES suppliers(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX uq_order_open ON order_requests (restaurant_id, lower(name)) WHERE ordered_at IS NULL;
CREATE INDEX idx_order_requests ON order_requests (restaurant_id, ordered_at);
