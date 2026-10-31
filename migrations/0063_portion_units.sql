-- A portion can also be a count of something (2 slices, 3 pieces…), besides or instead of its weight.
ALTER TABLE ingredients ADD COLUMN portion_qty REAL;
ALTER TABLE ingredients ADD COLUMN portion_unit TEXT;
