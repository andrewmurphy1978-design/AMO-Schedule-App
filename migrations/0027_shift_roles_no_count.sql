-- An extra role on a shift can be marked "don't count for targets": the person is listed for that role (so they know they may be asked)
-- but the coverage view does not count them toward that department's requirement (no false surplus).
ALTER TABLE shift_roles ADD COLUMN no_count INTEGER NOT NULL DEFAULT 0;
