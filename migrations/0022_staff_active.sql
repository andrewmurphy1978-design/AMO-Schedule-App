-- An inactive employee keeps their history but cannot be scheduled, is not asked for replacements, gets no messages and cannot sign in.
ALTER TABLE staff ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
