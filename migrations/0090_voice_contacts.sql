-- Extra people the hard-of-hearing owner can phone with assisted calls (suppliers, repairers...), kept by the administrators.
CREATE TABLE voice_contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id  INTEGER NOT NULL,
  name       TEXT NOT NULL,
  label      TEXT,
  phone      TEXT NOT NULL,
  lang       TEXT NOT NULL DEFAULT 'fr',
  notes      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_voice_contacts_client ON voice_contacts(client_id);
