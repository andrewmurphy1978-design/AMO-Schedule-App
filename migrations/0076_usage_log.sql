-- What the paid services cost: every Claude call (tokens), every text message and every call of Twilio. Costs are in millionths of a dollar.
CREATE TABLE usage_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     INTEGER NOT NULL,
  kind          TEXT NOT NULL,          -- ai_schedule | payslip | sms | call
  provider      TEXT NOT NULL,          -- anthropic | twilio
  model         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  units         REAL,                   -- sms: segments | call: seconds
  cost_micro    INTEGER,                -- null = not known yet (Twilio tells the price a little after sending)
  currency      TEXT NOT NULL DEFAULT 'USD',
  ref           TEXT,                   -- Twilio sid
  detail        TEXT,
  staff_id      INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_usage_client ON usage_log (client_id, created_at);
CREATE INDEX idx_usage_pending ON usage_log (cost_micro, created_at);
