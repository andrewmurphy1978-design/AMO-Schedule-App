# AMO Schedule App — access guide for the CRM

> **Purpose.** Hand this file to the AI of your CRM so it can work out the steps (and the data) needed to
> reach the schedule app. It is kept up to date with the app: the date and the change log at the bottom say
> what changed last. **Never paste secrets into this file.**

Last updated: 2026-10-28 · App version: draft/publish schedules (migration 0037) and later.

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
   - Needs SMTP configured for the client (or for client 1 as the fallback).

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
| Restaurants | `GET /restaurants`, `POST /restaurants` (A, **API token only** — adding a restaurant is a paid add-on done by the CRM; refused with `crm_only` for signed-in people, super admins included), `PUT /restaurants/:id/hours\|breakfast` (A), `POST /restaurants/:id/special-hours` (`date`, optional `end_date` = a closed/special range up to 60 days, e.g. a whole week), `DELETE /restaurants/:id/special-hours/:hid` (A; closed days / special hours, also returned as `special_hours` by `GET /restaurants`) |
| Visible schedules (admin) | `GET/PUT /staff/:id/view-access` `{custom, access:[{restaurant_id, department_id}]}`: which schedules an employee may look at (automatic = where they hold a role; custom = the ticked list). `GET /me` returns the effective `schedules` for non-administrators |
| Roles / posts | `GET /roles`, `GET /departments`, `GET /posts`, `POST/DELETE /staff-roles`, `POST/DELETE /managers` |
| Schedule | `POST /schedule/publish` `{restaurant_id, department_id, week, published, notify?}` (answers `{ok, published, notified}`) (admin / manager of that department; works with a write token), `GET /schedule?restaurant=&department=&week=YYYY-MM-DD(Monday)` (answer has `published` and `editable`), `GET /my-shifts?week=` (also `total_hours`, `gross_cents` = the caller's own gross pay for the week), `GET /roster`, `POST/PUT/DELETE /shifts` (M) |
| Shift reminders (own settings, never for API tokens) | `GET/PUT /account/reminders` (`items`: up to 5 × `{ minutes_before 5-2880, channel push\|sms\|email, anchor start\|end }`) |
| End-of-shift checklists | `GET /my-checklist` (own shifts to do now → `{ test, shifts }`), `PUT /admin/checklists/test-mode` (`on`), `GET /shifts/:id/checklist`, `POST/DELETE /shifts/:id/checklist/posts`, `PUT /shifts/:id/checklist/items`, `PUT /shifts/:id/checklist/issues` (`item_id`, `reason` missing_ingredient|other, `note`) and `DELETE /shifts/:id/checklist/issues/:itemId` (a task that could not be completed; kitchen managers get a push for a missing ingredient); kitchen managers: `GET /post-board?restaurant=&date=` (kitchen shifts of a day with their posts and skills; each shift also carries `ranges` {postId:{start_at,end_at}}; posts are put on a shift with `POST /shifts/:id/checklist/posts` `{post_id, start_at?, end_at?}` (optional time range inside the shift, e.g. Pizza 11:00–15:00 then Pâtes 15:00–19:00; omitted = whole shift; invalid range → 400) and removed with `DELETE`), admin: `GET/PUT /admin/checklists`, `GET /admin/checklist-report?date=` |
| Web Push (a person's own devices, never for API tokens) | `GET /push/key`, `GET /push/status`, `POST/DELETE /push/subscribe`, `POST /push/test` |
| Communities | `GET /communities` (the ones the caller belongs to: a role or a managed department of the group; admins see all), `GET/POST /communities/:id/posts` (`body`, optional `parent_id`, `media_ids`), `POST /communities/:id/media` (raw image/video body, 3 MB / 20 MB), `GET /community-media/:id` (Range supported), `DELETE /community-posts/:id` (author or moderator), `PUT /community-posts/:id/reaction` (`emoji` = any single emoji, `on`), `PUT /community-posts/:id/pin` (moderator), admin: `GET/POST /admin/communities`, `PUT/DELETE /admin/communities/:id` (`name`, `departments`) |
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
| 2026-10-30 | **Checklist: "could not complete" with the missing ingredients** (counts as handled, shown in the daily report, managers notified; migration 0053). Breakfast posts only offered on shifts overlapping breakfast hours. |
| 2026-10-30 | **Kitchen posts can be assigned for part of a shift** (optional `start_at`/`end_at` per post on `POST /shifts/:id/checklist/posts`; `ranges` in `/post-board`, `posts[].start_at/end_at` in `/schedule`; Postes timeline; migration 0054). |
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
