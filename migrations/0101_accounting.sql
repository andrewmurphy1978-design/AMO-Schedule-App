-- Accounting (owner of the platform only): double-entry books for several entities (personal, sole proprietorship, corporation, US LLC).
-- Amounts are whole cents. The books belong to a person (owner_id), not to a client.
CREATE TABLE acc_entities (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id             INTEGER NOT NULL,
  name                 TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('PERSONAL', 'SOLE_PROPRIETORSHIP', 'CORPORATION', 'LLC')),
  country              TEXT NOT NULL DEFAULT 'CA',
  province             TEXT,
  currency             TEXT NOT NULL DEFAULT 'CAD',
  fiscal_year_end_month INTEGER NOT NULL DEFAULT 12 CHECK (fiscal_year_end_month BETWEEN 1 AND 12),
  basis                TEXT NOT NULL DEFAULT 'CASH' CHECK (basis IN ('CASH', 'ACCRUAL')),
  sales_tax_registered INTEGER NOT NULL DEFAULT 0,
  tax_number           TEXT,
  sort                 INTEGER NOT NULL DEFAULT 0,
  archived             INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL
);
CREATE INDEX idx_acc_entities_owner ON acc_entities (owner_id);
CREATE TABLE acc_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id     INTEGER NOT NULL REFERENCES acc_entities(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  template_code TEXT,
  name          TEXT NOT NULL,
  name_fr       TEXT,
  type          TEXT NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')),
  subtype       TEXT NOT NULL DEFAULT 'OTHER',
  tax_line      TEXT,
  gifi          TEXT,
  deductible_pct REAL NOT NULL DEFAULT 100,
  parent_id     INTEGER,
  is_system     INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  sort          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (entity_id, code)
);
CREATE INDEX idx_acc_accounts_entity ON acc_accounts (entity_id);
CREATE TABLE acc_journal_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id  INTEGER NOT NULL REFERENCES acc_entities(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  memo       TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'OPENING')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_acc_journal_entity_date ON acc_journal_entries (entity_id, date);
CREATE TABLE acc_journal_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id     INTEGER NOT NULL REFERENCES acc_journal_entries(id) ON DELETE CASCADE,
  account_id   INTEGER NOT NULL REFERENCES acc_accounts(id),
  debit_cents  INTEGER NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  memo         TEXT
);
CREATE INDEX idx_acc_lines_entry ON acc_journal_lines (entry_id);
CREATE INDEX idx_acc_lines_account ON acc_journal_lines (account_id);
