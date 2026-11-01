-- When delivery starts each weekday (it ends at closing time). Today: 11:00, or the opening time when the restaurant opens later.
ALTER TABLE restaurant_open_hours ADD COLUMN delivery_time TEXT;
UPDATE restaurant_open_hours SET delivery_time = CASE WHEN open_time > '11:00' THEN open_time ELSE '11:00' END;
