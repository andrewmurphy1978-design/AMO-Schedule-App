-- Where a product is sold: dine_in, delivery, counter (JSON list; NULL = everywhere).
ALTER TABLE products ADD COLUMN channels TEXT;
