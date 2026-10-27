-- Default hourly rates (cents), used when an employee has no rate of their own:
-- tipped roles (waiter, delivery) get the Québec tipped minimum wage, everyone else the general minimum wage.
ALTER TABLE roles ADD COLUMN default_hourly_cents INTEGER CHECK (default_hourly_cents IS NULL OR (default_hourly_cents >= 0 AND default_hourly_cents <= 100000));
UPDATE roles SET default_hourly_cents = 1330 WHERE name_en IN ('Waiter / waitress', 'Delivery driver');
INSERT OR IGNORE INTO settings (key, value) VALUES ('default_hourly_cents', '1660');
