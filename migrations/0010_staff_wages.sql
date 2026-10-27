-- Hourly rate in cents (1650 = $16.50/h). Kept in its own table, read only by admin-only endpoints,
-- so a wage can never leak through the generic staff/schedule queries.
CREATE TABLE staff_wages (
  staff_id     INTEGER PRIMARY KEY REFERENCES staff(id) ON DELETE CASCADE,
  hourly_cents INTEGER NOT NULL CHECK (hourly_cents >= 0 AND hourly_cents <= 100000)
);
