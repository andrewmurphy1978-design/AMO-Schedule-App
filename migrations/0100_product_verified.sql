-- A product whose ingredients, quantities and prices have been checked.
ALTER TABLE products ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN verified_at INTEGER;
ALTER TABLE products ADD COLUMN verified_by INTEGER;
