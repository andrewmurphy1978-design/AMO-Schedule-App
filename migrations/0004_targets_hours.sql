-- Closing time per restaurant (used by 'until close' shifts and the 'close' staffing target).
ALTER TABLE restaurants ADD COLUMN close_time TEXT NOT NULL DEFAULT '22:00';

-- Desired headcount at set times of day, per restaurant + department.
-- dow: -1 = every day (default), 0 = Monday ... 6 = Sunday (override for that day).
-- slot: '06:30','08:00','09:00','11:00','14:00','17:00' or 'close'.
CREATE TABLE staffing_targets (
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL REFERENCES departments(id),
  dow           INTEGER NOT NULL CHECK (dow BETWEEN -1 AND 6),
  slot          TEXT NOT NULL,
  count         INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (restaurant_id, department_id, dow, slot)
);
