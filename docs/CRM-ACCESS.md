# AMO Schedule App — access guide for the CRM

> **Purpose.** Hand this file to the AI of your CRM so it can work out the steps (and the data) needed to
> reach the schedule app. It is kept up to date with the app: the date and the change log at the bottom say
> what changed last. **Never paste secrets into this file.**

Last updated: 2026-11-03 · App version: draft/publish schedules (migration 0037) and later.

## 1. What the app is

| | |
|---|---|
| Name | AMO Schedule App (bilingual FR/EN staff scheduling for restaurants) |
| Production URL | `https://mikes.andrewmurphy.online` |
| Stack | Cloudflare Worker (Hono, TypeScript) + D1 (SQLite) + static front end |
| Source | GitHub `andrewmurphy1978-design/AMO-Schedule-App` (auto-deploys from `main`) |
| Owner / platform admin | Andrew Murphy (`andrewmurphy1978@gmail.com`) |
| Clients (tenants) | One installation serves several client companies; client 1 = Mikes |

## 2. How people and systems authenticate today

There are **two human sign-in paths** and **API tokens for other systems (section 6)**:

1. **Cloudflare Access (currently in front of the site).** Cloudflare adds a signed header
   `Cf-Access-Jwt-Assertion` to every request. The app verifies its signature, issuer
   `https://small-dawn-0a02.cloudflareaccess.com` and audience tag
   `762341318b5a63148bf9875ab57bbf3cfe415d1166940862d72e8d684725b4a3` (public identifiers, not secrets), then reads the email.
2. **In-app sign-in (built, active when Access is removed or bypassed).**
   - `POST /api/auth/request` `{ "email": "...", "lang": "fr" }` → always answers `{ok:true}`; a 6-digit code is emailed (valid 10 min, 5 tries, max 5 codes/hour/address, 30 s between requests).
   - `POST /api/auth/verify` `{ "email": "...", "code": "123456" }` → sets an `sid` cookie (HttpOnly, Secure, SameSite=Lax, 30 days).
   - `POST /api/auth/logout` clears it.
   - Needs SMTP configured for the client (or for client 1 as the fallback). In production the SMTP relay is Brevo (IP restriction off, because Workers have no fixed IP).
   - `POST /api/auth/password` `{ "email", "password" }` → sets the same `sid` cookie. Always the same answer (`400 invalid_credentials`) for a wrong password or unknown address; 5 failures lock that address for 15 minutes (`429`). Passwords are PBKDF2-SHA256 hashes (table `login_passwords`), optional, set by the employee in Account → Security.
   - **Passkeys / biometrics** (Face ID, Touch ID, Android, Windows Hello; WebAuthn, discoverable credentials, user verification required): `POST /api/auth/passkey/options` then `POST /api/auth/passkey/verify` `{ cid, response }` → `sid` cookie. The relying-party id is the site's host name. Registered by the employee in Account → Security (`POST /api/account/passkeys/options`, `POST /api/account/passkeys`, `DELETE /api/account/passkeys/:id`); table `passkeys` stores only public keys.
   - `GET /api/account/security`, `PUT|DELETE /api/account/password`: the signed-in employee's own password/passkeys (never available to API tokens, like all of `/api/account`).
   - **First-time guidance (client side only, nothing is enforced by the API):** in a browser that can install the app, a new employee is offered the install (then "open it and sign in again"; shown again at most every 3 days until installed). Inside the installed app (standalone display mode) the app reports itself once with `POST /api/account/installed` (`staff.app_installed_at`, migration 0084, returned as `installed` by `GET /api/account/security`), offers biometrics (with a "Later" button; asked again after a day until done), then **requires a password** (non-dismissable dialog) when none is set. A browser that cannot install the app runs those same two steps in the browser. Google sign-in would exempt the password step, but does not exist.
   - Every method re-checks that the email is an **active employee** (or platform owner) of an active client at sign-in time.
   - `GET /api/admin/overview` staff rows carry `signed_in` (an unexpired browser session exists) and `last_seen_at` (`sessions.last_seen_at`, refreshed at most every 2 minutes); shown as a dot in Administration → Employés.

3. **API token (for the CRM).** `Authorization: Bearer ams_...` — see section 6. No cookie, no Cloudflare Access login needed once the site is reachable (see "Cloudflare Access" below).

For the two human paths, the **email must belong to an active employee** (`staff.email`) of some client. Unknown emails get `403 unknown_user`.
`ADMIN_EMAIL` / `SUPER_ADMIN_EMAILS` (Worker variables) are platform owners and are created automatically on first sign-in.

Local development only: `DEV_MODE=true` accepts an `X-Dev-User: email` header. **Never enabled in production.**

## 3. Roles and permissions (what an account can do)

| Role | How it is defined | Access |
|---|---|---|
| Platform owner | email listed in `ADMIN_EMAIL` or `SUPER_ADMIN_EMAILS` | Everything, all clients (`GET/POST /api/clients`, header `X-Client: <id>` to work inside one) |
| Client admin | `staff.is_admin = 1` | Whole client: employees, restaurants, targets, wages, payslips, messaging, branding |
| Manager | row in `managers` (restaurant + department) | Schedule of what they manage, time-off decisions, sick-call replacements |
| Employee | any active `staff` row | Own shifts, availability, time-off requests, pay slips, calendar |

Every request is checked against the caller's **client**: ids from another client answer `404`/`403`.

## 4. Data the CRM can reach (all JSON under `/api`)

Authenticated routes (cookie or Access JWT). `A` = admin only, `M` = admin or manager, others = any signed-in employee.

