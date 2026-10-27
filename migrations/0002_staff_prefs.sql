-- Notification preferences (used by the SMS/email features later).
ALTER TABLE staff ADD COLUMN lang TEXT NOT NULL DEFAULT 'fr';
ALTER TABLE staff ADD COLUMN notify_channel TEXT NOT NULL DEFAULT 'sms';
