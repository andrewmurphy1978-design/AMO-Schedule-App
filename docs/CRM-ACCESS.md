# AMO Schedule App — access guide for the CRM

> **Purpose.** Hand this file to the AI of your CRM so it can work out the steps (and the data) needed to
> reach the schedule app. It is kept up to date with the app: the date and the change log at the bottom say
> what changed last. **Never paste secrets into this file.**

Last updated: 2026-10-28 · App version: API tokens (migration 0035) and later.

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
| Restaurants | `GET /restaurants`, `POST /restaurants` (A), `PUT /restaurants/:id/hours\|breakfast\|periods` (A) |
| Roles / posts | `GET /roles`, `GET /departments`, `GET /posts`, `POST/DELETE /staff-roles`, `POST/DELETE /managers` |
| Schedule | `GET /schedule?restaurant=&department=&week=YYYY-MM-DD(Monday)`, `GET /my-shifts?week=`, `GET /roster`, `POST/PUT/DELETE /shifts` (M) |
| Targets | `GET/PUT /targets`, `GET/POST/PUT/DELETE /target-sets` |
| Time off / availability | `/time-off*`, `/availability*` |
| Sick calls | `POST /shifts/:id/sick`, `GET /coverage`, `/coverage/:id/*` |
| Payroll (A) | `GET /admin/payroll`, `/admin/default-rates`, `/admin/payslips*`, `GET /payslips` |
| Messaging (A) | `GET/PUT /connections`, `POST /connections/test`, `GET /admin/notifications` |
| Branding (A) | `GET /auth/branding` (public), `PUT /admin/branding`, `PUT/DELETE /admin/branding/logo` |
| AI | `POST /admin/ai-schedule`, `/admin/ai-schedule/apply` |
| Clients (platform owner) | `GET /clients`, `POST /clients`, `PUT /clients/:id` |
| API tokens (admin, browser only) | `GET/POST /admin/tokens`, `DELETE /admin/tokens/:id` |

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

## 7. Gaps / proposed work

- [x] API tokens per client (read/write, revocable, hashed).
- [ ] Per-token restriction to areas (e.g. employees only, no wages) and to restaurants.
- [ ] Webhooks out of the app (shift created/changed, time off decided) for the CRM to subscribe to.
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
| 2026-10-28 | **API tokens** (Administration → Accès API; `Authorization: Bearer ams_...`; read/write; migration 0035). |
| 2026-10-28 | File created. In-app sign-in, per-client branding, multi-client (clients, tenant guard), migration 0034 fix. |
