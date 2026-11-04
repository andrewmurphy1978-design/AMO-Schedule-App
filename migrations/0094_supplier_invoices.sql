-- Receiving an order: the supplier's invoice (photo or PDF), what was read on it and how it compares with what was ordered.
CREATE TABLE supplier_invoices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id    INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  restaurant_id  INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id       INTEGER,
  filename       TEXT NOT NULL,
  mime           TEXT NOT NULL,
  content_b64    TEXT NOT NULL,
  size           INTEGER NOT NULL,
  invoice_number TEXT,
  invoice_date   TEXT,
  total          REAL,
  uploaded_by    INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  uploaded_at    INTEGER NOT NULL,
  read_by_ai     INTEGER NOT NULL DEFAULT 0,
  lines          TEXT,
  comparison     TEXT,
  prices_reverted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_supplier_invoices ON supplier_invoices (supplier_id, restaurant_id, uploaded_at);
ALTER TABLE supplier_orders ADD COLUMN received_at INTEGER;
ALTER TABLE supplier_orders ADD COLUMN received_by INTEGER;
