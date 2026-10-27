-- Sex of the employee ('M' or 'F', empty = not specified): used to write the French/English role in the right gender
-- (Cuisinier / Cuisinière). Not guessed from names; filled in by an admin.
ALTER TABLE staff ADD COLUMN sex TEXT CHECK (sex IS NULL OR sex IN ('M', 'F'));
-- "Bureau / administration" is not a masculine/feminine pair.
UPDATE roles SET name_fr = 'Bureau' WHERE name_en = 'Office' AND name_fr = 'Bureau / administration';
