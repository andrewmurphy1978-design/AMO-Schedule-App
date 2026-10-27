-- Staffing-target periods are now configurable per restaurant: a list of boundaries (see public/coverage.js).
-- A restaurant without a row uses the default: Open-8:00, 8-9, 9-11, 11-12, 12-14, 14-17, 17-20, 20-Close.
CREATE TABLE restaurant_periods (
  restaurant_id INTEGER PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  boundaries    TEXT NOT NULL            -- JSON array of "HH:MM", increasing
);

-- Convert the old slot keys (06:30, 08:00, 09:00, 11:00, 14:00, 17:00, close) to the new periods; values are kept.
-- 06:30 (opening to 8:00) -> open;  11:00 (11-14) -> 11:00 and 12:00;  close (last hour before closing) -> 20:00.
UPDATE staffing_targets SET slot = 'open'  WHERE slot = '06:30';
UPDATE staffing_targets SET slot = '20:00' WHERE slot = 'close';
INSERT OR IGNORE INTO staffing_targets (restaurant_id, department_id, set_id, dow, slot, count)
  SELECT restaurant_id, department_id, set_id, dow, '12:00', count FROM staffing_targets WHERE slot = '11:00';
