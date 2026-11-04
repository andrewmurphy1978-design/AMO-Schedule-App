-- When a person first signed in to the app: Messages only offer people who have (it is kept after the browser session expires).
ALTER TABLE staff ADD COLUMN first_login_at INTEGER;
UPDATE staff SET first_login_at = (SELECT MIN(s.created_at) FROM sessions s WHERE lower(s.email) = lower(staff.email)) WHERE email IS NOT NULL AND email != '';
UPDATE staff SET first_login_at = COALESCE(first_login_at, (SELECT MIN(p.created_at) FROM passkeys p WHERE lower(p.email) = lower(staff.email))) WHERE first_login_at IS NULL AND email IS NOT NULL AND email != '';
UPDATE staff SET first_login_at = COALESCE(first_login_at, app_installed_at) WHERE first_login_at IS NULL AND app_installed_at IS NOT NULL;
