-- Outgoing webhooks: a client registers URLs (e.g. its CRM) and chooses the events it wants to be told about.
CREATE TABLE webhook_endpoints (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     INTEGER NOT NULL,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  secret        TEXT NOT NULL,             -- signs every delivery (HMAC-SHA256); shown once, rotatable
  events        TEXT NOT NULL,             -- JSON array of event names, or ["*"]
  active        INTEGER NOT NULL DEFAULT 1,
  failures      INTEGER NOT NULL DEFAULT 0, -- consecutive failed deliveries; the endpoint is switched off at 30
  created_by    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_webhook_endpoints_client ON webhook_endpoints(client_id);
CREATE TABLE webhook_deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id     INTEGER NOT NULL,
  event           TEXT NOT NULL,
  payload         TEXT NOT NULL,           -- the exact JSON body that is sent
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  response_code   INTEGER,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER
);
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, id);
