-- Products: what the customers buy. Formats (sizes) with their price, and the ingredients (with quantities) of each format.
CREATE TABLE products (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id      INTEGER NOT NULL,
  name_fr        TEXT NOT NULL,
  name_en        TEXT,
  category       TEXT,
  description    TEXT,
  code           TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  is_promo       INTEGER NOT NULL DEFAULT 0,
  available_from TEXT,
  available_to   TEXT,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_products_client ON products (client_id, category, position);
CREATE TABLE product_formats (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT '',
  price      REAL,
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_product_formats ON product_formats (product_id, position);
CREATE TABLE product_ingredients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  format_id  INTEGER NOT NULL REFERENCES product_formats(id) ON DELETE CASCADE,
  ingredient TEXT NOT NULL,
  qty        REAL,
  unit       TEXT,
  note       TEXT,
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_product_ingredients ON product_ingredients (format_id, position);
