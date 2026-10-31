-- Back-store ingredients that go in the fridge once opened.
ALTER TABLE ingredients ADD COLUMN fridge_open INTEGER NOT NULL DEFAULT 0;
