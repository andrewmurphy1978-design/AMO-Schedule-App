-- An ingredient from the freezer can have to be thawed the day before; an ingredient can be home-made from other ingredients.
ALTER TABLE ingredients ADD COLUMN thaw INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingredients ADD COLUMN homemade INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingredients ADD COLUMN components TEXT;      -- JSON list of ingredient names it is made from
ALTER TABLE ingredients ADD COLUMN prep_note TEXT;       -- how to prepare it (shown in the prep task)
-- Thawing done at the end of a shift (item = the ingredient to take out of the freezer for tomorrow).
CREATE TABLE shift_thaw_done (
  shift_id      INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  done_by       INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  done_at       INTEGER NOT NULL,
  PRIMARY KEY (shift_id, ingredient_id)
);
