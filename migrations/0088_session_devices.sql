-- Which device each browser session (and each passkey use) comes from, so the account can list "connected devices" and sign one out.
ALTER TABLE sessions ADD COLUMN device TEXT;
ALTER TABLE sessions ADD COLUMN browser TEXT;
ALTER TABLE sessions ADD COLUMN method TEXT;                       -- code | password | passkey
ALTER TABLE sessions ADD COLUMN standalone INTEGER NOT NULL DEFAULT 0;  -- 1 once seen inside the installed app
ALTER TABLE passkeys ADD COLUMN last_used_device TEXT;