| Area | Routes |
|---|---|
| Identity | `GET /me` (me, client, managed restaurants, roles) |
| Employees | `GET /admin/overview` (A: staff, roles, managers, restaurants), `GET /staff` (M), `POST /staff` (A), `PUT /staff/:id` (A), `PUT /staff/:id/active\|admin\|wage\|sin\|limit\|planning` (A) |
| Restaurants | `GET /restaurants`, `POST /restaurants` (A, **API token only** — adding a restaurant is a paid add-on done by the CRM; refused with `crm_only` for signed-in people, super admins included), `PUT /restaurants/:id/hours\|breakfast` (A; `hours` also takes `delivery_times`, when delivery starts each weekday, until closing time), `POST /restaurants/:id/special-hours` (`date`, optional `end_date` = a closed/special range up to 60 days, e.g. a whole week), `DELETE /restaurants/:id/special-hours/:hid` (A; closed days / special hours, also returned as `special_hours` by `GET /restaurants`) |
| Visible schedules (admin) | `GET/PUT /staff/:id/view-access` `{custom, access:[{restaurant_id, department_id}]}`: which schedules an employee may look at (automatic = where they hold a role; custom = the ticked list). `GET /me` returns the effective `schedules` for non-administrators |
| Roles / posts | `GET /roles`, `GET /departments`, `GET /posts`, `POST/DELETE /staff-roles`, `POST/DELETE /managers` |
| Schedule | `POST /schedule/publish` `{restaurant_id, department_id, week, published, notify?}` (answers `{ok, published, notified}`) (admin / manager of that department; works with a write token), `GET /schedule?restaurant=&department=&week=YYYY-MM-DD(Monday)` (answer has `published` and `editable`), `GET /my-shifts?week=` (also `total_hours`, `gross_cents` = the caller's own gross pay for the week), `GET /roster`, `POST/PUT/DELETE /shifts` (M) |
| Shift reminders (own settings, never for API tokens) | `GET/PUT /account/reminders` (`items`: up to 5 × `{ minutes_before 5-2880, channel push\|sms\|email, anchor start\|end }`) |
| End-of-shift checklists | `GET /my-checklist` (own shifts to do now → `{ test, shifts }`), `PUT /admin/checklists/test-mode` (`on`), `GET /shifts/:id/checklist`, `POST/DELETE /shifts/:id/checklist/posts`, `PUT /shifts/:id/checklist/items`, `POST/DELETE /shifts/:id/checklist/done` ("Terminé": the employee closes the list even if tasks are not ticked; `checklist-report` rows carry `submitted`), `PUT /shifts/:id/checklist/issues` (`item_id`, `reason` missing_ingredient|other, `note`) and `DELETE /shifts/:id/checklist/issues/:itemId` (a task that could not be completed; kitchen managers get a push for a missing ingredient); kitchen managers: `PUT /closing-assignments` (`restaurant_id`, `date`, `task_id`, `staff_id`: give the day's closing task, the mop, to someone else; `/post-board` returns `closing`), `PUT /shifts/:id/closing/:taskId` (`done`; the person it was given to), `GET /post-board?restaurant=&date=` (kitchen shifts of a day with their posts and skills; each shift also carries `ranges` {postId:{start_at,end_at}}; posts are put on a shift with `POST /shifts/:id/checklist/posts` `{post_id, start_at?, end_at?}` (optional time range inside the shift, e.g. Pizza 11:00–15:00 then Pâtes 15:00–19:00; omitted = whole shift; invalid range → 400) and removed with `DELETE`), admin: `GET/PUT /admin/checklists`, `GET /admin/checklist-report?date=`; prep tasks assigned by a kitchen manager to a shift: `GET/POST /shifts/:id/prep` (`text`, `due_at`), `PUT /shifts/:id/prep/:taskId` (`done`, also the employee), `DELETE /shifts/:id/prep/:taskId`; checklist lists carry `due_at` (end of the post's time range = handover, else end of shift) and `/my-checklist` shifts carry `next_due`; the "shift ends soon" reminders also fire before each post handover; restocking: `GET /restock?restaurant=` (groups of ingredients with `needed`), `PUT /restock` (`restaurant_id`, `ingredient_ids`, `needed`) for admins, managers and kitchen/prep staff of the restaurant (`/my-checklist` returns `restock`: their restaurant ids); admin: `GET/PUT /admin/ingredients` (per restaurant groups → ingredients with a place: fridge|freezer|backstore|basement, and an optional `category`: pasta|meats|vegetables|fruits|dairy|sauces|cheeses|breads|pizza_dough|salads|mixes; `thaw` (freezer items to take out the day before → a "Dégeler pour demain" list for the last cook out, ticked with `PUT /shifts/:id/thaw/:ingredientId`), `homemade` + `components` (names) + `prep_note` + `portion_g` (weight of one portion, grams), `portion_qty` + `portion_unit` (a portion as a count, e.g. 2 tranches), `fridge_open` (back-store items that go in the fridge once opened)), `GET/PUT /admin/post-periods` (periods of the Postes screen, default or per restaurant; `/post-board` returns `periods`) |
| Web Push (a person's own devices, never for API tokens) | `GET /push/key`, `GET /push/status`, `POST/DELETE /push/subscribe`, `POST /push/test` |
| Suppliers and orders | `GET /admin/usage?month=YYYY-MM` (A: what Claude (tokens, computed cost of each AI schedule and pay-slip reading) and Twilio (texts, calls: price filled in by the cron from Twilio a few minutes after sending) cost, totals per kind + latest events), `GET/PUT /admin/suppliers` (A: name, phone, email, notes, `order_method` call|email|api, `customer_number`, `api_url` (https), `api_user`, `api_key` write-only: never returned, GET gives `api_key_set`; an edit without `api_key` keeps it, `clear_api_key` erases it; no automatic API ordering yet), ingredients carry `supplier_ids` (an ingredient can have several); kitchen staff / managers / admins: `GET /orders?restaurant=` (reported ingredients grouped by supplier, `can_order`, `ingredients` = what can be ordered: not the home-made ones), `POST /orders` (`restaurant_id`, `name`, `note`: an employee reports an ingredient to order; managers get a push), `PUT /orders/:id/ordered` (`supplier_id`; kitchen manager / admin), `DELETE /orders/:id` |
| Assisted phone calls | admins and employees with the `voice_assist` right (`PUT /staff/:id/voice-assist`, admin; `/me` returns `voice`); never with an API token: `GET /voice/contacts`, `GET/POST /voice/calls` (`staff_id` or `contact_id` — an admin-kept contact, `GET/POST/PUT/DELETE /admin/voice-contacts`; `lang`, `text` = first message read aloud), `GET /voice/calls/:id` (transcript), `POST /voice/calls/:id/say` (`text`), `POST /voice/calls/:id/hangup`. Twilio calls back the PUBLIC endpoints `POST /hooks/voice/:id/talk`, `/heard`, `/status` (signature checked with the client's Twilio token; they must be reachable without Cloudflare Access). Needs a voice-capable Twilio number and `APP_URL`. |
| Communities | `GET /communities` (the ones the caller belongs to: a role or a managed department of the group; admins see all), `GET/POST /communities/:id/posts` (`body`, optional `parent_id`, `media_ids`), `POST /communities/:id/media` (raw image/video body, 3 MB / 20 MB), `GET /community-media/:id` (Range supported), `DELETE /community-posts/:id` (author or moderator), `PUT /community-posts/:id/reaction` (`emoji` = any single emoji, `on`), `PUT /community-posts/:id/pin` (moderator), admin: `GET/POST /admin/communities`, `PUT/DELETE /admin/communities/:id` (`name`, `departments`) ; voice and video messages: `POST /communities/:id/media` also takes `audio/webm|mp4|ogg|mpeg|aac` (6 MB) and returns/serves a `transcript` made by Workers AI (binding `AI`) only when a deaf-and-mute member of the community will read it or the owner turned on `GET/PUT /admin/community-transcripts` (`all`); `PUT /staff/:id/deaf-mute` (admin; `/me` returns `deaf_mute`) |
| Targets | `GET/PUT /targets`, `PUT /targets/range`, `GET/POST/PUT/DELETE /target-sets` |
| Time off / availability | `/time-off*`, `/availability*` |
| Attendance file (admin) | `GET /staff/:id/attendance` → `{ absences, incidents, last_12_months }`; absences have `kind` = `announced` (declared before the shift began) / `late` (after it began) / `by_manager`, plus `reason`, `outcome` (open, filled, cancelled, shift_removed); incidents are no-show / late arrival / early departure entered by a manager (`POST /admin/incidents`: administrators and the manager of that employee's department; reading and deleting them is administrators only) |
| Absences / sick calls | `POST /shifts/:id/sick` `{reason?: sick\|medical\|family\|transport\|personal\|other, note?}` (the reason is shown only to managers/administrators and is not sent in webhooks), `GET /coverage`, `/coverage/:id/*` |
| Payroll (A) | `GET /admin/payroll`, `/admin/default-rates`, `/admin/payslips*`, `GET /payslips` |
| Messaging (A) | `GET/PUT /connections`, `POST /connections/test`, `GET /admin/notifications` |
| Branding (A) | `GET /auth/branding` (public; includes `country` CA/US/FR/BE/CH/OTHER, which sets "déjeuner" vs "petit-déjeuner" in the French screens), `PUT /admin/branding`, `PUT/DELETE /admin/branding/logo` |
| AI | `POST /admin/ai-schedule`, `/admin/ai-schedule/apply` |
| Clients (platform owner) | `GET /clients`, `POST /clients`, `PUT /clients/:id` |
| API tokens (admin, browser only) | `GET/POST /admin/tokens`, `DELETE /admin/tokens/:id` |
| Webhooks (admin, browser only) | `GET/POST /admin/webhooks`, `PUT/DELETE /admin/webhooks/:id`, `POST /admin/webhooks/:id/test`, `GET /admin/webhooks/:id/deliveries`, `POST .../deliveries/:did/retry`, `GET /webhooks/events` |

Public endpoints (no sign-in, secret token in the URL): `/cal/<token>.ics` (employee calendar feed),
`/r/<token>` and `POST /hooks/offer/<token>` (replacement offers), `POST /hooks/twilio` (inbound SMS, verified by Twilio signature).
These must be **bypassed in Cloudflare Access** (`/r/*`, `/hooks/*`, `/cal/*`) to work for people without an Access login.

Database: Cloudflare D1 `mikes-schedule-db` (id `c9c1e842-b5b7-4db2-97a5-907080a4715a`). Ownership: `restaurants.client_id` and `staff.client_id`; everything else hangs from those two.

## 5. What a CRM integration needs (decide and fill in)

The CRM's AI should ask the owner these questions and record the answers here (as placeholders, not secrets):

| Question | Answer |
|---|---|
| Direction: CRM reads schedule data, writes data, or both? | _to fill_ → choose token scope `read` or `write` |
| Which data: employees / shifts / time off / payroll? | _to fill_ |
| Which client(s) (id)? | _to fill_ (Mikes = 1). A token belongs to exactly one client. |
| Where the CRM stores the credential | _to fill_ (CRM secret store; never in git) |

## 6. API tokens (built)

**Create** (a client administrator, in the browser): Administration → **Accès API** → name (e.g. `CRM`) → permissions
`Lecture seule` (read) or `Lecture et écriture` (write) → **Créer le jeton**. The token (`ams_` + 43 characters) is shown **once**; copy it into the CRM's secret store.
Only a hash is kept; list shows name, scope, last 4 characters, creation date and last use. **Révoquer** kills it immediately (max 20 active per client).

**Use** (from the CRM):

```
GET https://mikes.andrewmurphy.online/api/admin/overview
Authorization: Bearer ams_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Rules:
- A token acts as an **administrator of its own client** (it can read wages and employee data of that client): treat it like a password.
- Scope `read` allows only `GET`/`HEAD`; any other method answers `403 {"error":"forbidden","reason":"token_is_read_only"}`.
- A token can **never** call: `/api/clients*`, `/api/admin/tokens*`, `/api/auth/*`, `/api/account*`, `/api/payslips*` (own pay slips of the person who created it). It cannot see another client's data (`404`).
- Invalid or revoked token: `401 {"error":"unauthenticated","reason":"invalid_token"}`. Disabled client: `403 client_inactive`.
- Dates/weeks: `week` is the Monday `YYYY-MM-DD`; shift times are local `YYYY-MM-DDTHH:MM` (restaurant time zone, `America/Toronto`).
- Typical CRM calls: `GET /api/admin/overview` (employees, roles, restaurants), `GET /api/schedule?restaurant=&department=&week=`, `GET /api/time-off/review`, `GET /api/admin/payroll?restaurant=&department=&week=`, `POST /api/staff`, `POST /api/shifts` (write scope).

**Cloudflare Access.** While Access protects the whole hostname, the CRM's request is stopped at Cloudflare *before* it reaches the app. Pick one:
1. Add an Access **bypass** policy for the path `/api/*` (the app still checks the Bearer token itself), or
2. Keep Access and create an Access **Service Token**; the CRM sends `CF-Access-Client-Id` + `CF-Access-Client-Secret` **and** the `Authorization: Bearer` header.

Other no-code options: personal iCalendar link per employee (`Mon compte → Calendrier`), a normal employee account for a person.

## 6b. Webhooks (built): the app tells the CRM when something changes

**Register** (client administrator, browser): Administration → **Webhooks** → name, receiving URL (**https**, public host; no IP addresses or local names), events (all or a selection) → **Créer**.
The **signing secret** (`whsec_...`) is shown once. Buttons: **Tester** (sends a `ping`), **Journal** (last 50 deliveries, **Renvoyer** a failed one), pause, new secret, delete. Max 10 endpoints per client.
Webhooks are managed by a signed-in person only, never with an API token.

**Events** (`data` always holds the current state of the object; never wages, SIN, pay slips or incidents):

| Event | When | `data` |
|---|---|---|
| `staff.created` | employee added | `{ staff: {id,name,first_name,last_name,email,phone,sex,lang,is_admin,active} }` |
| `staff.updated` | employee card saved | same |
| `staff.active_changed` | made active / inactive | same |
| `shift.created` / `shift.updated` | shift saved | `{ shift: {id,staff_id,restaurant_id,role_id,start_at,end_at,until_close,notes,status} }` |
| `shift.deleted` | shift removed | same (state just before deletion) |
| `schedule.applied` | AI schedule applied | `{ restaurant_id, week, created, removed }` |
| `schedule.published` / `schedule.unpublished` | a schedule (restaurant + department + week) published or taken back | `{ restaurant_id, department_id, week }` |
| `time_off.requested` | employee asks for leave | `{ time_off: {id,staff_id,start_date,end_date,start_time,end_time,status,note,decision_note} }` |
| `time_off.decided` | approved / denied (or entered already approved by a manager) | same |
| `time_off.updated` | dates, hours or note of a request changed (an approved leave changed by the employee goes back to `requested`) | same |
| `time_off.cancelled` | cancelled / withdrawn | same |
| `coverage.opened` | sick call, replacement search started | `{ request: {id,shift_id,restaurant_id,role_id,sick_staff_id,start_at,end_at,status,filled_by} }` |
| `coverage.filled` | a replacement accepted / assigned | same |
| `ping` | the **Tester** button | `{ message }` |

**Request** the CRM receives: `POST <your URL>`, `Content-Type: application/json`, body:

```json
{ "id": "uuid", "event": "shift.created", "created_at": "2026-10-28T14:03:11.000Z", "client_id": 1,
  "data": { "shift": { "id": 98, "staff_id": 12, "restaurant_id": 1, "role_id": 3, "start_at": "2026-11-02T10:00", "end_at": "2026-11-02T14:00", "until_close": 0, "notes": null, "status": "ok" } } }
```

Headers: `X-AMS-Event` (event name), `X-AMS-Delivery` (delivery number, use it to de-duplicate), `X-AMS-Signature: t=<unix seconds>,v1=<hex>`.

**Verify the signature** (reject if it does not match, or if `t` is more than 5 minutes old):

```js
// Node.js — rawBody must be the exact bytes received, before any JSON parsing
const crypto = require("crypto");
function verify(rawBody, header, secret) {
  const [t, v1] = header.split(",").map((p) => p.split("=")[1]);
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return expected.length === v1.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

**Delivery rules:** answer with any `2xx` within 8 seconds. Otherwise the app retries after 5 min, 15 min, 1 h, 6 h, 24 h (6 attempts in all), then marks it failed (it can be resent from the Journal). 30 failed deliveries in a row switch the endpoint off. Delivery is **at least once** and not strictly ordered: de-duplicate with `X-AMS-Delivery`, and when order matters re-read the object (`GET /api/...`) or compare `created_at`.
Redirects are not followed. Events of one client only ever go to that client's endpoints.

## 6c. Draft and published schedules

A schedule is one **restaurant + department + week (Monday)**. New schedules are **drafts**: only administrators and the managers of that department
(and API tokens, which act as administrators) can see their shifts. Employees do not see them in the schedule view, in "my shifts" or in their calendar feed until someone
clicks **Publier** (or calls `POST /api/schedule/publish`). A shift follows the publication state of the department of its **main role**.
Everything planned before this feature existed was marked published automatically. Taking a schedule back (`published:false`) hides it again.
When a schedule goes from draft to published, every active employee who has a shift in it is told by SMS or email (their preferred channel and language), unless `notify:false` is sent (the browser has a "Notifier les employés" checkbox). Publishing an already-published schedule does not notify again.
**Publishing is refused** with `409 {"error":"conflicts","count":n}` while anybody on that schedule is booked twice at the same time (any restaurant or department); fix the shifts first. (Staffing shortages/surpluses are only a warning in the browser; the API does not check them.) Unpublishing is always allowed.
Webhooks (`shift.*`, `schedule.*`) are sent for drafts too (the CRM is an administrator-level reader); use `schedule.published` to know when employees can see a week.

## 7. Gaps / proposed work

- [x] API tokens per client (read/write, revocable, hashed).
- [ ] Per-token restriction to areas (e.g. employees only, no wages) and to restaurants.
- [x] Webhooks out of the app (section 6b).
- [ ] Rate limits and an audit log of API calls.
- [ ] Pagination / `updated_since` filters for large exports.

Tell the maintainer which of these the CRM needs and this file will be updated.

## 8. Operational notes

- Production database is migrated automatically on the first request after a deploy. A failed migration returns `500` on every page.
- Messaging (Twilio, SMTP), Google and AI calls have only been tested against fake local servers so far.
- Cloudflare dashboard tasks still manual: Access bypass for `/r/*`, `/hooks/*`, `/cal/*`; custom hostnames per client.

## 9. Change log

| Date | Change |
|---|---|
| 2026-11-03 | **Administration → Véhicules** (under Restaurants): every vehicle of the company on one screen with its tasks (tire change due, open problems) and its whole history (problems reported, fixes with notes, tire changes), filters by restaurant / open problems / tires to change, add / edit a vehicle, record a tire change, take on and fix a problem, and the tire reminder settings (moved here from Lists → Vehicles). `GET /api/admin/vehicles` (administrators only). In **Lists**, a phone shows icon-only tabs (✅ 📦 🥣 🛒 🚗) so they all fit. |
| 2026-11-03 | **Time off can be edited until its dates are over**: `PUT /api/time-off/:id` `{ start_date, end_date, start_time?, end_time?, note }` (the employee on their own requests; managers and administrators on those they decide for). Refused (`409 in_the_past`) when the leave's dates are all over, `409 not_editable` for a denied one, `404` for a cancelled one, `409 already_requested` when it would overlap another leave; a leave already under way keeps its start date (no move into the past). An approved leave changed by the employee goes back to `requested` (approval cleared, approvers told); a manager's or administrator's change keeps it approved and tells the employee. New webhook event `time_off.updated`. Employees see a ✎ Edit button in Mon compte → Congés. |
| 2026-11-03 | **Mon compte on a phone**: the tabs are icons only, the screens are compact (Détails and Sécurité fit one screen, sections fold), each shift reminder is on one line (the "from the start / end of the shift" field is gone: the two add buttons "Shift start" / "Shift end" set it), the reminder channel reads "Notifications", and the Google Calendar button is centred. |
| 2026-11-03 | **Communities work exactly like Messages**: a computer shows the boards on the left (with the last post and an unread count) and the chosen board on the right; a phone shows the list (search behind a magnifier), then a full-screen feed with a back arrow. In a board, the posts are on top (the newest at the bottom, pinned posts in a strip above) and the Messenger-style write bar (round icons, thumbs-up, ➤) is at the bottom, the same component as in Messages. `GET /api/communities` also returns `last_body`, `last_by` and `last_media` of each board. |
| 2026-11-03 | **Sign-in tweaks**: the installed app (standalone display mode) always opens the usual sign-in page (passkey / password / code) instead of the first-connection page. Passkey registration (`POST /api/account/passkeys/options`) now asks for the device's own authenticator (`authenticatorAttachment: "platform"`, hint `client-device`) so Windows Hello / Face ID / fingerprint is offered directly instead of the phone / security-key passkey dialog; passkeys already registered keep working. |
| 2026-11-03 | **Two sign-in pages** (no API change): a first-connection page (e-mail only + « Recevoir un code par courriel », then the 6-digit code) and the usual page (passkey / e-mail + password / code). The browser opens the first one until a sign-in has succeeded on it (flag `amo_login_seen` in localStorage), then the usual one; each page links to the other. |
| 2026-11-03 | **Inventory: several quantities per product, packaging and families** (migration 0092: `ingredients.inv` JSON, `inventory_lines.parts` JSON). Ingredients (`GET/PUT /api/admin/ingredients`, item field `inv`) carry optional packaging data: `family` (related products shown together), `base_unit`, `pack_unit`, `pack_qty` (units per package), `pack_weight` / `unit_weight` (kg), `min_qty` (units), `pack_cost`, `sku`. `PUT /api/inventory/:id/lines` now takes `parts: [{ q, u: "pack"|"unit"|"other", label? }]` per product (e.g. 3 bundles + 40 boxes); the server stores the list and the total in base units (`qty`, packages × `pack_qty`; "other" units are kept but not added); an empty `parts` list removes the line. `GET /api/inventory` returns each item's `inv` and each open line's `parts`. |
| 2026-11-03 | **Inventory (stock taking)** (migration 0091, tables `inventory_counts`, `inventory_lines`): new « Inventaire » tab in Lists for anyone with access to the restaurant's Restock lists. `GET /api/inventory?restaurant=ID` (the ingredients to count — one per distinct name, with place and category —, the open count with its lines, the last finished count for comparison, and the history), `POST /api/inventory/start` `{ restaurant_id }` (opens the single shared count of the restaurant or returns the open one), `PUT /api/inventory/:id/lines` `{ lines: [{ key, name, location, category, qty (null removes the line), unit }] }` (saved as you type), `POST /api/inventory/:id/complete` `{ note? }` (`422 empty_count` when nothing was counted), `DELETE /api/inventory/:id` (cancel an open count), `GET /api/inventory/:id` (one count with its lines). A finished count is read-only (`409 already_done`). Tenant-guarded by the restaurant. |
| 2026-11-03 | **Send an order by email**: `POST /api/orders/email` `{ restaurant_id, supplier_id }` (administrators and kitchen managers of the restaurant) emails the supplier (its `email`) the open orders linked to it, signed with the sender's name/phone/email, then marks them ordered. Errors: `422 no_supplier_email | nothing_to_order | email_not_configured`, `502 send_failed`. A ✉️ button on each supplier group in the Orders screen. |
| 2026-11-03 | **Contacts for assisted calls** (migration 0090, table `voice_contacts`): administrators keep extra people the owner can phone besides the team (suppliers, repairers…): `GET/POST /api/admin/voice-contacts`, `PUT/DELETE /api/admin/voice-contacts/:id` (`name`, `label`, `phone`, `lang`, `notes`; administrators only, tenant-guarded). `GET /api/voice/contacts` now also returns `extra` (id, name, label, lang, last 4 digits of the phone); `POST /api/voice/calls` accepts `contact_id` in place of `staff_id`. New Administration → Restaurants → « Contacts d'appel » section. The assisted-call screen has two top tabs (📞 Call / 🛒 Orders — the same orders screen as in Lists); a supplier whose ordering method is "call" (Administration → Ingredients → Suppliers) gets a button that opens a call to its phone number (`phone` in `POST /api/voice/calls`) with the order list pre-typed. |
| 2026-11-03 | **Messages and Communities, Messenger-style buttons** (migration 0089): in Messages, photos, videos and voice messages (`POST /api/messages/threads/:id/media`, served only to the members at `GET /api/messages/media/:id`, deleted with the message; transcript for voice and video when a member is deaf and mute, like Communities), reactions (`PUT /api/messages/messages/:id/reaction`) and replies (`reply_to` in `POST /api/messages/threads/:id/messages`, `media_ids` too); the write bar folds its round icons into "›" when typing, shows a 👍 quick-send when empty. On a message or a post, the actions (react, reply, pin, delete) are in a hover toolbar on a computer and in a long-press sheet on a phone instead of permanent buttons. A new conversation's first message is text only (files need an existing conversation). |
| 2026-11-03 | **Communities on a phone**: nothing overflows the width any more (320 to 400 px checked); the post box shows icons only (📎 ➤) so its line takes less room; in Messages the conversations start at the top and "new message" / "new group" are round buttons at the bottom of the screen, like Messenger. |
| 2026-11-03 | **Messages, Messenger-style**: a computer shows the conversations on the left and the chosen one on the right; a phone shows the list, then a full-screen chat with a back arrow and the message bar at the bottom. "New message" picks ONE colleague (private conversation); when an administrator allows groups (default: off), a separate "New group" button picks two or more people, and the group then shows in the list like any conversation. |
| 2026-11-03 | **SMS text cleaning** (`src/sms.ts`): every SMS (sent by the app, and the reply to an incoming SMS) is cleaned before it is sent: emojis removed; curly apostrophes, « », "…", dashes, "·", non-breaking spaces replaced by plain characters, so a text of standard GSM characters costs one segment per 160 characters instead of 70. The letters ê â î ô û ç are kept on purpose (such a message still counts as Unicode). The notification log keeps the cleaned text. |
| 2026-11-03 | **Messages: who can write to whom** (setting `dm_settings`, Administration → Communautés): the list of colleagues offered in Messages follows the person's restaurant(s) and department(s) (roles and managed departments): `department` (same restaurant AND department, default), `restaurant` (same restaurant) or `all` (every restaurant); administrators see everyone and everyone can write to administrators; groups: `off` (default: private conversations only), `managers` (managers and administrators) or `all`; `max_group` 3 to 50 (creator included). Enforced on the server (`403 not_reachable`, `403 groups_not_allowed`, `400 invalid_members`); conversations already started stay open when the setting shrinks. `GET /api/messages/people` now returns `{ people, can_group, max_group, scope, groups }`; `GET|PUT /api/admin/messages-settings`. The Communities screen has two tabs at the top: Communities and Messages. |
| 2026-11-03 | **Connected devices** (migration 0088, Account → Security): each browser session now records the device and browser (from the User-Agent), how it signed in (`code`, `password` or `passkey`), its last activity, and whether it runs the installed app (`standalone`, set by `POST /api/account/installed`); passkeys record `last_used_device`. `GET /api/account/security` also returns `sessions`; `DELETE /api/account/sessions/:id` signs one device out (own sessions only; the id is the first 16 characters of the session hash), `POST /api/account/sessions/sign-out-others` keeps only the current one. No IP address is stored. |
| 2026-11-03 | **Delivery vehicles** (migration 0087, Lists → Vehicles): vehicles per restaurant with their tires (winter/summer), **problems reported by drivers** (type, severity urgent/normal, description; urgent = out of service until fixed; managers take on and fix with a note) and **tire-change reminders** before the Québec dates (defaults: winter tires on by December 1, back to summer tires from March 16, studded tires off by May 1; reminders 45/30/14/7/3/1 days before and on the day, only while a vehicle still has the wrong tires; recipients and channels configurable; table `vehicle_notices` keeps what was sent; cron `vehicleTick`). Access: administrators (all) and delivery managers can manage; employees holding a delivery role can see vehicles and report problems. Routes: `GET|POST /api/vehicles`, `PUT /api/vehicles/:id`, `POST /api/vehicles/:id/tires|issues`, `PUT /api/vehicle-issues/:id`, `GET|PUT /api/admin/vehicle-settings` (setting `vehicle_maintenance`); `GET /api/my-checklist` returns `vehicle_restaurants`, `GET /api/shifts/:id/checklist` returns `vehicle_report` (delivery shifts get a "Report a vehicle problem" button). Notification kinds `vehicle_issue`, `vehicle_issue_urgent`, `tire_reminder`. The delivery end-of-shift list already asks for fuel and a clean vehicle. |
| 2026-11-03 | **Personal messages** between employees (migration 0086): "Messages" tab inside Communities (one or more colleagues; a direct conversation is reused, groups can be named and left; own messages can be deleted; push notification; unread badge shared with the Communities tab). Routes `GET /api/messages/people|threads|unread`, `POST /api/messages/threads`, `GET /api/messages/threads/:id`, `POST /api/messages/threads/:id/messages|leave`, `DELETE /api/messages/messages/:id`. **Only the members can read a conversation: administrators cannot, and API tokens are refused on all of `/api/messages`** (personal data, like payslips). Limit: 30 messages per minute per person, 2000 characters, 20 people per conversation. |
| 2026-11-03 | **Automatic schedules** (migration 0085, Administration → Horaires automatiques). Every 5 minutes the cron (`autoScheduleTick`) checks, per client, the setting `auto_schedule` (JSON in the client's settings; default: Thursday from 02:00 local = night of Wednesday to Thursday, notice at 08:00): it creates **next week's draft schedules** with the AI, one restaurant × department at a time (never over a published schedule or shifts already planned; the shifts go through the same checks as `POST /api/admin/ai-schedule/apply`), logs the AI cost (`usage`, detail `… · auto`), then sends a **notice** (email and/or SMS, or each person's own channel) to the chosen people (default: administrators) at the chosen hour, and **reminders** (+1, +2, … days, at a chosen hour, to chosen people, until the week starts, only while something stays unpublished). Routes (admin, tokens allowed): `GET|PUT /api/admin/auto-schedule` (settings, candidates, last runs), `POST /api/admin/auto-schedule/run` (create now, no notice), `POST /api/admin/auto-schedule/regenerate` `{extra, scope, notify}` (replaces the unpublished drafts of the week with new ones made with extra instructions; published ones are never touched; restarts the reminders). Table `auto_schedule_runs` (one row per client and week). Notifications are logged with kinds `auto_schedule` and `auto_schedule_reminder`; webhook `schedule.applied` carries `auto: true`. |
| 2026-11-03 | **Welcome email** (link + first-time procedure, in the language of the employee's file) sent when an email address is added to or changed on an employee (`POST /api/staff`, `PUT /api/staff/:id`); `POST /api/staff/:id/welcome` (admin) sends it again and always answers 200 with `{ok:true}` or `{ok:false, error: no_email|inactive|email_not_configured|send_failed, detail?}`; `POST /api/staff` and `PUT /api/staff/:id` return the same object as `welcome` when they sent one. The employee dialog has a "Resend the welcome email" button and shows why a send failed. Logged in `notifications` with kind `welcome`. |
| 2026-11-03 | Changing an employee's email (`PUT /api/staff/:id`) now deletes the old address's sessions, password, passkeys and pending codes. |
| 2026-11-03 | **First-time guidance**: install offer in the browser, then biometrics + required password in the installed app (`POST /api/account/installed`, migration 0084). |
| 2026-11-03 | **Sign-in by password and by passkey/biometrics** (migration 0082), sign-in screen rebuilt, Account → Security tab; **signed-in indicator** on the employee list (`signed_in`, `last_seen_at`; migration 0083). Google/Apple sign-in deliberately not built (unknown emails would be refused anyway). |
| 2026-11-03 | Outgoing emails (login codes and notifications) now carry a sender display name (Branding "sender name", else the company name). In production the SMTP relay is Brevo (domain authenticated with DKIM/SPF/DMARC) instead of the IONOS mailbox; no secrets stored here. |
| 2026-10-30 | **Checklist: "could not complete" with the missing ingredients** (counts as handled, shown in the daily report, managers notified; migration 0053). Breakfast posts only offered on shifts overlapping breakfast hours. |
| 2026-10-30 | **Kitchen posts can be assigned for part of a shift** (optional `start_at`/`end_at` per post on `POST /shifts/:id/checklist/posts`; `ranges` in `/post-board`, `posts[].start_at/end_at` in `/schedule`; Postes timeline; migration 0054). |
| 2026-10-30 | **Handovers and prep tasks**: a post list is due when the person leaves the post (end of their time range, e.g. 17:00), with an end-reminder before it; handover summary on the Postes screen; prep tasks assigned per shift (`/shifts/:id/prep`, migration 0055). |
| 2026-10-30 | **Lists tab (end of shift + restock)**, ingredients per restaurant (Administration → Ingrédients, seeded for both restaurants), restock list sorted by place, Postes screen split in periods (Matin / Après-midi / Soir, configurable; migration 0056). |
| 2026-10-30 | **Ingredient categories** (migration 0057), ingredients can be renamed in the table view, restock screen groups each post's ingredients by category. |
| 2026-10-30 | **Community access per employee**: `GET/PUT /staff/:id/community-access` (admin; `custom` + `ids`, default = communities of their roles; managers keep those of their departments; migration 0058). `/communities` and push recipients follow it. |
| 2026-10-31 | **Ingredients**: edited in dialogs (views by post / category / table), freezer items can "must be thawed the day before" (end-of-shift list for the last cook out), home-made ingredients with components feed a "Préparation" list and the fetch list (migration 0059). |
| 2026-10-31 | Example home-made preparations added for both restaurants (migration 0060); the ingredients table is grouped by category. |
| 2026-10-31 | Ingredients: new home-made ingredient takes the base ingredient's category; portion weight (`portion_g`, grams + ounces in the UI, migration 0061); the ingredient dialog shows why it cannot be saved. |
| 2026-10-31 | Ingredients stored in the back store can be flagged "au frigo une fois ouvert" (`fridge_open`, migration 0062). |
| 2026-10-31 | A portion can also be a count (`portion_qty` + `portion_unit`, e.g. 2 slices), besides or instead of its weight (migration 0063). |
| 2026-10-31 | New ingredient category `fruits` (Bananes, Bleuets, Fraises, Framboises, Oranges, Salade de fruits moved to it; migration 0064). |
| 2026-10-31 | **"Terminé" button** on the end-of-shift list: close it with tasks left unticked (confirmation; unticked tasks stay in the day's report; end reminders stop; can be reopened; migration 0065). |
| 2026-10-31 | `GET /my-shifts` shifts now carry `colleagues` (names, hours, photo/colour and `department_id` of the other people working during the shift at the same restaurant, every department, published shifts only) whatever schedules the caller may open. |
| 2026-11-01 | **Assisted phone calls** (the owner types, the other person hears it read aloud by text-to-speech and answers out loud; the answer is transcribed and sent back as text on screen, push and SMS). New `/api/voice/*`, public `/hooks/voice/*`, `staff.voice_assist`, migration 0066. Faster tab changes (header data loads in the background). |
| 2026-11-01 | **Voice and video messages in communities** (recorded in the app), `staff.deaf_mute` (employee main info), text transcripts via Workers AI shown to deaf-and-mute people and, only if the owner turns it on, to everyone (migration 0067, `ai` binding in wrangler.jsonc). |
| 2026-11-01 | **Suppliers and "to order"**: suppliers per company (7 seeded for Mikes), several per ingredient, employees report missing ingredients (Listes → À commander, or "Rupture" in the fetch list), managers mark them ordered (migrations 0069, 0070). **Delivery start** per weekday in the hours (migration 0068). The admin entry "Messagerie et paramètres" is now "Paramètres". |
| 2026-11-01 | À commander: searchable ingredient drop-down (home-made ingredients excluded). Default suppliers by category: fruits / vegetables / salads → Duval, breads → the breakfast-bread supplier except the submarine buns → GFS (migration 0071). |
| 2026-11-01 | Ingredients are now called **Produits / Products** in the screens (API names unchanged). New place `cellar` (Cellier), new categories `dairy`, `beers`, `wines`, `spirits`; dairy products, eggs and margarine added for both restaurants in a "Réserve et général" group, supplier Bourassa added (migration 0072). |
| 2026-11-01 | Suppliers: order method (call / email / API), customer number, API address / user / key (key stored on the server, never sent back; migration 0073). |
| 2026-11-01 | Bar products from toujoursmikes.ca (9 beers, 12 wines) added to both restaurants in a "Bar" group (migration 0074). |
| 2026-11-01 | Produits table fits the screen width on a computer (no sideways scrolling; scrolls on a phone). |
| 2026-11-01 | **Costs**: every Claude call (schedules, pay slips) and every Twilio text/call is recorded with its cost (`usage_log`, migration 0076); Administration → Coûts. The product group "Réserve et général" is now "Service" (migration 0077). Pay-slip reading may use up to 2000 output tokens (was 400). |
| 2026-11-01 | New product group "Sortie du four" (after Entrées, linked to the kitchen post of the same name) for both restaurants; "+ Déjeuner (pains)" label under Entrées in the products table (migration 0078). |
| 2026-11-01 | New category `boxes` (Boîtes): boxes, trays, lids, bags and sauce containers in the posts that use them; pizza and sub boxes are made (folded) from a bundle ("Liasse") of each size; staff with a delivery role now also reach Listes (restock, preparation, to order) (migration 0079). |
| 2026-11-01 | Administration menu grouped: Personnel (Employés, Demandes de congé, Talons de paie, Incidents, Communautés, Cibles) and Restaurants (Restaurants et heures, Paramètres, Produits, Fin de quart, Coûts, Personnalisation, API). Boîtes products (not the folded boxes) linked to GFS (migration 0080). |
| 2026-11-01 | Administration menu: Fin de quart moved under Personnel; the two groups open and close like an accordion (one open at a time); product category drop-downs are in alphabetical order. |
| 2026-11-01 | The screens say **Ingrédients** again (the wording "Produits" was reverted); a new, empty **Produits** tab is kept in Administration → Restaurants for later use. New category `seafood` (Poissons et fruits de mer) with Goberge, Pétoncles and Crevettes nordiques (fish and seafood already listed moved to it); home-made products can give the quantity of each component (`component_qty`, migration 0081). |
| 2026-11-01 | **Closing task of the day** (the mop): removed from every kitchen post list, now one task a day given in turn to someone of the closing crew (last out, within 30 min) — whoever had it least recently; shown on the Postes screen where a manager can give it to someone else; migration 0075. |
| 2026-10-30 | **Kitchen posts per shift**: assigned by a manager in the shift editor or on the new "Postes" screen (day board), shown on the schedule; migration 0052. |
| 2026-10-30 | **End-of-shift reminder** (reminders can count from the end of the shift; sent only while the checklist is not done; migration 0051) and a checklist **test mode** (setting `checklist_test`: the tab shows at all times for the last/next 7 days' shifts). |
| 2026-10-30 | **End-of-shift checklists** per kitchen post and per role (waiter, dishwasher, delivery driver), editable in Administration; a header tab shows while the person is on shift (and up to an hour after) until the list is done; "last one out" items for the last driver; migration 0050. |
| 2026-10-30 | **Emoji picker and reactions** in communities (migration 0049). |
| 2026-10-30 | **Photos and videos in community posts** (stored in D1 in chunks; up to 4 per post; migration 0048). |
| 2026-10-30 | **Shift reminders** ("your shift starts in …", several per person, by push / SMS / email, published schedules only; sent by the 5-minute cron, never twice; migration 0047). |
| 2026-10-30 | **Web Push notifications** (phone / Windows / macOS notification panel): installable app (manifest + service worker), `/api/push/*`, VAPID keys generated on first use and kept in `settings`; sent for published schedules, replacement offers (also SMS/email), leave decisions/requests and community messages; migration 0046. |
| 2026-10-30 | **Communities** (message board per restaurant and group of departments, automatic membership through roles; migration 0045; a restaurant created by the CRM gets one "Équipe" community with every department). |
| 2026-10-29 | Special hours accept a date range (`end_date`, max 60 days) to close a whole week; the "Congés" screen moved into Mon compte (UI only). |
| 2026-10-29 | `POST /api/restaurants` restricted to API tokens (CRM); the "add restaurant" form is removed from Administration. |
| 2026-10-29 | **Closed days and special opening hours** per restaurant (`special_hours`, yearly or one date); the AI scheduler receives the week's effective hours and `closed_dates`; migration 0042. |
| 2026-10-29 | **Staffing targets** are now fixed 30-minute intervals (slot = start time, e.g. `08:30`); `PUT /api/targets/range` sets/clears one department's target for a time range of one layer; `PUT /api/restaurants/:id/periods` removed; migration 0041. |
| 2026-10-29 | **Draft / publish** schedules (per restaurant + department + week), `POST /api/schedule/publish`, events `schedule.published` / `schedule.unpublished`, migration 0037. New "Sommaire" tab in the Horaire screen. |
| 2026-10-28 | **Webhooks** (Administration → Webhooks; signed `POST`s, retries; migration 0036). |
| 2026-10-28 | **API tokens** (Administration → Accès API; `Authorization: Bearer ams_...`; read/write; migration 0035). |
| 2026-10-28 | File created. In-app sign-in, per-client branding, multi-client (clients, tenant guard), migration 0034 fix. |
