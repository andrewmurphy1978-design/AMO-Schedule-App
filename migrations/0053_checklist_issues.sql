-- An end-of-shift task that could not be completed (typically a missing ingredient), with what is missing.
CREATE TABLE shift_checklist_issues (
  shift_id    INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL,            -- 'missing_ingredient' | 'other'
  note        TEXT NOT NULL,
  reported_by INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (shift_id, item_id)
);
