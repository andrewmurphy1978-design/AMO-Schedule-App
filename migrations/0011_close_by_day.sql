-- Closing time per weekday, next to the opening time. NULL = use restaurants.close_time.
ALTER TABLE restaurant_open_hours ADD COLUMN close_time TEXT;
