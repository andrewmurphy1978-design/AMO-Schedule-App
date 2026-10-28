-- Multi-client: each client (company) owns its restaurants and employees. Everything else hangs from those two.
-- Client 1 is the existing installation. Settings of client N are stored under the key prefix "cN:" (client 1 keeps plain keys).
CREATE TABLE clients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  hostname   TEXT UNIQUE,              -- optional: sign-in page branding follows the domain the visitor used
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
INSERT INTO clients (id, name, created_at) VALUES (1, 'Mikes', CAST(strftime('%s','now') AS INTEGER) * 1000);
ALTER TABLE restaurants ADD COLUMN client_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE staff ADD COLUMN client_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_restaurants_client ON restaurants(client_id);
CREATE INDEX idx_staff_client ON staff(client_id);
-- (No REFERENCES on these columns: SQLite refuses a REFERENCES column with a non-NULL default when foreign keys are enforced, as on D1.)
-- Pay slips waiting for confirmation have no employee yet, so they carry their client.
ALTER TABLE payslips ADD COLUMN client_id INTEGER NOT NULL DEFAULT 1;
