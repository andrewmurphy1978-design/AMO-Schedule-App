-- When an employee first opened the installed app (home-screen / desktop app), to guide the first-time setup.
ALTER TABLE staff ADD COLUMN app_installed_at INTEGER;
