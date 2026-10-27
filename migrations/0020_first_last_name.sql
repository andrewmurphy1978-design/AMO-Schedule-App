-- Names are split into first and last name. `name` stays as the full name ("First Last") so every existing screen keeps working.
ALTER TABLE staff ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
ALTER TABLE staff ADD COLUMN last_name TEXT NOT NULL DEFAULT '';
UPDATE staff SET
  first_name = CASE WHEN instr(trim(name), ' ') > 0 THEN substr(trim(name), 1, instr(trim(name), ' ') - 1) ELSE trim(name) END,
  last_name  = CASE WHEN instr(trim(name), ' ') > 0 THEN trim(substr(trim(name), instr(trim(name), ' ') + 1)) ELSE '' END;
