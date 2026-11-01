-- How each supplier is ordered from (call, email or API), the customer number there, and the API access (the key is never sent back to the browser).
ALTER TABLE suppliers ADD COLUMN order_method TEXT;      -- call | email | api
ALTER TABLE suppliers ADD COLUMN customer_number TEXT;
ALTER TABLE suppliers ADD COLUMN api_url TEXT;
ALTER TABLE suppliers ADD COLUMN api_user TEXT;
ALTER TABLE suppliers ADD COLUMN api_key TEXT;
