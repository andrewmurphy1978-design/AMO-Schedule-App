-- Password sign-in and passkeys (Face ID / Touch ID / Android biometrics / Windows Hello). Only hashes and public keys are stored.
CREATE TABLE login_passwords (
  email TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  fail_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_passkeys_email ON passkeys(email);
CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL,
  email TEXT,
  expires_at INTEGER NOT NULL
);
