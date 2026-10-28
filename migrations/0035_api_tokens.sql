-- API tokens for other systems (a CRM, a script). Only the SHA-256 hash is stored; the token is shown once at creation.
CREATE TABLE api_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    INTEGER NOT NULL,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  hint         TEXT NOT NULL,                 -- last 4 characters, to recognise it in the list
  scope        TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  created_by   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX idx_api_tokens_client ON api_tokens(client_id);
