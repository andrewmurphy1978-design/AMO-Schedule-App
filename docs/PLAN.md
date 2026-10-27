# AMO Schedule App — plan

Staff scheduling for restaurants. Bilingual (FR default for admin/testing, EN). Mobile-first AND desktop.

## Deployment model
One deployment per client (same code, own Worker, own D1 database, own secrets, own Twilio/mail
credentials). First instance: `mikes.andrewmurphy.online`. A client can later move to their own domain,
or stay hosted on andrewmurphy.online. One client may own several restaurants.

## Roles and permissions (done)
- Admin: everything.
- Manager: edits specific (restaurant, department) schedules; may hold several.
- Employee: views the full schedule of each (restaurant, department) where they hold a role; their own
  shifts everywhere.
- A person may hold roles in several departments/restaurants. Shifts may not overlap across any of them.
- Weeks run Monday–Sunday. Times are naive local restaurant time.

## To build
1. Screens (mobile list-by-day, desktop week grid), FR/EN.
2. Notifications
   - Per-employee channel: SMS (Twilio) or email.
   - SMS: Twilio. Dev uses Andrew's account; each client gets their own (account SID/token/number as secrets).
   - Email: Gmail API OR generic IMAP/SMTP (configurable per deployment).
3. Sick-call replacement
   - Employee reports sick -> manager is notified immediately (information only).
   - App texts/emails ALL eligible replacements at once (same role at that restaurant, free at that time).
   - First to accept gets the shift (accept must be atomic: only one winner).
   - Setting: allow replacements to exceed their weekly hours (on/off).
   - If nobody accepts within a timeout -> second message to manager: action required.
4. Google Calendar sync: each employee connects their own Google account; their shifts are pushed to
   their calendar and kept updated.
5. Pay slips: PDFs stored in private R2; served only after verifying the logged-in user is the slip owner.
   Upload limited to admin / a designated payroll person.

## Deploy checklist
- Cloudflare Access application protecting the hostname; set secrets ACCESS_TEAM_DOMAIN, ACCESS_AUD, ADMIN_EMAIL.
- Never set DEV_MODE outside `.dev.vars`.
- Deploy command: `npm run deploy` (applies D1 migrations, then `wrangler deploy`).
