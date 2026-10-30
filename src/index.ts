import { Hono, type Context } from "hono";
import { ensureMigrated } from "./migrate.ts";
import { fetchAccessKeys, verifyAccessJwt } from "./access.ts";
import { findOverlaps, SHIFT_TIME_RE } from "./conflicts.ts";
import { weekBounds } from "./week.ts";
import { computeCosts, parseRate } from "./payroll.ts";
import { parseSettings, validateSettingsPatch, type Settings } from "./settings.ts";
import { normalizePhone } from "./phone.ts";
import { SYSTEM_PROMPT, buildUserPrompt, parseProposal, checkProposal, callClaude, type AiContext } from "./aischedule.ts";
// @ts-ignore plain JS module shared with the browser
import { DEFAULT_BOUNDARIES, GRID_KEYS, hoursFor } from "../public/coverage.js";
// @ts-ignore plain JS module shared with the browser
import { resolveForDate } from "../public/rules.js";
// @ts-ignore plain JS module shared with the browser
import { splitName, joinName, genderedRole } from "../public/names.js";
import { loadConnections, deliver, notifyStaff, type StaffContact } from "./notify.ts";
import { getVapid, pushToStaff } from "./push.ts";
import { listsForShift, progress as checklistProgress } from "./checklists.ts";
import { sendShiftReminders, REMINDER_CHANNELS, MAX_REMINDERS } from "./reminders.ts";
import { publicConnectionView } from "./connections.ts";
import { verifyTwilioSignature } from "./twilio.ts";
import { T, formatWhen, formatDate, ABSENCE_REASONS, type Lang } from "./templates.ts";
import { answerOffer, cancelRequest, escalateDue, fillRequest, gatherCandidates, startSickCall, FlowError } from "./sick.ts";
import { newApiToken, bearerToken, tokenForbidden, MAX_ACTIVE_TOKENS, CODE_TTL_MS, SESSION_TTL_MS, MAX_ATTEMPTS, MAX_CODES_PER_HOUR, MIN_GAP_MS, COOKIE_NAME, sha256Hex, newCode, newSessionToken, codeHash, safeEqual, readCookie, sessionCookie, clearCookie, looksLikeEmail, loginMessage } from "./auth.ts";
import { EVENTS, MAX_ENDPOINTS, queueEvent, flushDeliveries, validateUrl, validateEvents, newSecret, staffData, shiftData, timeOffData, coverageData, type EventName } from "./webhooks.ts";
import { parseBrand, validateBrandPatch, senderAddress, LOGO_TYPES, MAX_LOGO_BYTES, type Brand } from "./brand.ts";
import { settingKey, clientSettingRows, getSetting, putSettingStmt, delSettingStmt } from "./tenant.ts";
import { loadSettingsFrom } from "./settings-db.ts";
import { localNow, mondayOfDate } from "./week.ts";
import { overlapsTimeOff, findUnavailable, type Unavailable } from "./availability.ts";
import { normalizeSin, hashSin, chooseMatch, extractPayslip, isPdf, bytesToBase64, MAX_PDF_BYTES } from "./payslip.ts";

type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  // Production: Cloudflare Access team domain (e.g. "myteam.cloudflareaccess.com") and application AUD tag.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  // Email of the first admin; created automatically on first login if no such staff row exists.
  ADMIN_EMAIL?: string;
  // Platform owners (comma-separated emails): can create clients and switch between them.
  SUPER_ADMIN_EMAILS?: string;
  // Local development ONLY (set in .dev.vars, never in production).
  DEV_MODE?: string;
  DEV_USER_EMAIL?: string;
  // Public address of the app (used in links sent by SMS/email) and the restaurants' time zone.
  APP_URL?: string;
  TIMEZONE?: string;
  // Optional secrets: key to read pay slip PDFs with Claude, and the key used to hash Social Insurance Numbers.
  ANTHROPIC_API_KEY?: string; SIN_KEY?: string; ANTHROPIC_API_BASE?: string;
  // Optional: messaging credentials as environment secrets (otherwise they are saved from the Administration screen).
  TWILIO_ACCOUNT_SID?: string; TWILIO_AUTH_TOKEN?: string; TWILIO_FROM?: string; TWILIO_API_BASE?: string;
  SMTP_HOST?: string; SMTP_PORT?: string; SMTP_SECURE?: string; SMTP_USER?: string; SMTP_PASS?: string; SMTP_FROM?: string;
};

interface Me {
  id: number;
  name: string;
  email: string;
  is_admin: boolean;
  client_id: number;
  via_token?: boolean; // signed in with an API token (never allowed to manage tokens or clients)
  home_client: number; // the client the person belongs to (client_id changes when a platform owner works inside another one)
  is_super: boolean;
}

type Vars = { me: Me };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---------- Auth ----------
// Production identity comes from the signed Cloudflare Access JWT. If Access is not configured
// the API refuses every request (fail closed) rather than trusting a forgeable header.
async function identify(c: Context<any>): Promise<{ email?: string; reason?: string }> {
  if (c.env.DEV_MODE === "true") {
    const e = (c.req.header("X-Dev-User") ?? c.env.DEV_USER_EMAIL ?? "").toLowerCase();
    return e ? { email: e } : { reason: "no_dev_user" };
  }
  // 1) In-app session (cookie set after the emailed one-time code was entered).
  const sid = readCookie(c.req.header("cookie"), COOKIE_NAME);
  if (sid) {
    const s = await (c.env.DB as D1Database).prepare("SELECT email FROM sessions WHERE token_hash = ? AND expires_at > ?").bind(await sha256Hex(sid), Date.now()).first<{ email: string }>();
    if (s) {
      // Cookie-authenticated writes must come from this site (CSRF defence on top of SameSite=Lax).
      const origin = c.req.header("origin");
      if (c.req.method !== "GET" && c.req.method !== "HEAD" && origin && new URL(origin).host !== new URL(c.req.url).host) return { reason: "bad_origin" };
      return { email: s.email };
    }
  }
  // 2) Cloudflare Access (still honoured when it is configured in front of the app).
  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud } = c.env;
  if (!team || !aud) return { reason: "no_session" };
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) return { reason: "no_jwt" };
  try {
    const email = await verifyAccessJwt(token, { keys: await fetchAccessKeys(team), aud, issuer: `https://${team}` });
    return email ? { email } : { reason: "jwt_invalid" };
  } catch {
    return { reason: "keys_unavailable" };
  }
}

app.use("/api/*", async (c, next) => {
  await ensureMigrated(c.env.DB);
  if (c.req.path.startsWith("/api/auth/")) return next(); // sign-in endpoints are public
  // API token (another system): acts as an administrator of its own client, within its scope.
  const bearer = bearerToken(c.req.header("authorization"));
  if (bearer) {
    const tk = await c.env.DB.prepare("SELECT id, client_id, name, scope, created_by FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL").bind(await sha256Hex(bearer)).first<{ id: number; client_id: number; name: string; scope: string; created_by: number }>();
    if (!tk) return c.json({ error: "unauthenticated", reason: "invalid_token" }, 401);
    const client = await c.env.DB.prepare("SELECT active FROM clients WHERE id = ?").bind(tk.client_id).first<{ active: number }>();
    if (!client || client.active === 0) return c.json({ error: "client_inactive" }, 403);
    if (tokenForbidden(c.req.path)) return c.json({ error: "forbidden", reason: "not_for_tokens" }, 403);
    if (tk.scope === "read" && c.req.method !== "GET" && c.req.method !== "HEAD") return c.json({ error: "forbidden", reason: "token_is_read_only" }, 403);
    const now = Date.now();
    c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)").bind(now, tk.id, now - 60_000).run().then(() => {}));
    c.set("me", { id: tk.created_by, name: `API: ${tk.name}`, email: "", is_admin: true, client_id: tk.client_id, home_client: tk.client_id, is_super: false, via_token: true });
    return next();
  }
  const { email, reason } = await identify(c);
  if (!email) return c.json({ error: "unauthenticated", reason }, 401);
  let row = await c.env.DB.prepare("SELECT id, name, email, is_admin, active, client_id FROM staff WHERE lower(email) = ?")
    .bind(email)
    .first<{ id: number; name: string; email: string; is_admin: number; active?: number; client_id: number }>();
  if (!row && c.env.ADMIN_EMAIL && email === c.env.ADMIN_EMAIL.toLowerCase()) {
    // An admin record created without an email (e.g. by an import) is claimed by the first ADMIN_EMAIL login.
    row = await c.env.DB.prepare(
      "UPDATE staff SET email = ? WHERE id = (SELECT id FROM staff WHERE is_admin = 1 AND email IS NULL AND client_id = 1 ORDER BY id LIMIT 1) RETURNING id, name, email, is_admin, client_id",
    )
      .bind(email)
      .first<{ id: number; name: string; email: string; is_admin: number; client_id: number }>();
  }
  if (!row && c.env.ADMIN_EMAIL && email === c.env.ADMIN_EMAIL.toLowerCase()) {
    const r = await c.env.DB.prepare("INSERT INTO staff (name, first_name, email, is_admin) VALUES (?, ?, ?, 1)")
      .bind(email.split("@")[0], email.split("@")[0], email)
      .run();
    row = { id: r.meta.last_row_id as number, name: email.split("@")[0], email, is_admin: 1, client_id: 1 };
  }
  if (!row) return c.json({ error: "unknown_user", email }, 403);
  if (row.active === 0) return c.json({ error: "inactive", email }, 403); // deactivated employees cannot sign in
  const client = await c.env.DB.prepare("SELECT active FROM clients WHERE id = ?").bind(row.client_id).first<{ active: number }>();
  if (!client || client.active === 0) return c.json({ error: "client_inactive", email }, 403);
  const isSuper = superAdmins(c.env).includes(email);
  const me: Me = { id: row.id, name: row.name, email: row.email, is_admin: row.is_admin === 1, client_id: row.client_id, home_client: row.client_id, is_super: isSuper };
  // A platform owner can work inside any client (X-Client header): there they act as that client's administrator.
  const want = Number(c.req.header("X-Client"));
  if (isSuper && want && want !== me.client_id) {
    if (!(await c.env.DB.prepare("SELECT 1 FROM clients WHERE id = ?").bind(want).first())) return c.json({ error: "unknown_client" }, 404);
    me.client_id = want; me.is_admin = true;
  }
  c.set("me", me);
  await next();
});

const superAdmins = (env: Env) => [env.SUPER_ADMIN_EMAILS, env.ADMIN_EMAIL].flatMap((v) => (v ?? "").split(",")).map((x) => x.trim().toLowerCase()).filter(Boolean);

// Webhooks: queue the event for the client's endpoints and send it in the background. Never breaks the request.
const emitTo = (c: Context<any>, clientId: number, event: EventName, build: () => Promise<unknown>) =>
  c.executionCtx.waitUntil((async () => {
    try { await queueEvent(c.env.DB, clientId, event, await build()); await flushDeliveries(c.env.DB); } catch { /* webhooks never break a request */ }
  })());
const emit = (c: Context<any>, event: EventName, build: () => Promise<unknown>) => emitTo(c, (c.get("me") as Me).client_id, event, build);

// ---------- Tenant guard ----------
// Every id that arrives in the path, the query string or a JSON body must belong to the caller's client.
// (Lists and aggregates are filtered by client in their own queries.)
type Owned = "staff" | "restaurant" | "shift" | "target_set" | "time_off" | "availability" | "coverage" | "payslip" | "incident" | "community" | "community_post" | "community_media";
const OWNER_SQL: Record<Owned, string> = {
  staff: "SELECT 1 FROM staff WHERE id = ?1 AND client_id = ?2",
  restaurant: "SELECT 1 FROM restaurants WHERE id = ?1 AND client_id = ?2",
  shift: "SELECT 1 FROM shifts sh JOIN restaurants r ON r.id = sh.restaurant_id WHERE sh.id = ?1 AND r.client_id = ?2",
  target_set: "SELECT 1 FROM target_sets t JOIN restaurants r ON r.id = t.restaurant_id WHERE t.id = ?1 AND r.client_id = ?2",
  time_off: "SELECT 1 FROM time_off_requests t JOIN staff s ON s.id = t.staff_id WHERE t.id = ?1 AND s.client_id = ?2",
  availability: "SELECT 1 FROM staff_availability t JOIN staff s ON s.id = t.staff_id WHERE t.id = ?1 AND s.client_id = ?2",
  coverage: "SELECT 1 FROM coverage_requests t JOIN restaurants r ON r.id = t.restaurant_id WHERE t.id = ?1 AND r.client_id = ?2",
  payslip: "SELECT 1 FROM payslips WHERE id = ?1 AND client_id = ?2",
  incident: "SELECT 1 FROM incidents t JOIN staff s ON s.id = t.staff_id WHERE t.id = ?1 AND s.client_id = ?2",
  community: "SELECT 1 FROM communities c JOIN restaurants r ON r.id = c.restaurant_id WHERE c.id = ?1 AND r.client_id = ?2",
  community_media: "SELECT 1 FROM community_media m JOIN communities c ON c.id = m.community_id JOIN restaurants r ON r.id = c.restaurant_id WHERE m.id = ?1 AND r.client_id = ?2",
  community_post: "SELECT 1 FROM community_posts p JOIN communities c ON c.id = p.community_id JOIN restaurants r ON r.id = c.restaurant_id WHERE p.id = ?1 AND r.client_id = ?2",
};
const PATH_OWNERS: [RegExp, Owned][] = [
  [/^\/api\/staff\/(\d+)(\/|$)/, "staff"], [/^\/api\/time-off\/staff\/(\d+)$/, "staff"], [/^\/api\/admin\/staff\/(\d+)\//, "staff"],
  [/^\/api\/restaurants\/(\d+)\//, "restaurant"], [/^\/api\/target-sets\/(\d+)$/, "target_set"], [/^\/api\/shifts\/(\d+)(\/|$)/, "shift"],
  [/^\/api\/time-off\/(\d+)\/(cancel|withdraw|decide)$/, "time_off"], [/^\/api\/availability\/(\d+)$/, "availability"],
  [/^\/api\/coverage\/(\d+)\//, "coverage"], [/^\/api\/admin\/payslips\/(\d+)(\/|$)/, "payslip"], [/^\/api\/payslips\/(\d+)\/pdf$/, "payslip"],
  [/^\/api\/admin\/incidents\/(\d+)$/, "incident"],
  [/^\/api\/communities\/(\d+)(\/|$)/, "community"], [/^\/api\/admin\/communities\/(\d+)$/, "community"], [/^\/api\/community-posts\/(\d+)(\/|$)/, "community_post"], [/^\/api\/community-media\/(\d+)$/, "community_media"],
];
const QUERY_OWNERS: [string, Owned][] = [["restaurant", "restaurant"], ["restaurant_id", "restaurant"], ["staff", "staff"], ["staff_id", "staff"]];
const BODY_OWNERS: Record<string, Owned> = { restaurant_id: "restaurant", restaurant: "restaurant", staff_id: "staff", sick_staff_id: "staff", shift_id: "shift", set_id: "target_set" };

function collectBodyIds(v: unknown, out: [Owned, number][], depth = 0) {
  if (depth > 6 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) { for (const x of v.slice(0, 2000)) collectBodyIds(x, out, depth + 1); return; }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const kind = BODY_OWNERS[k];
    // 0 means "none" (e.g. set_id 0 = the base targets): there is nothing to own
    if (kind && typeof x === "number" && Number.isInteger(x)) { if (x > 0) out.push([kind, x]); }
    else if (kind && typeof x === "string" && /^\d+$/.test(x)) { if (Number(x) > 0) out.push([kind, Number(x)]); }
    else collectBodyIds(x, out, depth + 1);
  }
}

app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/")) return next();
  const me = c.get("me"), db = c.env.DB;
  const checks: [Owned, number][] = [];
  for (const [re, kind] of PATH_OWNERS) { const m = re.exec(c.req.path); if (m) checks.push([kind, Number(m[1])]); }
  for (const [name, kind] of QUERY_OWNERS) { const v = c.req.query(name); if (v && /^\d+$/.test(v)) checks.push([kind, Number(v)]); }
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && (c.req.header("content-type") ?? "").includes("json")) {
    try { collectBodyIds(await c.req.raw.clone().json(), checks); } catch { /* the route reports bad JSON itself */ }
  }
  for (const [kind, id] of checks) if (!(await db.prepare(OWNER_SQL[kind]).bind(id, me.client_id).first())) return c.json({ error: "not_found" }, 404);
  await next();
});

// ---------- Permission helpers ----------
async function canManage(db: D1Database, me: Me, restaurantId: number, departmentId: string) {
  if (me.is_admin) return true;
  const r = await db
    .prepare("SELECT 1 FROM managers WHERE staff_id = ? AND restaurant_id = ? AND department_id = ?")
    .bind(me.id, restaurantId, departmentId)
    .first();
  return !!r;
}

// Employees may view a schedule only for a restaurant+department where they hold a role.
// Managers can always view what they manage.
/** Every schedule (restaurant + department) a person may look at: the ones they manage, plus either the ones where they hold a
 *  role ("auto") or exactly the ones an administrator ticked ("custom"). Administrators see everything (not listed here). */
async function viewableSchedules(db: D1Database, staffId: number): Promise<{ restaurant_id: number; department_id: string }[]> {
  const custom = (await db.prepare("SELECT view_custom FROM staff WHERE id = ?").bind(staffId).first<{ view_custom: number }>())?.view_custom === 1;
  const base = custom
    ? "SELECT restaurant_id, department_id FROM staff_view_access WHERE staff_id = ?1"
    : "SELECT sr.restaurant_id, ro.department_id FROM staff_roles sr JOIN roles ro ON ro.id = sr.role_id WHERE sr.staff_id = ?1";
  return (await db.prepare(`${base} UNION SELECT restaurant_id, department_id FROM managers WHERE staff_id = ?1`).bind(staffId).all<{ restaurant_id: number; department_id: string }>()).results;
}

async function canView(db: D1Database, me: Me, restaurantId: number, departmentId: string) {
  if (await canManage(db, me, restaurantId, departmentId)) return true;
  return (await viewableSchedules(db, me.id)).some((x) => x.restaurant_id === restaurantId && x.department_id === departmentId);
}

const requireAdmin = async (c: any, next: any) => {
  if (!c.get("me").is_admin) return c.json({ error: "forbidden" }, 403);
  await next();
};


// Adds open_by_dow and close_by_dow (7 "HH:MM" values each, Monday..Sunday) to restaurant rows.
async function withOpenHours<T extends { id: number; open_time: string; close_time: string }>(db: D1Database, rows: T[]) {
  const hours = await db.prepare("SELECT restaurant_id, dow, open_time, close_time, dinner_time FROM restaurant_open_hours").all<{ restaurant_id: number; dow: number; open_time: string; close_time: string | null; dinner_time: string | null }>();
  const bfRows = (await db.prepare("SELECT restaurant_id, dow, start_time, end_time FROM restaurant_breakfast").all<{ restaurant_id: number; dow: number; start_time: string; end_time: string }>()).results;
  const specials = (await db.prepare("SELECT id, restaurant_id, date, yearly, closed, open_time, close_time, note FROM restaurant_special_hours ORDER BY date").all<{ id: number; restaurant_id: number; date: string; yearly: number; closed: number; open_time: string | null; close_time: string | null; note: string | null }>()).results;
  const franchises = (await db.prepare("SELECT restaurant_id, name, logo_type, logo_v FROM restaurant_franchise").all<{ restaurant_id: number; name: string | null; logo_type: string | null; logo_v: number }>()).results;
  return rows.map((r) => {
    const day = (d: number) => hours.results.find((h) => h.restaurant_id === r.id && h.dow === d);
    return {
      ...r,
      franchise: (() => { const f = franchises.find((x) => x.restaurant_id === r.id); return { name: f?.name ?? null, logo: !!f?.logo_type, logo_v: f?.logo_v ?? 0 }; })(),
      dinner_by_dow: Array.from({ length: 7 }, (_, d) => day(d)?.dinner_time ?? null),
      special_hours: specials.filter((x) => x.restaurant_id === r.id).map((x) => ({ ...x, yearly: x.yearly === 1, closed: x.closed === 1 })),
      breakfast_by_dow: Array.from({ length: 7 }, (_, d) => { const b = bfRows.find((x) => x.restaurant_id === r.id && x.dow === d); return b ? { start: b.start_time, end: b.end_time } : null; }),
      open_by_dow: Array.from({ length: 7 }, (_, d) => day(d)?.open_time ?? r.open_time),
      close_by_dow: Array.from({ length: 7 }, (_, d) => day(d)?.close_time ?? r.close_time),
    };
  });
}

async function loadSettings(db: D1Database, clientId: number): Promise<Settings> {
  return parseSettings(await clientSettingRows(db, clientId));
}

/** SQL condition "this shift may be seen by this person": administrators and the managers of the shift's department always,
 *  everybody else only once the week is published for that restaurant and department. (`sh` = the shifts table alias.) */
function shiftVisible(me: { id: number; is_admin: boolean }, sh = "sh"): string {
  const dept = `(SELECT department_id FROM roles WHERE id = ${sh}.role_id)`;
  const mine = me.is_admin ? "1" : `EXISTS (SELECT 1 FROM managers m WHERE m.staff_id = ${Math.trunc(me.id)} AND m.restaurant_id = ${sh}.restaurant_id AND m.department_id = ${dept})`;
  return `(${mine} OR EXISTS (SELECT 1 FROM schedule_publications p WHERE p.restaurant_id = ${sh}.restaurant_id AND p.department_id = ${dept}
    AND p.week_start = date(substr(${sh}.start_at, 1, 10), '-' || ((CAST(strftime('%w', substr(${sh}.start_at, 1, 10)) AS INTEGER) + 6) % 7) || ' days')))`;
}

const intParam = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null);

// ---------- Me ----------
// Ids of all employees (no names): the browser ranks them to give everyone a distinct automatic colour.
app.get("/api/staff-order", async (c) => c.json((await c.env.DB.prepare("SELECT id FROM staff WHERE client_id = ? ORDER BY id").bind(c.get("me").client_id).all<{ id: number }>()).results.map((r) => r.id)));

// ---------- API tokens (client administrators, signed in with a person, never with a token) ----------
const requireHuman = async (c: any, next: any) => {
  const me = c.get("me");
  if (!me.is_admin || me.via_token) return c.json({ error: "forbidden" }, 403);
  await next();
};
app.get("/api/admin/tokens", requireHuman, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.scope, t.hint, t.created_at, t.last_used_at, t.revoked_at, s.name AS created_by_name
     FROM api_tokens t LEFT JOIN staff s ON s.id = t.created_by WHERE t.client_id = ? ORDER BY t.id DESC`,
  ).bind(c.get("me").client_id).all();
  return c.json(rows.results);
});
app.post("/api/admin/tokens", requireHuman, async (c) => {
  const me = c.get("me");
  const b = await c.req.json<{ name?: string; scope?: string }>().catch(() => ({} as { name?: string; scope?: string }));
  const name = (b.name ?? "").trim();
  if (!name || name.length > 60) return c.json({ error: "name_required" }, 400);
  if (b.scope !== "read" && b.scope !== "write") return c.json({ error: "invalid_scope" }, 400);
  const n = await c.env.DB.prepare("SELECT count(*) AS n FROM api_tokens WHERE client_id = ? AND revoked_at IS NULL").bind(me.client_id).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_ACTIVE_TOKENS) return c.json({ error: "too_many_tokens" }, 409);
  const token = newApiToken();
  const r = await c.env.DB.prepare("INSERT INTO api_tokens (client_id, name, token_hash, hint, scope, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(me.client_id, name, await sha256Hex(token), token.slice(-4), b.scope, me.id, Date.now()).run();
  // The only time the token is ever shown.
  return c.json({ id: r.meta.last_row_id, token, name, scope: b.scope }, 201);
});
app.delete("/api/admin/tokens/:id", requireHuman, async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  const r = await c.env.DB.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND client_id = ? AND revoked_at IS NULL").bind(Date.now(), id, c.get("me").client_id).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

// ---------- Webhooks (client administrators, in the browser) ----------
const endpointView = (r: any) => ({ id: r.id, name: r.name, url: r.url, events: JSON.parse(r.events), active: r.active === 1, failures: r.failures, created_at: r.created_at, secret_hint: `…${String(r.secret).slice(-4)}`, last_delivery: r.last_delivery ?? null });
app.get("/api/webhooks/events", requireHuman, (c) => c.json(EVENTS));
app.get("/api/admin/webhooks", requireHuman, async (c) => {
  const rows = (await c.env.DB.prepare(
    `SELECT e.*, (SELECT json_object('status', d.status, 'code', d.response_code, 'at', COALESCE(d.sent_at, d.created_at)) FROM webhook_deliveries d WHERE d.endpoint_id = e.id ORDER BY d.id DESC LIMIT 1) AS last_delivery
     FROM webhook_endpoints e WHERE e.client_id = ? ORDER BY e.id`).bind(c.get("me").client_id).all<any>()).results;
  return c.json(rows.map((r) => endpointView({ ...r, last_delivery: r.last_delivery ? JSON.parse(r.last_delivery) : null })));
});
app.post("/api/admin/webhooks", requireHuman, async (c) => {
  const me = c.get("me");
  const b = await c.req.json<{ name?: string; url?: string; events?: unknown }>().catch(() => ({} as any));
  const name = (b.name ?? "").trim(), events = validateEvents(b.events);
  if (!name || name.length > 60) return c.json({ error: "name_required" }, 400);
  const bad = validateUrl(b.url ?? "", c.env.DEV_MODE === "true");
  if (bad) return c.json({ error: bad }, 400);
  if (!events) return c.json({ error: "invalid_events" }, 400);
  const n = await c.env.DB.prepare("SELECT count(*) AS n FROM webhook_endpoints WHERE client_id = ?").bind(me.client_id).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_ENDPOINTS) return c.json({ error: "too_many_endpoints" }, 409);
  const secret = newSecret();
  const r = await c.env.DB.prepare("INSERT INTO webhook_endpoints (client_id, name, url, secret, events, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(me.client_id, name, b.url, secret, JSON.stringify(events), me.id, Date.now()).run();
  return c.json({ id: r.meta.last_row_id, secret }, 201); // the secret is shown only now
});
const ownEndpoint = (c: Context<any>, id: number) => (c.env.DB as D1Database).prepare("SELECT * FROM webhook_endpoints WHERE id = ? AND client_id = ?").bind(id, (c.get("me") as Me).client_id).first<any>();
app.put("/api/admin/webhooks/:id", requireHuman, async (c) => {
  const id = intParam(c.req.param("id"));
  const ep = id ? await ownEndpoint(c, id) : null;
  if (!ep) return c.json({ error: "not_found" }, 404);
  const b = await c.req.json<{ name?: string; url?: string; events?: unknown; active?: boolean; rotate_secret?: boolean }>().catch(() => ({} as any));
  const name = b.name === undefined ? ep.name : String(b.name).trim();
  const url = b.url === undefined ? ep.url : b.url;
  const events = b.events === undefined ? JSON.parse(ep.events) : validateEvents(b.events);
  if (!name || name.length > 60) return c.json({ error: "name_required" }, 400);
  const bad = validateUrl(url, c.env.DEV_MODE === "true"); if (bad) return c.json({ error: bad }, 400);
  if (!events) return c.json({ error: "invalid_events" }, 400);
  const secret = b.rotate_secret ? newSecret() : ep.secret;
  const active = b.active === undefined ? ep.active : b.active ? 1 : 0;
  await c.env.DB.prepare("UPDATE webhook_endpoints SET name = ?, url = ?, events = ?, secret = ?, active = ?, failures = ? WHERE id = ?")
    .bind(name, url, JSON.stringify(events), secret, active, active === 1 && ep.active === 0 ? 0 : ep.failures, id).run();
  return c.json({ ok: true, ...(b.rotate_secret ? { secret } : {}) });
});
app.delete("/api/admin/webhooks/:id", requireHuman, async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id || !(await ownEndpoint(c, id))) return c.json({ error: "not_found" }, 404);
  await c.env.DB.batch([c.env.DB.prepare("DELETE FROM webhook_deliveries WHERE endpoint_id = ?").bind(id), c.env.DB.prepare("DELETE FROM webhook_endpoints WHERE id = ?").bind(id)]);
  return c.json({ ok: true });
});
// Sends a "ping" right now so the CRM developer can check the URL and the signature.
app.post("/api/admin/webhooks/:id/test", requireHuman, async (c) => {
  const id = intParam(c.req.param("id"));
  const ep = id ? await ownEndpoint(c, id) : null;
  if (!ep) return c.json({ error: "not_found" }, 404);
  await queueEvent(c.env.DB, c.get("me").client_id, "ping", { message: "Test from AMO Schedule App" }, ep.id);
  await flushDeliveries(c.env.DB);
  const d = await c.env.DB.prepare("SELECT status, response_code, error, attempts FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY id DESC LIMIT 1").bind(ep.id).first();
  return c.json(d ?? { status: "none" });
});
app.get("/api/admin/webhooks/:id/deliveries", requireHuman, async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id || !(await ownEndpoint(c, id))) return c.json({ error: "not_found" }, 404);
  const rows = await c.env.DB.prepare("SELECT id, event, status, attempts, response_code, error, created_at, sent_at, next_attempt_at FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY id DESC LIMIT 50").bind(id).all();
  return c.json(rows.results);
});
// Re-sends a failed delivery.
app.post("/api/admin/webhooks/:id/deliveries/:did/retry", requireHuman, async (c) => {
  const id = intParam(c.req.param("id")), did = intParam(c.req.param("did"));
  if (!id || !did || !(await ownEndpoint(c, id))) return c.json({ error: "not_found" }, 404);
  const r = await c.env.DB.prepare("UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ? WHERE id = ? AND endpoint_id = ? AND status = 'failed'").bind(Date.now(), did, id).run();
  if (!r.meta.changes) return c.json({ error: "not_found" }, 404);
  await flushDeliveries(c.env.DB);
  return c.json({ ok: true });
});

// ---------- Clients (platform owners only) ----------
const requireSuper = async (c: any, next: any) => {
  if (!c.get("me").is_super) return c.json({ error: "forbidden" }, 403);
  await next();
};
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{1,251}[a-z0-9])$/;

app.get("/api/clients", requireSuper, async (c) => {
  const rows = (await c.env.DB.prepare(
    `SELECT cl.id, cl.name, cl.hostname, cl.active, cl.created_at,
            (SELECT count(*) FROM staff s WHERE s.client_id = cl.id AND s.active = 1) AS employees,
            (SELECT count(*) FROM restaurants r WHERE r.client_id = cl.id) AS restaurants
     FROM clients cl ORDER BY cl.id`,
  ).all<{ id: number }>()).results;
  const admins = (await c.env.DB.prepare("SELECT client_id, id, name, email FROM staff WHERE is_admin = 1 AND active = 1 ORDER BY name").all<{ client_id: number; id: number; name: string; email: string | null }>()).results;
  return c.json(rows.map((r) => ({ ...r, admins: admins.filter((a) => a.client_id === r.id).map(({ id, name, email }) => ({ id, name, email })) })));
});

// A new client comes with its first administrator (an employee of that client, who signs in with the email) and, optionally, a first restaurant.
app.post("/api/clients", requireSuper, async (c) => {
  const b = await c.req.json<{ name?: string; hostname?: string; admin_first_name?: string; admin_last_name?: string; admin_email?: string; restaurant_name?: string }>().catch(() => ({} as any));
  const name = (b.name ?? "").trim(), email = (b.admin_email ?? "").trim().toLowerCase();
  const nm = namesFrom({ first_name: b.admin_first_name, last_name: b.admin_last_name });
  const host = (b.hostname ?? "").trim().toLowerCase();
  if (!name || name.length > 80) return c.json({ error: "name_required" }, 400);
  if (!looksLikeEmail(email)) return c.json({ error: "invalid_email" }, 400);
  if (!nm) return c.json({ error: "admin_name_required" }, 400);
  if (host && !HOST_RE.test(host)) return c.json({ error: "invalid_hostname" }, 400);
  if (await c.env.DB.prepare("SELECT 1 FROM staff WHERE lower(email) = ?").bind(email).first()) return c.json({ error: "email_taken" }, 409);
  if (host && (await c.env.DB.prepare("SELECT 1 FROM clients WHERE hostname = ?").bind(host).first())) return c.json({ error: "hostname_taken" }, 409);
  const restName = (b.restaurant_name ?? "").trim();
  if (restName && (await c.env.DB.prepare("SELECT 1 FROM restaurants WHERE name = ?").bind(restName).first())) return c.json({ error: "restaurant_name_taken" }, 409);
  const created = await c.env.DB.prepare("INSERT INTO clients (name, hostname, created_at) VALUES (?, ?, ?)").bind(name, host || null, Date.now()).run();
  const id = created.meta.last_row_id as number;
  const stmts = [
    c.env.DB.prepare("INSERT INTO staff (name, first_name, last_name, email, is_admin, client_id) VALUES (?, ?, ?, ?, 1, ?)").bind(nm.name, nm.first, nm.last, email, id),
    putSettingStmt(c.env.DB, id, "brand_name", name),
  ];
  if (restName) stmts.push(c.env.DB.prepare("INSERT INTO restaurants (name, client_id) VALUES (?, ?)").bind(restName, id));
  await c.env.DB.batch(stmts);
  return c.json({ id }, 201);
});

app.put("/api/clients/:id", requireSuper, async (c) => {
  const id = intParam(c.req.param("id"));
  const b = await c.req.json<{ name?: string; hostname?: string | null; active?: boolean }>().catch(() => ({} as any));
  if (!id) return c.json({ error: "bad_id" }, 400);
  const cur = await c.env.DB.prepare("SELECT name, hostname, active FROM clients WHERE id = ?").bind(id).first<{ name: string; hostname: string | null; active: number }>();
  if (!cur) return c.json({ error: "not_found" }, 404);
  const name = b.name === undefined ? cur.name : b.name.trim();
  const host = b.hostname === undefined ? cur.hostname : (b.hostname ?? "").trim().toLowerCase() || null;
  if (!name || name.length > 80) return c.json({ error: "name_required" }, 400);
  if (host && !HOST_RE.test(host)) return c.json({ error: "invalid_hostname" }, 400);
  if (id === 1 && b.active === false) return c.json({ error: "cannot_disable_main_client" }, 409);
  if (host && host !== cur.hostname && (await c.env.DB.prepare("SELECT 1 FROM clients WHERE hostname = ? AND id != ?").bind(host, id).first())) return c.json({ error: "hostname_taken" }, 409);
  await c.env.DB.prepare("UPDATE clients SET name = ?, hostname = ?, active = ? WHERE id = ?").bind(name, host, b.active === undefined ? cur.active : b.active ? 1 : 0, id).run();
  return c.json({ ok: true });
});

// ---------- In-app sign-in: email one-time code -> session cookie ----------
const isSecure = (c: Context<any>) => new URL(c.req.url).protocol === "https:";

// ---------- Branding (per client): public read for the sign-in screen, admin write ----------
async function loadBrand(db: D1Database, clientId: number): Promise<Brand> {
  const rows = await clientSettingRows(db, clientId, "brand_");
  const b = parseBrand(rows.filter((r) => r.key !== "brand_logo"));
  if (!rows.some((r) => r.key === "brand_name")) b.name = (await db.prepare("SELECT name FROM clients WHERE id = ?").bind(clientId).first<{ name: string }>())?.name ?? b.name;
  return b;
}
// The sign-in screen has no session yet: the client is the one whose domain the visitor used (default: client 1).
// Signed-in visitors always get their own client's branding.
async function brandClientId(c: Context<any>): Promise<number> {
  const db = c.env.DB as D1Database;
  if (c.env.DEV_MODE === "true" && c.req.header("X-Dev-User")) {
    const devEmail = c.req.header("X-Dev-User")!.toLowerCase();
    const dev = await db.prepare("SELECT client_id FROM staff WHERE lower(email) = ?").bind(devEmail).first<{ client_id: number }>();
    if (dev) { const want = Number(c.req.header("X-Client")); return want && superAdmins(c.env).includes(devEmail) ? want : dev.client_id; }
  }
  const sid = readCookie(c.req.header("cookie"), COOKIE_NAME);
  if (sid) {
    const row = await db.prepare("SELECT s.client_id, x.email FROM sessions x JOIN staff s ON lower(s.email) = x.email WHERE x.token_hash = ? AND x.expires_at > ?").bind(await sha256Hex(sid), Date.now()).first<{ client_id: number; email: string }>();
    if (row) {
      const want = Number(c.req.header("X-Client"));
      return want && superAdmins(c.env).includes(row.email) ? want : row.client_id;
    }
  }
  const host = new URL(c.req.url).hostname.toLowerCase();
  const byHost = await db.prepare("SELECT id FROM clients WHERE hostname = ? AND active = 1").bind(host).first<{ id: number }>();
  return byHost?.id ?? 1;
}
app.get("/api/auth/branding", async (c) => c.json(await loadBrand(c.env.DB, await brandClientId(c))));
app.get("/api/auth/logo", async (c) => {
  const cid = await brandClientId(c);
  const [d, t] = await Promise.all([getSetting(c.env.DB, cid, "brand_logo"), getSetting(c.env.DB, cid, "brand_logo_type")]);
  if (!d || !t) return c.body(null, 404);
  const bytes = Uint8Array.from(atob(d), (ch) => ch.charCodeAt(0));
  return new Response(bytes, { headers: { "content-type": t, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } });
});
app.put("/api/admin/branding", requireAdmin, async (c) => {
  const cid = c.get("me").client_id;
  const v = validateBrandPatch(await c.req.json<Record<string, unknown>>().catch(() => ({})));
  if ("error" in v) return c.json({ error: v.error }, 400);
  await c.env.DB.batch(Object.entries(v.values).map(([k, val]) =>
    val === "" && k !== "brand_name" ? delSettingStmt(c.env.DB, cid, k) : putSettingStmt(c.env.DB, cid, k, val)));
  return c.json(await loadBrand(c.env.DB, cid));
});
app.put("/api/admin/branding/logo", requireAdmin, async (c) => {
  const cid = c.get("me").client_id;
  const b = await c.req.json<{ type?: string; data?: string }>().catch(() => ({} as { type?: string; data?: string }));
  if (!b.type || !(LOGO_TYPES as readonly string[]).includes(b.type)) return c.json({ error: "invalid_type" }, 400);
  if (!b.data || !/^[A-Za-z0-9+/]+=*$/.test(b.data) || b.data.length * 0.75 > MAX_LOGO_BYTES) return c.json({ error: "invalid_or_too_large" }, 400);
  await c.env.DB.batch([putSettingStmt(c.env.DB, cid, "brand_logo", b.data), putSettingStmt(c.env.DB, cid, "brand_logo_type", b.type), putSettingStmt(c.env.DB, cid, "brand_logo_v", String(Date.now()))]);
  return c.json(await loadBrand(c.env.DB, cid));
});
app.delete("/api/admin/branding/logo", requireAdmin, async (c) => {
  const cid = c.get("me").client_id;
  await c.env.DB.batch(["brand_logo", "brand_logo_type", "brand_logo_v"].map((k) => delSettingStmt(c.env.DB, cid, k)));
  return c.json(await loadBrand(c.env.DB, cid));
});

app.post("/api/auth/request", async (c) => {
  const b = await c.req.json<{ email?: string; lang?: string }>().catch(() => ({} as { email?: string; lang?: string }));
  const email = (b.email ?? "").trim().toLowerCase();
  if (!looksLikeEmail(email)) return c.json({ error: "invalid_email" }, 400);
  const db = c.env.DB, now = Date.now();
  const staff = await db.prepare("SELECT id, lang, active, client_id FROM staff WHERE lower(email) = ?").bind(email).first<{ id: number; lang: string; active: number | null; client_id: number }>();
  const clientId = staff?.client_id ?? 1;
  // The client's own mail settings, else the platform owner's (client 1).
  let conn = await loadConnections(c.env, db, clientId);
  if (!conn.smtp && clientId !== 1) conn = { ...conn, smtp: (await loadConnections(c.env, db, 1)).smtp };
  if (!conn.smtp) return c.json({ error: "email_not_configured" }, 503);
  await db.prepare("DELETE FROM login_codes WHERE expires_at < ?").bind(now - 3600_000).run();
  await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  // Identical answer whether or not the address belongs to an employee: nobody can probe who works here.
  const recent = await db.prepare("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM login_codes WHERE email = ? AND created_at > ?").bind(email, now - 3600_000).first<{ n: number; last: number | null }>();
  if ((recent?.n ?? 0) >= MAX_CODES_PER_HOUR || (recent?.last && now - recent.last < MIN_GAP_MS)) return c.json({ error: "too_many_requests" }, 429);
  const allowed = (staff && staff.active !== 0) || superAdmins(c.env).includes(email);
  const code = newCode();
  const pepper = c.env.SIN_KEY ?? "";
  await db.prepare("INSERT INTO login_codes (email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(email, allowed ? await codeHash(pepper, email, code) : await sha256Hex(crypto.randomUUID()), now + CODE_TTL_MS, now).run();
  if (allowed) {
    const lang = staff?.lang === "en" || (!staff && b.lang === "en") ? "en" : "fr";
    const brand = await loadBrand(db, clientId);
    const smtp = { ...conn, smtp: { ...conn.smtp, from: senderAddress(conn.smtp.from, brand.sender_name) } };
    c.executionCtx.waitUntil(deliver(db, smtp, "email", email, loginMessage(lang, code, brand.name), "login_code", staff?.id ?? null).then(() => {}));
  }
  return c.json({ ok: true });
});

app.post("/api/auth/verify", async (c) => {
  const b = await c.req.json<{ email?: string; code?: string }>().catch(() => ({} as { email?: string; code?: string }));
  const email = (b.email ?? "").trim().toLowerCase(), code = (b.code ?? "").replace(/\s/g, "");
  if (!looksLikeEmail(email) || !/^\d{6}$/.test(code)) return c.json({ error: "invalid_code" }, 400);
  const db = c.env.DB, now = Date.now();
  const row = await db.prepare("SELECT id, code_hash, attempts FROM login_codes WHERE email = ? AND expires_at > ? ORDER BY id DESC LIMIT 1").bind(email, now).first<{ id: number; code_hash: string; attempts: number }>();
  if (!row || row.attempts >= MAX_ATTEMPTS) return c.json({ error: "invalid_code" }, 400);
  await db.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?").bind(row.id).run();
  if (!safeEqual(row.code_hash, await codeHash(c.env.SIN_KEY ?? "", email, code))) return c.json({ error: "invalid_code" }, 400);
  await db.prepare("DELETE FROM login_codes WHERE email = ?").bind(email).run();
  const token = newSessionToken();
  await db.prepare("INSERT INTO sessions (token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(token), email, now + SESSION_TTL_MS, now).run();
  c.header("Set-Cookie", sessionCookie(token, isSecure(c)));
  return c.json({ ok: true });
});

app.post("/api/auth/logout", async (c) => {
  const sid = readCookie(c.req.header("cookie"), COOKIE_NAME);
  if (sid) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(sid)).run();
  c.header("Set-Cookie", clearCookie(isSecure(c)));
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const me = c.get("me");
  const db = c.env.DB;
  const managed = await db
    .prepare(
      `SELECT m.restaurant_id, r.name AS restaurant, m.department_id
       FROM managers m JOIN restaurants r ON r.id = m.restaurant_id WHERE m.staff_id = ?`,
    )
    .bind(me.id)
    .all();
  const roles = await db
    .prepare(
      `SELECT sr.restaurant_id, r.name AS restaurant, ro.id AS role_id, ro.department_id, ro.name_fr, ro.name_en
       FROM staff_roles sr JOIN roles ro ON ro.id = sr.role_id JOIN restaurants r ON r.id = sr.restaurant_id
       WHERE sr.staff_id = ?`,
    )
    .bind(me.id)
    .all();
  const client = await db.prepare("SELECT id, name FROM clients WHERE id = ?").bind(me.client_id).first();
  const schedules = me.is_admin ? null : await viewableSchedules(db, me.id);
  return c.json({ me, client, managed: managed.results, roles: roles.results, schedules });
});

app.get("/api/departments", async (c) =>
  c.json((await c.env.DB.prepare("SELECT * FROM departments").all()).results),
);
// Roles are a shared catalogue; each client has its own "minutes before opening" and default hourly rate per role
// (client 1 keeps them in the roles table, the others in their settings).
async function rolesFor(db: D1Database, clientId: number): Promise<any[]> {
  const rows = (await db.prepare("SELECT * FROM roles").all<Record<string, any>>()).results;
  if (clientId === 1) return rows;
  const set = new Map((await clientSettingRows(db, clientId)).map((r) => [r.key, r.value]));
  return rows.map((r) => ({ ...r, pre_open_minutes: Number(set.get(`preopen_${r.id}`) ?? 0), default_hourly_cents: set.has(`rate_${r.id}`) ? Number(set.get(`rate_${r.id}`)) : null }));
}
app.get("/api/roles", async (c) => c.json(await rolesFor(c.env.DB, c.get("me").client_id)));

// Minutes before opening that this role should arrive (default start time of its shifts).
app.put("/api/roles/:id/pre-open", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const { minutes } = await c.req.json<{ minutes?: number }>();
  if (!id || !Number.isInteger(minutes) || (minutes as number) < 0 || (minutes as number) > 180) return c.json({ error: "invalid_minutes" }, 400);
  if (!(await c.env.DB.prepare("SELECT 1 FROM roles WHERE id = ?").bind(id).first())) return c.json({ error: "not_found" }, 404);
  const cid = c.get("me").client_id;
  if (cid === 1) await c.env.DB.prepare("UPDATE roles SET pre_open_minutes = ? WHERE id = ?").bind(minutes, id).run();
  else await putSettingStmt(c.env.DB, cid, `preopen_${id}`, String(minutes)).run();
  return c.json({ ok: true });
});

// Deactivate / reactivate an employee (admin only; not yourself).
app.put("/api/staff/:id/active", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const { active } = await c.req.json<{ active?: boolean }>();
  if (!id || typeof active !== "boolean") return c.json({ error: "bad_request" }, 400);
  if (!active && id === c.get("me").id) return c.json({ error: "cannot_remove_self" }, 409);
  if (!active) {
    const n = await c.env.DB.prepare("SELECT count(*) AS n FROM staff WHERE is_admin = 1 AND active = 1 AND id != ? AND client_id = ?").bind(id, c.get("me").client_id).first<{ n: number }>();
    const isAdmin = await c.env.DB.prepare("SELECT is_admin FROM staff WHERE id = ?").bind(id).first<{ is_admin: number }>();
    if (isAdmin?.is_admin === 1 && !n?.n) return c.json({ error: "last_admin" }, 409);
  }
  const r = await c.env.DB.prepare("UPDATE staff SET active = ? WHERE id = ?").bind(active ? 1 : 0, id).run();
  if (!r.meta.changes) return c.json({ error: "not_found" }, 404);
  // Pending replacement offers to this person are no longer valid.
  if (!active) await c.env.DB.prepare("UPDATE coverage_offers SET status = 'closed' WHERE staff_id = ? AND status = 'sent'").bind(id).run().catch(() => {});
  const future = await c.env.DB.prepare("SELECT count(*) AS n FROM shifts WHERE staff_id = ? AND status = 'ok' AND start_at >= ?").bind(id, localNow(c.env.TIMEZONE)).first<{ n: number }>();
  emit(c, "staff.active_changed", () => staffData(c.env.DB, id));
  return c.json({ ok: true, active, upcoming_shifts: active ? 0 : future?.n ?? 0 });
});

// Make someone an administrator (or remove it). The last administrator and yourself cannot be removed.
app.put("/api/staff/:id/admin", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const { is_admin, email } = await c.req.json<{ is_admin?: boolean; email?: string }>();
  if (!id || typeof is_admin !== "boolean") return c.json({ error: "bad_request" }, 400);
  const person = await c.env.DB.prepare("SELECT email FROM staff WHERE id = ?").bind(id).first<{ email: string | null }>();
  if (!person) return c.json({ error: "not_found" }, 404);
  // The email typed on the card (not saved yet) can be sent along: they sign in with it.
  const typed = email?.trim().toLowerCase();
  if (is_admin && typed && typed !== person.email) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(typed)) return c.json({ error: "invalid_email" }, 400);
    const taken = await c.env.DB.prepare("SELECT 1 FROM staff WHERE lower(email) = ? AND id != ?").bind(typed, id).first();
    if (taken) return c.json({ error: "email_taken" }, 409);
    await c.env.DB.prepare("UPDATE staff SET email = ? WHERE id = ?").bind(typed, id).run();
    person.email = typed;
  }
  if (is_admin && !person.email) return c.json({ error: "email_required" }, 422);
  if (!is_admin) {
    if (id === c.get("me").id) return c.json({ error: "cannot_remove_self" }, 409);
    const n = await c.env.DB.prepare("SELECT count(*) AS n FROM staff WHERE is_admin = 1 AND id != ? AND client_id = ?").bind(id, c.get("me").client_id).first<{ n: number }>();
    if (!n?.n) return c.json({ error: "last_admin" }, 409);
  }
  await c.env.DB.prepare("UPDATE staff SET is_admin = ? WHERE id = ?").bind(is_admin ? 1 : 0, id).run();
  return c.json({ ok: true, is_admin });
});

// ---------- Restaurants (admin) ----------
app.get("/api/restaurants", async (c) => {
  const me = c.get("me");
  let ids: number[] | null = null; // null = all (administrators)
  if (!me.is_admin) ids = [...new Set((await viewableSchedules(c.env.DB, me.id)).map((x) => x.restaurant_id))];
  if (ids && !ids.length) return c.json([]);
  const rows = (await c.env.DB.prepare(`SELECT id, name, open_time, close_time FROM restaurants WHERE client_id = ?${ids ? ` AND id IN (${ids.map(() => "?").join(",")})` : ""} ORDER BY name`)
    .bind(me.client_id, ...(ids ?? [])).all()).results as { id: number; name: string; open_time: string; close_time: string }[];
  return c.json(await withOpenHours(c.env.DB, rows));
});

// Adding a restaurant is an additional paid service: only the owner's CRM (an API token) can do it, never a person in the app.
app.post("/api/restaurants", requireAdmin, async (c) => {
  if (!c.get("me").via_token) return c.json({ error: "crm_only" }, 403);
  const { name } = await c.req.json<{ name?: string }>();
  if (!name?.trim()) return c.json({ error: "name_required" }, 400);
  try {
    const r = await c.env.DB.prepare("INSERT INTO restaurants (name, client_id) VALUES (?, ?)").bind(name.trim(), c.get("me").client_id).run();
    const rid = r.meta.last_row_id as number;
    const cm = await c.env.DB.prepare("INSERT INTO communities (restaurant_id, name, position) VALUES (?, 'Équipe', 1)").bind(rid).run();
    await c.env.DB.batch(COMMUNITY_DEPTS.map((d) => c.env.DB.prepare("INSERT INTO community_departments (community_id, department_id) VALUES (?, ?)").bind(cm.meta.last_row_id, d)));
    return c.json({ id: rid, name: name.trim() }, 201);
  } catch {
    return c.json({ error: "name_taken" }, 409);
  }
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Opening and closing time per weekday (open_times / close_times = 7 values each, Monday..Sunday).
// Legacy fields open_time / close_time set the same value for every day. Until-close shifts follow the closing time of their day.
app.put("/api/restaurants/:id/hours", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const b = await c.req.json<{ open_times?: string[]; close_times?: string[]; dinner_times?: (string | null)[]; open_time?: string; close_time?: string }>();
  if (!id) return c.json({ error: "bad_id" }, 400);
  const current = await c.env.DB.prepare("SELECT id, open_time, close_time FROM restaurants WHERE id = ?").bind(id).first<{ id: number; open_time: string; close_time: string }>();
  if (!current) return c.json({ error: "not_found" }, 404);
  const existing = (await withOpenHours(c.env.DB, [current]))[0];
  const opens = b.open_times ?? (b.open_time ? Array(7).fill(b.open_time) : existing.open_by_dow);
  const closes = b.close_times ?? (b.close_time ? Array(7).fill(b.close_time) : existing.close_by_dow);
  const valid = (a: unknown): a is string[] => Array.isArray(a) && a.length === 7 && a.every((x) => typeof x === "string" && TIME_RE.test(x));
  if (!valid(opens) || !valid(closes) || opens.some((o, d) => o >= closes[d])) return c.json({ error: "invalid_times" }, 400);
  // dinner start per weekday (null = none); kept as it is when the caller does not send it
  const dinners = b.dinner_times ?? existing.dinner_by_dow;
  if (!Array.isArray(dinners) || dinners.length !== 7 || dinners.some((x, d) => x != null && (typeof x !== "string" || !TIME_RE.test(x) || x < opens[d] || x >= closes[d]))) return c.json({ error: "invalid_times" }, 400);
  const db = c.env.DB;
  await db.batch([
    db.prepare("UPDATE restaurants SET open_time = ?, close_time = ? WHERE id = ?").bind(opens[0], closes[0], id),
    db.prepare("DELETE FROM restaurant_open_hours WHERE restaurant_id = ?").bind(id),
    ...opens.map((o, d) => db.prepare("INSERT INTO restaurant_open_hours (restaurant_id, dow, open_time, close_time, dinner_time) VALUES (?, ?, ?, ?, ?)").bind(id, d, o, closes[d], dinners[d] ?? null)),
    // 'F' shifts end at the closing time of their weekday (only when the shift starts before closing).
    ...closes.map((cl, d) =>
      db.prepare(
        `UPDATE shifts SET end_at = substr(start_at, 1, 10) || 'T' || ?1
         WHERE restaurant_id = ?2 AND until_close = 1 AND substr(start_at, 12, 5) < ?1
           AND ((CAST(strftime('%w', substr(start_at, 1, 10)) AS INTEGER) + 6) % 7) = ?3`,
      ).bind(cl, id, d)),
  ]);
  const specialDates = (await db.prepare("SELECT date FROM restaurant_special_hours WHERE restaurant_id = ?").bind(id).all<{ date: string }>()).results.map((x) => x.date);
  if (specialDates.length) await syncUntilClose(db, id, specialDates); // special days keep their own closing time
  return c.json({ ok: true });
});

// ---------- Staffing targets ----------
// GET /api/targets?restaurant=1&department=kitchen  -> [{dow, slot, count}]
app.get("/api/targets", async (c) => {
  const restaurantId = intParam(c.req.query("restaurant"));
  const department = c.req.query("department");
  if (!restaurantId || !department) return c.json({ error: "restaurant_and_department_required" }, 400);
  if (!(await canView(c.env.DB, c.get("me"), restaurantId, department))) return c.json({ error: "forbidden" }, 403);
  const r = await c.env.DB.prepare("SELECT set_id, dow, slot, count FROM staffing_targets WHERE restaurant_id = ? AND department_id = ?")
    .bind(restaurantId, department)
    .all();
  return c.json(r.results);
});

// Replaces all targets for one day-of-week (-1 = every day) of one restaurant+department+set (set_id 0 = base).
app.put("/api/targets", async (c) => {
  const b = await c.req.json<{ restaurant_id: number; department_id: string; set_id?: number; dow: number; slots: Record<string, number> }>();
  const setId = b.set_id ?? 0;
  if (!Number.isInteger(b.dow) || b.dow < -1 || b.dow > 6) return c.json({ error: "invalid_day" }, 400);
  if (!(await canManage(c.env.DB, c.get("me"), b.restaurant_id, b.department_id))) return c.json({ error: "forbidden" }, 403);
  if (setId !== 0) {
    const set = await c.env.DB.prepare("SELECT 1 FROM target_sets WHERE id = ? AND restaurant_id = ?").bind(setId, b.restaurant_id).first();
    if (!set) return c.json({ error: "set_not_found" }, 404);
  }
  const entries = Object.entries(b.slots ?? {});
  const validSlots: string[] = GRID_KEYS;
  for (const [slot, n] of entries) if (!validSlots.includes(slot) || !Number.isInteger(n) || n < 0 || n > 99) return c.json({ error: "invalid_target" }, 400);
  const db = c.env.DB;
  try {
    await db.batch([
      db.prepare("DELETE FROM staffing_targets WHERE restaurant_id = ? AND department_id = ? AND set_id = ? AND dow = ?").bind(b.restaurant_id, b.department_id, setId, b.dow),
      ...entries.map(([slot, n]) =>
        db.prepare("INSERT INTO staffing_targets (restaurant_id, department_id, set_id, dow, slot, count) VALUES (?, ?, ?, ?, ?, ?)").bind(b.restaurant_id, b.department_id, setId, b.dow, slot, n)),
    ]);
  } catch {
    return c.json({ error: "invalid_reference" }, 400);
  }
  return c.json({ ok: true });
});

// Franchise of a restaurant: name and small logo (shown on the restaurant pills in Administration).
app.put("/api/restaurants/:id/franchise", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const b = await c.req.json<{ name?: string | null; type?: string; data?: string; remove_logo?: boolean }>().catch(() => ({} as { name?: string | null; type?: string; data?: string; remove_logo?: boolean }));
  if (!id) return c.json({ error: "bad_id" }, 400);
  if (!(await c.env.DB.prepare("SELECT 1 FROM restaurants WHERE id = ?").bind(id).first())) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare("INSERT OR IGNORE INTO restaurant_franchise (restaurant_id) VALUES (?)").bind(id).run();
  if (b.name !== undefined) await c.env.DB.prepare("UPDATE restaurant_franchise SET name = ? WHERE restaurant_id = ?").bind((b.name ?? "").trim().slice(0, 80) || null, id).run();
  if (b.remove_logo) await c.env.DB.prepare("UPDATE restaurant_franchise SET logo = NULL, logo_type = NULL, logo_v = ? WHERE restaurant_id = ?").bind(Date.now(), id).run();
  if (b.data !== undefined) {
    if (!b.type || !(LOGO_TYPES as readonly string[]).includes(b.type)) return c.json({ error: "invalid_type" }, 400);
    if (!/^[A-Za-z0-9+/]+=*$/.test(b.data) || b.data.length * 0.75 > MAX_LOGO_BYTES) return c.json({ error: "invalid_or_too_large" }, 400);
    await c.env.DB.prepare("UPDATE restaurant_franchise SET logo = ?, logo_type = ?, logo_v = ? WHERE restaurant_id = ?").bind(b.data, b.type, Date.now(), id).run();
  }
  return c.json({ ok: true });
});
app.get("/api/restaurants/:id/logo", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.body(null, 404);
  const f = await c.env.DB.prepare("SELECT logo, logo_type FROM restaurant_franchise WHERE restaurant_id = ?").bind(id).first<{ logo: string | null; logo_type: string | null }>();
  if (!f?.logo || !f.logo_type) return c.body(null, 404);
  const bytes = Uint8Array.from(atob(f.logo), (ch) => ch.charCodeAt(0));
  return new Response(bytes, { headers: { "content-type": f.logo_type, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } });
});

// Closed days and special opening hours (administrators). One entry per restaurant and date; saving again replaces it.
app.post("/api/restaurants/:id/special-hours", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const b = await c.req.json<{ date?: string; end_date?: string; yearly?: boolean; closed?: boolean; open_time?: string; close_time?: string; note?: string }>();
  if (!id) return c.json({ error: "bad_id" }, 400);
  if (!DATE_RE2.test(b.date ?? "") || (b.end_date !== undefined && b.end_date !== null && b.end_date !== "" && !DATE_RE2.test(b.end_date))) return c.json({ error: "invalid_date" }, 400);
  if (!b.closed && (!TIME_RE.test(b.open_time ?? "") || !TIME_RE.test(b.close_time ?? "") || b.open_time! >= b.close_time!)) return c.json({ error: "invalid_times" }, 400);
  // a range (e.g. a whole week closed for construction): one entry per day, never yearly, at most 60 days
  const last = b.end_date || b.date!;
  const dayMs = 86_400_000, span = (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${b.date}T00:00:00Z`)) / dayMs;
  if (!(span >= 0) || span > 59) return c.json({ error: "invalid_date" }, 400);
  if (!(await c.env.DB.prepare("SELECT 1 FROM restaurants WHERE id = ?").bind(id).first())) return c.json({ error: "not_found" }, 404);
  const dates = Array.from({ length: span + 1 }, (_, i) => new Date(Date.parse(`${b.date}T00:00:00Z`) + i * dayMs).toISOString().slice(0, 10));
  const note = (b.note ?? "").trim().slice(0, 80) || null;
  await c.env.DB.batch(dates.map((d) => c.env.DB.prepare("INSERT OR REPLACE INTO restaurant_special_hours (restaurant_id, date, yearly, closed, open_time, close_time, note) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, d, dates.length === 1 && b.yearly ? 1 : 0, b.closed ? 1 : 0, b.closed ? null : b.open_time, b.closed ? null : b.close_time, note)));
  await syncUntilClose(c.env.DB, id, dates, dates.length === 1 && !!b.yearly);
  return c.json({ ok: true, days: dates.length });
});

app.delete("/api/restaurants/:id/special-hours/:hid", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id")), hid = intParam(c.req.param("hid"));
  if (!id || !hid) return c.json({ error: "bad_id" }, 400);
  const row = await c.env.DB.prepare("SELECT date, yearly FROM restaurant_special_hours WHERE id = ? AND restaurant_id = ?").bind(hid, id).first<{ date: string; yearly: number }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare("DELETE FROM restaurant_special_hours WHERE id = ?").bind(hid).run();
  await syncUntilClose(c.env.DB, id, [row.date], row.yearly === 1);
  return c.json({ ok: true });
});

// Until-close shifts follow the closing time of their day, special hours included. `dates` may be yearly: the occurrences of this and next year are refreshed.
async function syncUntilClose(db: D1Database, restaurantId: number, dates: string[], yearly = true) {
  const rest = await db.prepare("SELECT id, open_time, close_time FROM restaurants WHERE id = ?").bind(restaurantId).first<{ id: number; open_time: string; close_time: string }>();
  if (!rest) return;
  const [r] = await withOpenHours(db, [rest]);
  const year = new Date().getUTCFullYear();
  const all = new Set<string>();
  if (yearly) for (const d of dates) for (const y of [year, year + 1]) all.add(`${y}${d.slice(4)}`);
  for (const d of dates) all.add(d);
  const stmts: D1PreparedStatement[] = [];
  for (const date of all) {
    const dow = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
    const hrs = hoursFor(r.special_hours, date, r.open_by_dow[dow], r.close_by_dow[dow]);
    if (hrs.closed) continue;
    stmts.push(db.prepare("UPDATE shifts SET end_at = ?1 || 'T' || ?2 WHERE restaurant_id = ?3 AND until_close = 1 AND substr(start_at, 1, 10) = ?1 AND substr(start_at, 12, 5) < ?2").bind(date, hrs.close, restaurantId));
  }
  if (stmts.length) await db.batch(stmts);
}

// Breakfast hours per weekday: days = 7 entries (Monday..Sunday), each { start, end } or null (no breakfast that day).
app.put("/api/restaurants/:id/breakfast", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const { days } = await c.req.json<{ days?: ({ start: string; end: string } | null)[] }>();
  if (!id || !Array.isArray(days) || days.length !== 7) return c.json({ error: "bad_request" }, 400);
  if (days.some((d) => d && (!TIME_RE.test(d.start) || !TIME_RE.test(d.end) || d.start >= d.end))) return c.json({ error: "invalid_times" }, 400);
  if (!(await c.env.DB.prepare("SELECT 1 FROM restaurants WHERE id = ?").bind(id).first())) return c.json({ error: "not_found" }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM restaurant_breakfast WHERE restaurant_id = ?").bind(id),
    ...days.flatMap((d, dow) => (d ? [c.env.DB.prepare("INSERT INTO restaurant_breakfast (restaurant_id, dow, start_time, end_time) VALUES (?, ?, ?, ?)").bind(id, dow, d.start, d.end)] : [])),
  ]);
  return c.json({ ok: true });
});

// Sets (or, with count null, clears) the target of one department for a time range of one layer, in 30-minute intervals.
// Used by the quick edit on the coverage view. from/to are "HH:MM" on a half-hour; to may be "24:00".
app.put("/api/targets/range", async (c) => {
  const b = await c.req.json<{ restaurant_id: number; department_id: string; set_id?: number; dow: number; from: string; to: string; count: number | null }>();
  const setId = b.set_id ?? 0;
  if (!Number.isInteger(b.dow) || b.dow < -1 || b.dow > 6) return c.json({ error: "invalid_day" }, 400);
  const from = GRID_KEYS.indexOf(b.from), to = b.to === "24:00" ? 48 : GRID_KEYS.indexOf(b.to);
  if (from < 0 || to <= from) return c.json({ error: "invalid_times" }, 400);
  if (b.count !== null && (!Number.isInteger(b.count) || b.count < 0 || b.count > 99)) return c.json({ error: "invalid_target" }, 400);
  if (!(await canManage(c.env.DB, c.get("me"), b.restaurant_id, b.department_id))) return c.json({ error: "forbidden" }, 403);
  if (setId !== 0 && !(await c.env.DB.prepare("SELECT 1 FROM target_sets WHERE id = ? AND restaurant_id = ?").bind(setId, b.restaurant_id).first())) return c.json({ error: "set_not_found" }, 404);
  const db = c.env.DB;
  const slots: string[] = GRID_KEYS.slice(from, to);
  try {
    await db.batch(slots.flatMap((slot) => [
      db.prepare("DELETE FROM staffing_targets WHERE restaurant_id = ? AND department_id = ? AND set_id = ? AND dow = ? AND slot = ?").bind(b.restaurant_id, b.department_id, setId, b.dow, slot),
      ...(b.count === null ? [] : [db.prepare("INSERT INTO staffing_targets (restaurant_id, department_id, set_id, dow, slot, count) VALUES (?, ?, ?, ?, ?, ?)").bind(b.restaurant_id, b.department_id, setId, b.dow, slot, b.count)]),
    ]));
  } catch {
    return c.json({ error: "invalid_reference" }, 400);
  }
  return c.json({ ok: true });
});

// ---------- Seasons and special days ----------
const MD_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DATE_RE2 = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

// Returns the normalised rule or null when it is not valid for the given kind.
function validRule(kind: string, r: any): Record<string, unknown> | null {
  if (!r || typeof r !== "object") return null;
  if (kind === "season") return r.type === "range" && MD_RE.test(r.from) && MD_RE.test(r.to) ? { type: "range", from: r.from, to: r.to } : null;
  if (kind !== "special") return null;
  const days = r.days === undefined ? 1 : r.days;
  if (r.type === "date") return DATE_RE2.test(r.date) ? { type: "date", date: r.date } : null;
  if (r.type === "fixed") return MD_RE.test(r.md) && int(days, 1, 14) ? { type: "fixed", md: r.md, days } : null;
  if (r.type === "nth") return int(r.month, 1, 12) && int(r.weekday, 0, 6) && [1, 2, 3, 4, -1].includes(r.n) && int(days, 1, 14) ? { type: "nth", month: r.month, weekday: r.weekday, n: r.n, days } : null;
  if (r.type === "easter") return int(r.from, -7, 7) && int(r.to, -7, 7) && r.from <= r.to ? { type: "easter", from: r.from, to: r.to } : null;
  return null;
}

async function inRestaurant(db: D1Database, me: Me, restaurantId: number) {
  if (me.is_admin) return true;
  return (await viewableSchedules(db, me.id)).some((x) => x.restaurant_id === restaurantId);
}

app.get("/api/target-sets", async (c) => {
  const restaurantId = intParam(c.req.query("restaurant"));
  if (!restaurantId) return c.json({ error: "restaurant_required" }, 400);
  if (!(await inRestaurant(c.env.DB, c.get("me"), restaurantId))) return c.json({ error: "forbidden" }, 403);
  const r = await c.env.DB.prepare("SELECT id, name, kind, rule FROM target_sets WHERE restaurant_id = ? ORDER BY kind, id").bind(restaurantId).all<{ id: number; name: string; kind: string; rule: string }>();
  return c.json(r.results.map((x) => ({ ...x, rule: JSON.parse(x.rule) })));
});

app.post("/api/target-sets", requireAdmin, async (c) => {
  const b = await c.req.json<{ restaurant_id: number; name?: string; kind: string; rule: unknown }>();
  const rule = validRule(b.kind, b.rule);
  if (!b.name?.trim() || b.name.length > 80) return c.json({ error: "name_required" }, 400);
  if (!rule) return c.json({ error: "invalid_rule" }, 400);
  try {
    const r = await c.env.DB.prepare("INSERT INTO target_sets (restaurant_id, name, kind, rule) VALUES (?, ?, ?, ?)")
      .bind(b.restaurant_id, b.name.trim(), b.kind, JSON.stringify(rule))
      .run();
    return c.json({ id: r.meta.last_row_id }, 201);
  } catch {
    return c.json({ error: "invalid_reference" }, 400);
  }
});

app.put("/api/target-sets/:id", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const b = await c.req.json<{ name?: string; rule: unknown }>();
  if (!id) return c.json({ error: "bad_id" }, 400);
  const set = await c.env.DB.prepare("SELECT kind FROM target_sets WHERE id = ?").bind(id).first<{ kind: string }>();
  if (!set) return c.json({ error: "not_found" }, 404);
  const rule = validRule(set.kind, b.rule);
  if (!b.name?.trim() || !rule) return c.json({ error: rule ? "name_required" : "invalid_rule" }, 400);
  await c.env.DB.prepare("UPDATE target_sets SET name = ?, rule = ? WHERE id = ?").bind(b.name.trim(), JSON.stringify(rule), id).run();
  return c.json({ ok: true });
});

app.delete("/api/target-sets/:id", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM staffing_targets WHERE set_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM target_sets WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

// Which schedules an employee may look at (administrators only to change).
const DEPT_IDS = ["floor", "kitchen", "prep", "delivery", "admin"];
app.get("/api/staff/:id/view-access", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  const row = await c.env.DB.prepare("SELECT view_custom FROM staff WHERE id = ?").bind(id).first<{ view_custom: number }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const access = (await c.env.DB.prepare("SELECT restaurant_id, department_id FROM staff_view_access WHERE staff_id = ?").bind(id).all<{ restaurant_id: number; department_id: string }>()).results;
  return c.json({ custom: row.view_custom === 1, access });
});
app.put("/api/staff/:id/view-access", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const b = await c.req.json<{ custom?: boolean; access?: { restaurant_id: number; department_id: string }[] }>().catch(() => ({} as { custom?: boolean; access?: { restaurant_id: number; department_id: string }[] }));
  if (!id || typeof b.custom !== "boolean" || !Array.isArray(b.access) || b.access.length > 200) return c.json({ error: "bad_request" }, 400);
  if (b.access.some((x) => !Number.isInteger(x.restaurant_id) || !DEPT_IDS.includes(x.department_id))) return c.json({ error: "bad_request" }, 400);
  const db = c.env.DB;
  await db.batch([
    db.prepare("UPDATE staff SET view_custom = ? WHERE id = ?").bind(b.custom ? 1 : 0, id),
    db.prepare("DELETE FROM staff_view_access WHERE staff_id = ?").bind(id),
    ...b.access.map((x) => db.prepare("INSERT OR IGNORE INTO staff_view_access (staff_id, restaurant_id, department_id) VALUES (?, ?, ?)").bind(id, x.restaurant_id, x.department_id)),
  ]);
  return c.json({ ok: true });
});

// ---------- Staff (admin) ----------
app.get("/api/staff", async (c) => {
  const me = c.get("me");
  const db = c.env.DB;
  // Admins see everyone; managers see staff holding a role at a restaurant they manage.
  const sql = me.is_admin
    ? "SELECT id, name, email, phone FROM staff WHERE client_id = ?2 ORDER BY name"
    : `SELECT DISTINCT s.id, s.name, s.email, s.phone FROM staff s
       JOIN staff_roles sr ON sr.staff_id = s.id
       WHERE s.client_id = ?2 AND sr.restaurant_id IN (SELECT restaurant_id FROM managers WHERE staff_id = ?1) ORDER BY s.name`;
  return c.json(sortByName(((await db.prepare(sql).bind(me.id, me.client_id).all()).results) as { name: string }[]));
});

// first_name + last_name (or a single "name", split at the first space) -> { first, last, name = "First Last" }.
function namesFrom(b: { first_name?: string; last_name?: string; name?: string }) {
  const sp = b.first_name === undefined && b.last_name === undefined ? splitName(b.name) : { first: (b.first_name ?? "").trim(), last: (b.last_name ?? "").trim() };
  if (!sp.first || sp.first.length > 80 || sp.last.length > 80) return null;
  return { first: sp.first, last: sp.last, name: joinName(sp.first, sp.last) };
}

app.post("/api/staff", requireAdmin, async (c) => {
  const b = await c.req.json<{ first_name?: string; last_name?: string; name?: string; email?: string; phone?: string; is_admin?: boolean; sex?: string }>();
  const nm = namesFrom(b);
  if (!nm) return c.json({ error: "name_required" }, 400);
  try {
    const r = await c.env.DB.prepare("INSERT INTO staff (name, first_name, last_name, email, phone, is_admin, sex, client_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(nm.name, nm.first, nm.last, b.email?.trim().toLowerCase() || null, b.phone ?? null, b.is_admin ? 1 : 0, b.sex === "M" || b.sex === "F" ? b.sex : null, c.get("me").client_id)
      .run();
    emit(c, "staff.created", () => staffData(c.env.DB, r.meta.last_row_id as number));
    return c.json({ id: r.meta.last_row_id }, 201);
  } catch {
    return c.json({ error: "email_taken" }, 409);
  }
});

// ---------- Employee pictures ----------
// Visible to the person, admins, and anyone sharing a restaurant with them. Editable by the person, admins,
// and managers of a restaurant where the person works.
async function sharesRestaurant(db: D1Database, meId: number, staffId: number) {
  const r = await db
    .prepare(
      `SELECT 1 FROM (SELECT restaurant_id FROM staff_roles WHERE staff_id = ?1 UNION SELECT restaurant_id FROM managers WHERE staff_id = ?1) a
       JOIN (SELECT restaurant_id FROM staff_roles WHERE staff_id = ?2 UNION SELECT restaurant_id FROM managers WHERE staff_id = ?2) b USING (restaurant_id) LIMIT 1`,
    )
    .bind(meId, staffId)
    .first();
  return !!r;
}
async function canEditPhoto(db: D1Database, me: Me, staffId: number) {
  if (me.is_admin || me.id === staffId) return true;
  const r = await db
    .prepare("SELECT 1 FROM managers m JOIN staff_roles sr ON sr.restaurant_id = m.restaurant_id WHERE m.staff_id = ? AND sr.staff_id = ? LIMIT 1")
    .bind(me.id, staffId)
    .first();
  return !!r;
}

app.get("/api/staff/:id/photo", async (c) => {
  const id = intParam(c.req.param("id"));
  const me = c.get("me");
  if (!id) return c.json({ error: "bad_id" }, 400);
  if (!(me.is_admin || me.id === id || (await sharesRestaurant(c.env.DB, me.id, id)))) return c.json({ error: "forbidden" }, 403);
  const row = await c.env.DB.prepare("SELECT mime, data FROM staff_photos WHERE staff_id = ?").bind(id).first<{ mime: string; data: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const bytes = Uint8Array.from(atob(row.data), (ch) => ch.charCodeAt(0));
  // The client adds ?v=<updated_at>, so a new picture gets a new URL and the old one can be cached for good.
  return new Response(bytes, { headers: { "content-type": row.mime, "cache-control": "private, max-age=31536000, immutable" } });
});

app.put("/api/staff/:id/photo", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  if (!(await canEditPhoto(c.env.DB, c.get("me"), id))) return c.json({ error: "forbidden" }, 403);
  const { data_url } = await c.req.json<{ data_url?: string }>();
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data_url ?? "");
  if (!m || m[2].length > 200_000) return c.json({ error: "invalid_image" }, 400);
  const exists = await c.env.DB.prepare("SELECT 1 FROM staff WHERE id = ?").bind(id).first();
  if (!exists) return c.json({ error: "not_found" }, 404);
  const now = Date.now();
  await c.env.DB.prepare("INSERT OR REPLACE INTO staff_photos (staff_id, mime, data, updated_at) VALUES (?, ?, ?, ?)").bind(id, m[1], m[2], now).run();
  return c.json({ ok: true, photo_v: now });
});

app.delete("/api/staff/:id/photo", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  if (!(await canEditPhoto(c.env.DB, c.get("me"), id))) return c.json({ error: "forbidden" }, 403);
  await c.env.DB.prepare("DELETE FROM staff_photos WHERE staff_id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ---------- Settings (admin) ----------
app.get("/api/settings", requireAdmin, async (c) => c.json(await loadSettings(c.env.DB, c.get("me").client_id)));

app.put("/api/settings", requireAdmin, async (c) => {
  const rows = validateSettingsPatch(await c.req.json().catch(() => null));
  if (!rows) return c.json({ error: "invalid_setting" }, 400);
  const cid = c.get("me").client_id;
  await c.env.DB.batch(Object.entries(rows).map(([k, v]) => putSettingStmt(c.env.DB, cid, k, v)));
  return c.json(await loadSettings(c.env.DB, cid));
});

// ---------- Wages and labour cost (ADMIN ONLY) ----------
// Hourly rates never appear in any other endpoint. Managers and employees get 403 here.
app.put("/api/staff/:id/wage", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  const { hourly_rate, role_rates } = await c.req.json<{ hourly_rate?: string | number | null; role_rates?: Record<string, string | number | null> }>();
  const empty = hourly_rate === null || hourly_rate === undefined || hourly_rate === "";
  const cents = parseRate(hourly_rate);
  if (!empty && cents === null) return c.json({ error: "invalid_rate" }, 400);
  if (!(await c.env.DB.prepare("SELECT 1 FROM staff WHERE id = ?").bind(id).first())) return c.json({ error: "not_found" }, 404);
  if (cents === null) await c.env.DB.prepare("DELETE FROM staff_wages WHERE staff_id = ?").bind(id).run();
  else await c.env.DB.prepare("INSERT OR REPLACE INTO staff_wages (staff_id, hourly_cents) VALUES (?, ?)").bind(id, cents).run();
  // Optional per-role rates: { "<role_id>": "17.25" | "" } (empty = use the general rate).
  const saved: Record<string, number> = {};
  if (role_rates) {
    const stmts: D1PreparedStatement[] = [];
    for (const [rid, v] of Object.entries(role_rates)) {
      const roleId = intParam(rid);
      const rc = parseRate(v);
      const blank = v === null || v === undefined || v === "";
      if (!roleId || (!blank && rc === null)) return c.json({ error: "invalid_rate" }, 400);
      if (rc === null) stmts.push(c.env.DB.prepare("DELETE FROM staff_role_wages WHERE staff_id = ? AND role_id = ?").bind(id, roleId));
      else { stmts.push(c.env.DB.prepare("INSERT OR REPLACE INTO staff_role_wages (staff_id, role_id, hourly_cents) VALUES (?, ?, ?)").bind(id, roleId, rc)); saved[rid] = rc; }
    }
    if (stmts.length) await c.env.DB.batch(stmts);
  }
  return c.json({ ok: true, hourly_cents: cents, role_rates: saved });
});

// Default rates: one general rate plus optional per-role rates (tipped roles). Used when an employee has no rate of their own.
async function defaultRates(db: D1Database, clientId: number) {
  const g = await getSetting(db, clientId, "default_hourly_cents");
  const roles = (await rolesFor(db, clientId)).filter((r) => r.default_hourly_cents != null);
  return { general_cents: g ? Number(g) : null, roles: Object.fromEntries(roles.map((r) => [r.id, r.default_hourly_cents])) };
}
app.get("/api/admin/default-rates", requireAdmin, async (c) => c.json(await defaultRates(c.env.DB, c.get("me").client_id)));
app.put("/api/admin/default-rates", requireAdmin, async (c) => {
  const cid = c.get("me").client_id;
  const b = await c.req.json<{ general?: string | number | null; roles?: Record<string, string | number | null> }>();
  const stmts: D1PreparedStatement[] = [];
  if (b.general !== undefined) {
    const cents = parseRate(b.general);
    if (b.general !== null && b.general !== "" && cents === null) return c.json({ error: "invalid_rate" }, 400);
    stmts.push(cents === null ? delSettingStmt(c.env.DB, cid, "default_hourly_cents") : putSettingStmt(c.env.DB, cid, "default_hourly_cents", String(cents)));
  }
  for (const [rid, v] of Object.entries(b.roles ?? {})) {
    const roleId = intParam(rid), cents = parseRate(v);
    if (!roleId || (v !== null && v !== "" && cents === null)) return c.json({ error: "invalid_rate" }, 400);
    if (cid === 1) stmts.push(c.env.DB.prepare("UPDATE roles SET default_hourly_cents = ? WHERE id = ?").bind(cents, roleId));
    else stmts.push(cents === null ? delSettingStmt(c.env.DB, cid, `rate_${roleId}`) : putSettingStmt(c.env.DB, cid, `rate_${roleId}`, String(cents)));
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json(await defaultRates(c.env.DB, cid));
});

// SQL for "this role's default rate" and "the general default rate" of a client (ids come from the database, never from the user).
const roleRateSql = (cid: number) => (cid === 1 ? "ro.default_hourly_cents" : `(SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'c${cid}:rate_' || ro.id)`);
const generalRateSql = (cid: number) => `(SELECT CAST(value AS INTEGER) FROM settings WHERE key = '${settingKey(cid, "default_hourly_cents")}')`;

// GET /api/admin/payroll?restaurant=1&department=kitchen&week=2026-10-26
// -> labour cost of that department (per day and per clock hour) and of the whole restaurant.
app.get("/api/admin/payroll", requireAdmin, async (c) => {
  const restaurantId = intParam(c.req.query("restaurant"));
  const department = c.req.query("department");
  const weekStart = c.req.query("week") ?? "";
  const cid = c.get("me").client_id;
  const bounds = weekBounds(weekStart);
  if (!restaurantId || !department) return c.json({ error: "restaurant_and_department_required" }, 400);
  if (!bounds) return c.json({ error: "week_must_be_a_monday" }, 400);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${weekStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  // include the night before so a shift running past midnight into Monday is counted
  const prev = new Date(`${weekStart}T00:00:00Z`);
  prev.setUTCDate(prev.getUTCDate() - 1);
  const from = `${prev.toISOString().slice(0, 10)}T00:00`;
  const rows = await c.env.DB.prepare(
    `SELECT sh.id, sh.start_at, sh.end_at, ro.department_id, COALESCE(rw.hourly_cents, w.hourly_cents, ${roleRateSql(cid)}, ${generalRateSql(cid)}) AS rate_cents
     FROM shifts sh JOIN roles ro ON ro.id = sh.role_id LEFT JOIN staff_wages w ON w.staff_id = sh.staff_id
          LEFT JOIN staff_role_wages rw ON rw.staff_id = sh.staff_id AND rw.role_id = sh.role_id
     WHERE sh.restaurant_id = ? AND sh.status = 'ok' AND sh.start_at >= ? AND sh.start_at < ?`,
  )
    .bind(restaurantId, from, bounds.end)
    .all<{ id: number; start_at: string; end_at: string; department_id: string; rate_cents: number | null }>();
  // A shift covering several roles (cook + dishwasher) is paid at the highest of their rates; its cost stays in the main role's department.
  const extra = await c.env.DB.prepare(
    `SELECT x.shift_id, COALESCE(rw.hourly_cents, w.hourly_cents, ${roleRateSql(cid)}, ${generalRateSql(cid)}) AS rate_cents
     FROM (SELECT shift_id, role_id FROM shift_roles UNION SELECT shift_id, role_id FROM shift_segments) x JOIN shifts sh ON sh.id = x.shift_id JOIN roles ro ON ro.id = x.role_id
          LEFT JOIN staff_wages w ON w.staff_id = sh.staff_id LEFT JOIN staff_role_wages rw ON rw.staff_id = sh.staff_id AND rw.role_id = x.role_id
     WHERE sh.restaurant_id = ? AND sh.status = 'ok' AND sh.start_at >= ? AND sh.start_at < ?`,
  ).bind(restaurantId, from, bounds.end).all<{ shift_id: number; rate_cents: number | null }>();
  const best = new Map<number, number>();
  for (const e of extra.results) if (e.rate_cents != null) best.set(e.shift_id, Math.max(best.get(e.shift_id) ?? 0, e.rate_cents));
  for (const r of rows.results) { const b = best.get(r.id); if (b != null && (r.rate_cents == null || b > r.rate_cents)) r.rate_cents = b; }
  const dept = computeCosts(rows.results.filter((r) => r.department_id === department), days);
  const all = computeCosts(rows.results, days);
  return c.json({ week: weekStart, department: dept, restaurant: { total_cents: all.total_cents, total_hours: all.total_hours, unrated_hours: all.unrated_hours, days: all.days.map((d) => ({ date: d.date, cents: d.cents })) } });
});

// ---------- My account: contact details and calendar subscription ----------
const newToken = () => { const b = crypto.getRandomValues(new Uint8Array(24)); return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };

async function accountView(c: Context<any>) {
  const me = c.get("me");
  const env = c.env as Env;
  const row = await env.DB.prepare("SELECT name, email, phone, lang, notify_channel FROM staff WHERE id = ?").bind(me.id).first();
  const tok = await env.DB.prepare("SELECT token FROM calendar_tokens WHERE staff_id = ?").bind(me.id).first<{ token: string }>();
  const base = (env.APP_URL ?? new URL(c.req.url).origin).replace(/\/$/, "");
  return { ...row, calendar_url: tok ? `${base}/cal/${tok.token}.ics` : null };
}
app.get("/api/account", async (c) => c.json(await accountView(c)));
app.put("/api/account", async (c) => {
  const b = await c.req.json<{ phone?: string; lang?: string; notify_channel?: string }>();
  const phone = b.phone?.trim() ? normalizePhone(b.phone) : null;
  if (b.phone?.trim() && !phone) return c.json({ error: "invalid_phone" }, 400);
  await c.env.DB.prepare("UPDATE staff SET phone = ?, lang = ?, notify_channel = ? WHERE id = ?")
    .bind(phone, b.lang === "en" ? "en" : "fr", b.notify_channel === "email" ? "email" : "sms", c.get("me").id).run();
  return c.json(await accountView(c));
});
// Creates the personal calendar link, or replaces it (the old link then stops working).
// Reminders before a shift (the person's own settings).
app.get("/api/account/reminders", async (c) =>
  c.json((await c.env.DB.prepare("SELECT minutes_before, channel, anchor FROM shift_reminders WHERE staff_id = ? ORDER BY anchor, minutes_before DESC").bind(c.get("me").id).all()).results));
app.put("/api/account/reminders", async (c) => {
  const b = await c.req.json<{ items?: { minutes_before?: number; channel?: string; anchor?: string }[] }>().catch(() => ({} as { items?: { minutes_before?: number; channel?: string; anchor?: string }[] }));
  const items = b.items ?? [];
  if (!Array.isArray(items) || items.length > MAX_REMINDERS) return c.json({ error: "too_many" }, 400);
  const seen = new Set<string>();
  for (const x of items) {
    if (!Number.isInteger(x.minutes_before) || x.minutes_before! < 5 || x.minutes_before! > 2880 || !(REMINDER_CHANNELS as readonly string[]).includes(x.channel ?? "")) return c.json({ error: "invalid_reminder" }, 400);
    if (x.anchor !== undefined && x.anchor !== "start" && x.anchor !== "end") return c.json({ error: "invalid_reminder" }, 400);
    const key = `${x.minutes_before}|${x.channel}|${x.anchor ?? "start"}`;
    if (seen.has(key)) return c.json({ error: "duplicate" }, 400);
    seen.add(key);
  }
  const id = c.get("me").id;
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM shift_reminders WHERE staff_id = ?").bind(id),
    ...items.map((x) => c.env.DB.prepare("INSERT INTO shift_reminders (staff_id, minutes_before, channel, anchor) VALUES (?, ?, ?, ?)").bind(id, x.minutes_before, x.channel, x.anchor ?? "start")),
  ]);
  return c.json({ ok: true });
});

app.post("/api/account/calendar-token", async (c) => {
  await c.env.DB.prepare("INSERT OR REPLACE INTO calendar_tokens (staff_id, token, created_at) VALUES (?, ?, ?)").bind(c.get("me").id, newToken(), Date.now()).run();
  return c.json(await accountView(c));
});
app.delete("/api/account/calendar-token", async (c) => {
  await c.env.DB.prepare("DELETE FROM calendar_tokens WHERE staff_id = ?").bind(c.get("me").id).run();
  return c.json(await accountView(c));
});

// ---------- SIN and pay slips ----------
// The SIN is stored only as a keyed hash plus its last 3 digits. The key is the SIN_KEY secret, or one generated once and kept in settings.
async function sinKey(env: Env): Promise<string> {
  if (env.SIN_KEY?.trim()) return env.SIN_KEY.trim();
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'sin_key'").first<{ value: string }>();
  if (row) return row.value;
  const k = newToken() + newToken();
  await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('sin_key', ?)").bind(k).run();
  return (await env.DB.prepare("SELECT value FROM settings WHERE key = 'sin_key'").first<{ value: string }>())!.value;
}
async function anthropicKey(env: Env, clientId: number): Promise<string | null> {
  const own = await getSetting(env.DB, clientId, "conn_anthropic_key");
  if (own) return own;
  return clientId === 1 && env.ANTHROPIC_API_KEY?.trim() ? env.ANTHROPIC_API_KEY.trim() : null;
}

app.put("/api/staff/:id/sin", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  const { sin } = await c.req.json<{ sin?: string | null }>();
  if (!(await c.env.DB.prepare("SELECT 1 FROM staff WHERE id = ?").bind(id).first())) return c.json({ error: "not_found" }, 404);
  if (sin === null || sin === undefined || sin === "") {
    await c.env.DB.prepare("DELETE FROM staff_sin WHERE staff_id = ?").bind(id).run();
    return c.json({ ok: true, sin_last3: null });
  }
  const digits = normalizeSin(sin);
  if (!digits) return c.json({ error: "invalid_sin" }, 400);
  const hash = await hashSin(await sinKey(c.env), digits);
  const clash = await c.env.DB.prepare("SELECT staff_id FROM staff_sin WHERE sin_hash = ? AND staff_id != ?").bind(hash, id).first();
  if (clash) return c.json({ error: "sin_already_used" }, 409);
  await c.env.DB.prepare("INSERT OR REPLACE INTO staff_sin (staff_id, sin_hash, last3) VALUES (?, ?, ?)").bind(id, hash, digits.slice(-3)).run();
  return c.json({ ok: true, sin_last3: digits.slice(-3) });
});

app.get("/api/admin/payslip-setup", requireAdmin, async (c) => c.json({ ai_configured: !!(await anthropicKey(c.env, c.get("me").client_id)), max_bytes: MAX_PDF_BYTES }));
app.put("/api/admin/payslip-setup", requireAdmin, async (c) => {
  const { anthropic_key } = await c.req.json<{ anthropic_key?: string | null }>();
  const cid = c.get("me").client_id;
  if (!anthropic_key) await delSettingStmt(c.env.DB, cid, "conn_anthropic_key").run();
  else if (!/^sk-ant-[\w-]{20,}$/.test(anthropic_key.trim())) return c.json({ error: "invalid_key" }, 400);
  else await putSettingStmt(c.env.DB, cid, "conn_anthropic_key", anthropic_key.trim()).run();
  return c.json({ ai_configured: !!(await anthropicKey(c.env, cid)) });
});

// One PDF per request (the browser sends the files of a batch one after the other). The AI reads it and proposes an employee.
app.post("/api/admin/payslips", requireAdmin, async (c) => {
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > MAX_PDF_BYTES) return c.json({ error: "file_too_large", max_bytes: MAX_PDF_BYTES }, 413);
  if (!isPdf(bytes)) return c.json({ error: "not_a_pdf" }, 400);
  const filename = decodeURIComponent(c.req.header("X-Filename") ?? "payslip.pdf").replace(/[^\w .()-]/g, "_").slice(0, 120);
  const b64 = bytesToBase64(bytes);
  const cid = c.get("me").client_id;
  const key = await anthropicKey(c.env, cid);
  const ex = key ? await extractPayslip(key, b64).catch(() => null) : null;
  const people = (await c.env.DB.prepare("SELECT s.id, s.name, ss.sin_hash FROM staff s LEFT JOIN staff_sin ss ON ss.staff_id = s.id WHERE s.client_id = ?").bind(cid).all<{ id: number; name: string; sin_hash: string | null }>()).results;
  const m = ex ? await chooseMatch(ex, people, await sinKey(c.env)) : { staff_id: null, kind: "none" as const };
  const sinDigits = ex ? normalizeSin(ex.sin) : null;
  const r = await c.env.DB.prepare(
    `INSERT INTO payslips (filename, content_b64, size, status, period_label, pay_date, extracted_name, extracted_last3, suggested_staff_id, match_kind, uploaded_by, uploaded_at, client_id)
     VALUES (?, ?, ?, 'review', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(filename, b64, bytes.length, ex?.period ?? null, ex?.pay_date ?? null, ex?.employee_name ?? null, sinDigits ? sinDigits.slice(-3) : null, m.staff_id, m.kind, c.get("me").id, Date.now(), cid).run();
  return c.json({ id: r.meta.last_row_id, read_by_ai: !!ex, match: m.kind }, 201);
});

app.get("/api/admin/payslips", requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.filename, p.size, p.period_label, p.pay_date, p.extracted_name, p.extracted_last3, p.match_kind, p.suggested_staff_id, sg.name AS suggested_name,
            (SELECT last3 FROM staff_sin WHERE staff_id = p.suggested_staff_id) AS suggested_last3, p.uploaded_at
     FROM payslips p LEFT JOIN staff sg ON sg.id = p.suggested_staff_id WHERE p.status = 'review' AND p.client_id = ? ORDER BY p.id`,
  ).bind(c.get("me").client_id).all();
  return c.json(rows.results);
});

app.post("/api/admin/payslips/:id/assign", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const { staff_id } = await c.req.json<{ staff_id?: number }>();
  if (!id || !staff_id) return c.json({ error: "bad_request" }, 400);
  if (!(await c.env.DB.prepare("SELECT 1 FROM staff WHERE id = ?").bind(staff_id).first())) return c.json({ error: "staff_not_found" }, 404);
  const r = await c.env.DB.prepare("UPDATE payslips SET staff_id = ?, status = 'assigned', assigned_at = ? WHERE id = ? AND status = 'review'").bind(staff_id, Date.now(), id).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

app.delete("/api/admin/payslips/:id", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  await c.env.DB.prepare("DELETE FROM payslips WHERE id = ? AND status = 'review'").bind(id).run();
  return c.json({ ok: true });
});

const pdfResponse = (c: Context<any>, filename: string, b64: string) => {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return c.body(out, 200, { "content-type": "application/pdf", "content-disposition": `inline; filename="${filename.replace(/"/g, "")}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
};
// Admin may open a slip only while it is still waiting for confirmation (to check where it belongs).
app.get("/api/admin/payslips/:id/pdf", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const row = id ? await c.env.DB.prepare("SELECT filename, content_b64 FROM payslips WHERE id = ? AND status = 'review'").bind(id).first<{ filename: string; content_b64: string }>() : null;
  return row ? pdfResponse(c, row.filename, row.content_b64) : c.json({ error: "not_found" }, 404);
});

// Employees: only their own, only once assigned.
app.get("/api/payslips", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, filename, period_label, pay_date, size FROM payslips WHERE staff_id = ? AND status = 'assigned' ORDER BY COALESCE(pay_date, '') DESC, id DESC").bind(c.get("me").id).all();
  return c.json(rows.results);
});
app.get("/api/payslips/:id/pdf", async (c) => {
  const id = intParam(c.req.param("id"));
  const row = id ? await c.env.DB.prepare("SELECT filename, content_b64 FROM payslips WHERE id = ? AND staff_id = ? AND status = 'assigned'").bind(id, c.get("me").id).first<{ filename: string; content_b64: string }>() : null;
  return row ? pdfResponse(c, row.filename, row.content_b64) : c.json({ error: "not_found" }, 404);
});

// ---------- Time off (congé demandé / accordé) ----------
const DATE_RE3 = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// Managers who must hear about / decide a request: managers of every restaurant+department where the person works, plus admins.
async function approversOf(db: D1Database, staffId: number): Promise<number[]> {
  const r = await db.prepare(
    `SELECT DISTINCT m.staff_id FROM managers m
       JOIN (SELECT DISTINCT sr.restaurant_id, ro.department_id FROM staff_roles sr JOIN roles ro ON ro.id = sr.role_id WHERE sr.staff_id = ?) x
         ON x.restaurant_id = m.restaurant_id AND x.department_id = m.department_id
     UNION SELECT id FROM staff WHERE is_admin = 1 AND active = 1 AND client_id = (SELECT client_id FROM staff WHERE id = ?1)`,
  ).bind(staffId).all<{ staff_id: number }>();
  return r.results.map((x) => x.staff_id);
}
async function canDecideFor(db: D1Database, me: Me, staffId: number) {
  return me.is_admin || (me.id !== staffId && (await approversOf(db, staffId)).includes(me.id));
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
app.post("/api/time-off", async (c) => {
  const me = c.get("me");
  const b = await c.req.json<{ staff_id?: number; start_date?: string; end_date?: string; start_time?: string; end_time?: string; note?: string }>();
  const start = b.start_date ?? "", end = b.end_date || start;
  if (!DATE_RE3.test(start) || !DATE_RE3.test(end) || start > end) return c.json({ error: "invalid_dates" }, 400);
  // Optional part of the day (same hours on every day of the range).
  const st = b.start_time || null, et = b.end_time || null;
  if ((st && !HHMM_RE.test(st)) || (et && !HHMM_RE.test(et)) || (!!st !== !!et) || (st && et && st >= et)) return c.json({ error: "invalid_times" }, 400);
  // A manager or admin can enter time off for an employee: it is approved at once.
  const forOther = !!b.staff_id && b.staff_id !== me.id;
  const staffId = forOther ? b.staff_id! : me.id;
  if (forOther && !(await canDecideFor(c.env.DB, me, staffId))) return c.json({ error: "forbidden" }, 403);
  if (!forOther && end < localNow(c.env.TIMEZONE).slice(0, 10)) return c.json({ error: "in_the_past" }, 400);
  const target = await c.env.DB.prepare("SELECT id, name, phone, email, lang, notify_channel FROM staff WHERE id = ?").bind(staffId).first<any>();
  if (!target) return c.json({ error: "not_found" }, 404);
  const same = (await c.env.DB.prepare("SELECT start_time, end_time FROM time_off_requests WHERE staff_id = ? AND status IN ('requested','approved') AND start_date <= ? AND end_date >= ?").bind(staffId, end, start).all<{ start_time: string | null; end_time: string | null }>()).results;
  if (same.some((o) => !o.start_time || !st || (o.start_time < et! && st < o.end_time!))) return c.json({ error: "already_requested" }, 409);
  const note = b.note?.trim().slice(0, 300) || null;
  const r = await c.env.DB.prepare("INSERT INTO time_off_requests (staff_id, start_date, end_date, start_time, end_time, note, status, decided_by, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(staffId, start, end, st, et, note, forOther ? "approved" : "requested", forOther ? me.id : null, forOther ? Date.now() : null, Date.now()).run();
  try {
    const conn = await loadConnections(c.env, c.env.DB, c.get("me").client_id);
    if (forOther) await notifyStaff(c.env.DB, conn, target, (l) => T.timeOffDecision(l, { approved: true, from: start, to: end, note }), "time_off_decision");
    else {
      const ids = (await approversOf(c.env.DB, me.id)).filter((id) => id !== me.id);
      if (ids.length) {
        const people = (await c.env.DB.prepare(`SELECT id, name, phone, email, lang, notify_channel FROM staff WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<any>()).results;
        for (const p of people) await notifyStaff(c.env.DB, conn, p, (l) => T.timeOffRequest(l, { name: me.name, from: start, to: end, note }), "time_off_request");
      }
    }
  } catch { /* messaging problems never block the request */ }
  emit(c, forOther ? "time_off.decided" : "time_off.requested", () => timeOffData(c.env.DB, r.meta.last_row_id as number));
  return c.json({ id: r.meta.last_row_id, status: forOther ? "approved" : "requested" }, 201);
});

// People a manager/admin may enter time off for.
app.get("/api/time-off/people", async (c) => {
  const me = c.get("me");
  const rows = sortByName((await c.env.DB.prepare("SELECT id, name FROM staff WHERE active = 1 AND client_id = ?").bind(me.client_id).all<{ id: number; name: string }>()).results);
  if (me.is_admin) return c.json(rows);
  const out = [];
  for (const r of rows) if (r.id !== me.id && (await approversOf(c.env.DB, r.id)).includes(me.id)) out.push(r);
  return c.json(out);
});

app.get("/api/time-off/mine", async (c) => {
  const r = await c.env.DB.prepare("SELECT id, start_date, end_date, start_time, end_time, note, status, decision_note FROM time_off_requests WHERE staff_id = ? AND end_date >= date('now','-60 day') ORDER BY start_date DESC").bind(c.get("me").id).all();
  return c.json(r.results);
});

app.post("/api/time-off/:id/cancel", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  const r = await c.env.DB.prepare("UPDATE time_off_requests SET status = 'cancelled' WHERE id = ? AND staff_id = ? AND status IN ('requested','approved')").bind(id, c.get("me").id).run();
  if (r.meta.changes) emit(c, "time_off.cancelled", () => timeOffData(c.env.DB, id));
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

// Requests the caller may decide on: still waiting, plus the recently decided ones (so a decision can be changed).
// Everything requested by one employee (for the employee dialog): admin, or a manager of that employee.
app.get("/api/time-off/staff/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  if (!(await canDecideFor(c.env.DB, c.get("me"), id))) return c.json({ error: "forbidden" }, 403);
  const r = await c.env.DB.prepare("SELECT id, start_date, end_date, start_time, end_time, note, status, decision_note FROM time_off_requests WHERE staff_id = ? AND status != 'cancelled' AND end_date >= date('now','-30 day') ORDER BY start_date DESC LIMIT 100").bind(id).all();
  return c.json(r.results);
});

// A manager or admin can withdraw a leave they or the employee entered.
app.post("/api/time-off/:id/withdraw", async (c) => {
  const id = intParam(c.req.param("id"));
  const row = id ? await c.env.DB.prepare("SELECT staff_id FROM time_off_requests WHERE id = ?").bind(id).first<{ staff_id: number }>() : null;
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!(await canDecideFor(c.env.DB, c.get("me"), row.staff_id))) return c.json({ error: "forbidden" }, 403);
  await c.env.DB.prepare("UPDATE time_off_requests SET status = 'cancelled' WHERE id = ?").bind(id).run();
  emit(c, "time_off.cancelled", () => timeOffData(c.env.DB, id!));
  return c.json({ ok: true });
});

app.get("/api/time-off/review", async (c) => {
  const me = c.get("me");
  const rows = (await c.env.DB.prepare(
    `SELECT t.id, t.staff_id, s.name AS staff_name, t.start_date, t.end_date, t.start_time, t.end_time, t.note, t.status, t.decision_note
     FROM time_off_requests t JOIN staff s ON s.id = t.staff_id
     WHERE s.client_id = ? AND t.status != 'cancelled' AND (t.status = 'requested' OR t.end_date >= date('now','-14 day')) AND t.end_date >= date('now','-14 day')
     ORDER BY (t.status = 'requested') DESC, t.start_date LIMIT 200`,
  ).bind(me.client_id).all<{ staff_id: number }>()).results;
  if (me.is_admin) return c.json(rows);
  const out = [];
  const cache = new Map<number, boolean>();
  for (const r of rows) {
    if (!cache.has(r.staff_id)) cache.set(r.staff_id, await canDecideFor(c.env.DB, me, r.staff_id));
    if (cache.get(r.staff_id)) out.push(r);
  }
  return c.json(out);
});

app.post("/api/time-off/:id/decide", async (c) => {
  const id = intParam(c.req.param("id"));
  const { approve, note } = await c.req.json<{ approve?: boolean; note?: string }>();
  if (!id || typeof approve !== "boolean") return c.json({ error: "bad_request" }, 400);
  const row = await c.env.DB.prepare("SELECT staff_id, start_date, end_date, status FROM time_off_requests WHERE id = ?").bind(id).first<{ staff_id: number; start_date: string; end_date: string; status: string }>();
  if (!row || row.status === "cancelled") return c.json({ error: "not_found" }, 404);
  if (!(await canDecideFor(c.env.DB, c.get("me"), row.staff_id))) return c.json({ error: "forbidden" }, 403);
  const dn = note?.trim().slice(0, 300) || null;
  await c.env.DB.prepare("UPDATE time_off_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?").bind(approve ? "approved" : "denied", c.get("me").id, Date.now(), dn, id).run();
  emit(c, "time_off.decided", () => timeOffData(c.env.DB, id));
  try {
    const person = await c.env.DB.prepare("SELECT id, name, phone, email, lang, notify_channel FROM staff WHERE id = ?").bind(row.staff_id).first<any>();
    if (person) await notifyStaff(c.env.DB, await loadConnections(c.env, c.env.DB, c.get("me").client_id), person, (l) => T.timeOffDecision(l, { approved: approve, from: row.start_date, to: row.end_date, note: dn }), "time_off_decision");
  } catch { /* ignore */ }
  // Shifts already planned on those days: tell the manager so they can be moved.
  const clash = await c.env.DB.prepare("SELECT count(*) AS n FROM shifts WHERE staff_id = ? AND status = 'ok' AND substr(start_at,1,10) >= ? AND substr(start_at,1,10) <= ?").bind(row.staff_id, row.start_date, row.end_date).first<{ n: number }>();
  return c.json({ ok: true, shifts_on_those_days: approve ? clash?.n ?? 0 : 0 });
});

// ---------- One employee's attendance file (ADMIN ONLY): announced absences + incidents entered by a manager ----------
// "announced" = the employee declared it before the shift began; "late" = declared once the shift had begun;
// "by_manager" = a manager declared the absence for them. Incidents (no-show, late arrival, early departure) are recorded by managers only.
app.get("/api/staff/:id/attendance", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  const tz = c.env.TIMEZONE ?? "America/Toronto";
  const rows = (await c.env.DB.prepare(
    `SELECT a.id, a.start_at, a.end_at, a.reason, a.note, a.declared_by, a.declared_at, a.outcome, rs.name AS restaurant, ro.name_fr, ro.name_en, ro.department_id,
            (SELECT name FROM staff WHERE id = a.declared_by) AS declared_by_name, (SELECT name FROM staff WHERE id = a.replaced_by) AS replaced_by_name
     FROM staff_absences a JOIN restaurants rs ON rs.id = a.restaurant_id LEFT JOIN roles ro ON ro.id = a.role_id
     WHERE a.staff_id = ? ORDER BY a.start_at DESC LIMIT 300`,
  ).bind(id).all<any>()).results;
  const absences = rows.map((a) => ({
    ...a,
    kind: a.declared_by !== id ? "by_manager" : localNow(tz, new Date(a.declared_at)) < a.start_at ? "announced" : "late",
  }));
  const incidents = (await c.env.DB.prepare(
    `SELECT i.id, i.incident_date, i.kind, i.minutes, i.notes, rs.name AS restaurant, rb.name AS recorded_by_name
     FROM incidents i LEFT JOIN restaurants rs ON rs.id = i.restaurant_id LEFT JOIN staff rb ON rb.id = i.recorded_by
     WHERE i.staff_id = ? ORDER BY i.incident_date DESC, i.id DESC LIMIT 300`,
  ).bind(id).all<any>()).results;
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const count = (f: (x: any) => boolean) => absences.filter((a) => a.start_at.slice(0, 10) >= since && f(a)).length;
  return c.json({
    absences, incidents,
    last_12_months: {
      announced: count((a) => a.kind === "announced"), late: count((a) => a.kind === "late"), by_manager: count((a) => a.kind === "by_manager"),
      no_show: incidents.filter((i) => i.incident_date >= since && i.kind === "no_call_no_show").length,
      late_arrival: incidents.filter((i) => i.incident_date >= since && i.kind === "late_arrival").length,
      early_departure: incidents.filter((i) => i.incident_date >= since && i.kind === "early_departure").length,
    },
  });
});

// ---------- Attendance incidents (ADMIN ONLY) ----------
// A private record of no call / no show, late arrivals and early departures that were not granted.
// Employees and managers never see these: every endpoint requires admin.
const INCIDENT_KINDS = ["no_call_no_show", "late_arrival", "early_departure"];

app.get("/api/admin/incidents", requireAdmin, async (c) => {
  const staffId = intParam(c.req.query("staff"));
  const rows = await c.env.DB.prepare(
    `SELECT i.id, i.staff_id, s.name AS staff_name, i.shift_id, i.restaurant_id, rs.name AS restaurant, i.incident_date, i.kind, i.minutes, i.notes, rb.name AS recorded_by_name, i.created_at
     FROM incidents i JOIN staff s ON s.id = i.staff_id LEFT JOIN restaurants rs ON rs.id = i.restaurant_id LEFT JOIN staff rb ON rb.id = i.recorded_by
     WHERE s.client_id = ?2 AND (?1 IS NULL OR i.staff_id = ?1) ORDER BY i.incident_date DESC, i.id DESC LIMIT 500`,
  ).bind(staffId ?? null, c.get("me").client_id).all();
  const counts = await c.env.DB.prepare(
    `SELECT i.staff_id, s.name AS staff_name,
            sum(i.kind = 'no_call_no_show') AS no_shows, sum(i.kind = 'late_arrival') AS lates, sum(i.kind = 'early_departure') AS early, count(*) AS total
     FROM incidents i JOIN staff s ON s.id = i.staff_id WHERE s.client_id = ? AND i.incident_date >= date('now', '-365 day') GROUP BY i.staff_id ORDER BY total DESC, s.name`,
  ).bind(c.get("me").client_id).all();
  return c.json({ incidents: rows.results, last_12_months: counts.results });
});

// Administrators, and the managers of an employee's department, record incidents (no-show, late arrival, early departure).
// Only administrators can read or delete them.
app.post("/api/admin/incidents", async (c) => {
  const me = c.get("me");
  const b = await c.req.json<{ staff_id?: number; shift_id?: number | null; incident_date?: string; kind?: string; minutes?: number | null; notes?: string }>();
  if (!b.staff_id || !INCIDENT_KINDS.includes(b.kind ?? "")) return c.json({ error: "bad_request" }, 400);
  if (!DATE_RE3.test(b.incident_date ?? "")) return c.json({ error: "invalid_dates" }, 400);
  const needsMinutes = b.kind !== "no_call_no_show";
  const minutes = b.minutes ?? null;
  if (minutes !== null && !(Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440)) return c.json({ error: "invalid_minutes" }, 400);
  if (!(await c.env.DB.prepare("SELECT 1 FROM staff WHERE id = ?").bind(b.staff_id).first())) return c.json({ error: "not_found" }, 404);
  if (!(await canDecideFor(c.env.DB, me, b.staff_id))) return c.json({ error: "forbidden" }, 403); // not an administrator or a manager of that employee, or yourself
  let restaurantId: number | null = null;
  if (b.shift_id) {
    const sh = await c.env.DB.prepare("SELECT sh.restaurant_id, sh.staff_id, ro.department_id FROM shifts sh JOIN roles ro ON ro.id = sh.role_id WHERE sh.id = ?").bind(b.shift_id).first<{ restaurant_id: number; staff_id: number; department_id: string }>();
    if (!sh) return c.json({ error: "shift_not_found" }, 404);
    if (!me.is_admin && (sh.staff_id !== b.staff_id || !(await canManage(c.env.DB, me, sh.restaurant_id, sh.department_id)))) return c.json({ error: "forbidden" }, 403);
    restaurantId = sh.restaurant_id;
  }
  const r = await c.env.DB.prepare("INSERT INTO incidents (staff_id, shift_id, restaurant_id, incident_date, kind, minutes, notes, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(b.staff_id, b.shift_id ?? null, restaurantId, b.incident_date, b.kind, needsMinutes ? minutes : null, b.notes?.trim().slice(0, 1000) || null, c.get("me").id, Date.now()).run();
  return c.json({ id: r.meta.last_row_id }, 201);
});

app.delete("/api/admin/incidents/:id", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  await c.env.DB.prepare("DELETE FROM incidents WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// An employee's shifts around a date, to link an incident to the right shift.
app.get("/api/admin/staff/:id/shifts", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id || !(await canDecideFor(c.env.DB, c.get("me"), id))) return c.json({ error: "forbidden" }, 403);
  const date = c.req.query("date") ?? "";
  if (!id || !DATE_RE3.test(date)) return c.json({ error: "bad_request" }, 400);
  const r = await c.env.DB.prepare(
    `SELECT sh.id, sh.start_at, sh.end_at, sh.until_close, rs.name AS restaurant, ro.name_fr, ro.name_en, (SELECT sex FROM staff WHERE id = sh.staff_id) AS sex FROM shifts sh JOIN restaurants rs ON rs.id = sh.restaurant_id JOIN roles ro ON ro.id = sh.role_id
     WHERE sh.staff_id = ? AND substr(sh.start_at, 1, 10) = ? ORDER BY sh.start_at`,
  ).bind(id, date).all();
  return c.json(r.results);
});

// ---------- Weekly unavailability (school schedule…) and personal hour limits ----------
// Employees enter their own; a manager of that employee, or an admin, can enter them too.
async function canEditPerson(c: Context<any>, staffId: number) {
  const me = c.get("me") as Me;
  return me.id === staffId || (await canDecideFor((c.env as Env).DB, me, staffId));
}

app.get("/api/availability", async (c) => {
  const staffId = intParam(c.req.query("staff")) ?? c.get("me").id;
  if (!(await canEditPerson(c, staffId))) return c.json({ error: "forbidden" }, 403);
  const r = await c.env.DB.prepare("SELECT id, dow, start_time, end_time, note, kind, replacement_ok, valid_from, valid_to FROM staff_availability WHERE staff_id = ? ORDER BY dow, start_time").bind(staffId).all();
  return c.json(r.results);
});

app.post("/api/availability", async (c) => {
  const b = await c.req.json<{ staff_id?: number; dow?: number; kind?: string; start_time?: string; end_time?: string; note?: string; valid_from?: string; valid_to?: string }>();
  const staffId = b.staff_id ?? c.get("me").id;
  if (!(await canEditPerson(c, staffId))) return c.json({ error: "forbidden" }, 403);
  if (!Number.isInteger(b.dow) || b.dow! < 0 || b.dow! > 6) return c.json({ error: "invalid_day" }, 400);
  const dayOff = b.kind === "day_off"; // fixed weekly day off: the whole day
  if (dayOff) { b.start_time = "00:00"; b.end_time = "23:59"; }
  if (!HHMM_RE.test(b.start_time ?? "") || !HHMM_RE.test(b.end_time ?? "") || b.start_time! >= b.end_time!) return c.json({ error: "invalid_times" }, 400);
  if (dayOff && (await c.env.DB.prepare("SELECT 1 FROM staff_availability WHERE staff_id = ? AND dow = ? AND kind = 'day_off'").bind(staffId, b.dow).first())) return c.json({ error: "already_set" }, 409);
  const from = b.valid_from || null, to = b.valid_to || null;
  if ((from && !DATE_RE3.test(from)) || (to && !DATE_RE3.test(to)) || (from && to && from > to)) return c.json({ error: "invalid_dates" }, 400);
  const r = await c.env.DB.prepare("INSERT INTO staff_availability (staff_id, dow, start_time, end_time, note, kind, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(staffId, b.dow, b.start_time, b.end_time, b.note?.trim().slice(0, 120) || null, dayOff ? "day_off" : "unavailable", from, to).run();
  return c.json({ id: r.meta.last_row_id }, 201);
});

// On a fixed day off: tick/untick "available for replacements".
app.put("/api/availability/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  const { replacement_ok } = await c.req.json<{ replacement_ok?: boolean }>();
  const row = id ? await c.env.DB.prepare("SELECT staff_id FROM staff_availability WHERE id = ?").bind(id).first<{ staff_id: number }>() : null;
  if (!row || typeof replacement_ok !== "boolean") return c.json({ error: "not_found" }, 404);
  if (!(await canEditPerson(c, row.staff_id))) return c.json({ error: "forbidden" }, 403);
  await c.env.DB.prepare("UPDATE staff_availability SET replacement_ok = ? WHERE id = ? AND kind = 'day_off'").bind(replacement_ok ? 1 : 0, id).run();
  return c.json({ ok: true });
});

app.delete("/api/availability/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  const row = id ? await c.env.DB.prepare("SELECT staff_id FROM staff_availability WHERE id = ?").bind(id).first<{ staff_id: number }>() : null;
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!(await canEditPerson(c, row.staff_id))) return c.json({ error: "forbidden" }, 403);
  await c.env.DB.prepare("DELETE FROM staff_availability WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// Maximum hours per week for one employee (admin only): shown in the totals, warned on save, never exceeded by replacements.
app.put("/api/staff/:id/limit", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const { max_weekly_hours } = await c.req.json<{ max_weekly_hours?: number | string | null }>();
  if (!id) return c.json({ error: "bad_id" }, 400);
  if (!(await c.env.DB.prepare("SELECT 1 FROM staff WHERE id = ?").bind(id).first())) return c.json({ error: "not_found" }, 404);
  if (max_weekly_hours === null || max_weekly_hours === undefined || max_weekly_hours === "") {
    await c.env.DB.prepare("DELETE FROM staff_limits WHERE staff_id = ?").bind(id).run();
    return c.json({ ok: true, max_weekly_hours: null });
  }
  const n = Number(String(max_weekly_hours).replace(",", "."));
  if (!Number.isFinite(n) || n <= 0 || n > 168) return c.json({ error: "invalid_hours" }, 400);
  await c.env.DB.prepare("INSERT OR REPLACE INTO staff_limits (staff_id, max_weekly_hours) VALUES (?, ?)").bind(id, n).run();
  return c.json({ ok: true, max_weekly_hours: n });
});

// ---------- Kitchen posts and competencies ----------
app.get("/api/posts", async (c) => c.json((await c.env.DB.prepare("SELECT id, department_id, code, name_fr, name_en, sort, all_posts, kind FROM posts ORDER BY sort").all()).results));

// Posts one employee is competent at (admin, or a manager of that employee).
app.get("/api/staff/:id/skills", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  if (!(await canEditPerson(c, id))) return c.json({ error: "forbidden" }, 403);
  return c.json((await c.env.DB.prepare("SELECT post_id FROM staff_post_skills WHERE staff_id = ?").bind(id).all<{ post_id: number }>()).results.map((r) => r.post_id));
});
app.put("/api/staff/:id/skills", async (c) => {
  const id = intParam(c.req.param("id"));
  const { post_ids } = await c.req.json<{ post_ids?: number[] }>();
  if (!id || !Array.isArray(post_ids)) return c.json({ error: "bad_request" }, 400);
  if (!(await canDecideFor(c.env.DB, c.get("me"), id))) return c.json({ error: "forbidden" }, 403); // admin or a manager of that employee, not oneself
  const valid = new Set((await c.env.DB.prepare("SELECT id FROM posts").all<{ id: number }>()).results.map((r) => r.id));
  const ids = [...new Set(post_ids)].filter((x) => valid.has(x));
  await c.env.DB.batch([c.env.DB.prepare("DELETE FROM staff_post_skills WHERE staff_id = ?").bind(id), ...ids.map((pid) => c.env.DB.prepare("INSERT INTO staff_post_skills (staff_id, post_id) VALUES (?, ?)").bind(id, pid))]);
  return c.json({ ok: true, post_ids: ids });
});

// ---------- AI schedule for the next week (admin) ----------
// Builds everything the AI needs: the present schedule, requested breaks, unavailabilities, new employees, promised hours, targets.
async function buildAiContext(c: Context<any>, restaurantId: number, departments: string[], week: string, lang: "fr" | "en"): Promise<AiContext | null> {
  const env = c.env as Env, db = env.DB;
  const bounds = weekBounds(week);
  const rest = await db.prepare("SELECT id, name, open_time, close_time FROM restaurants WHERE id = ?").bind(restaurantId).first<{ id: number; name: string; open_time: string; close_time: string }>();
  if (!bounds || !rest || !departments.length) return null;
  const [r] = await withOpenHours(db, [rest]);
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${week}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
  const prevStart = new Date(Date.parse(`${week}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  const dmarks = departments.map(() => "?").join(",");
  const boundaries = DEFAULT_BOUNDARIES;
  const cid = (c.get("me") as Me).client_id;
  const settings = await loadSettings(db, cid);
  const roleCatalogue = await rolesFor(db, cid);

  // targets resolved for each date
  const trows = (await db.prepare(`SELECT department_id, set_id, dow, slot, count FROM staffing_targets WHERE restaurant_id = ? AND department_id IN (${dmarks})`).bind(restaurantId, ...departments).all<{ department_id: string; set_id: number; dow: number; slot: string; count: number }>()).results;
  const sets = (await db.prepare("SELECT id, name, kind, rule FROM target_sets WHERE restaurant_id = ?").bind(restaurantId).all<{ id: number; name: string; kind: string; rule: string }>()).results.map((x) => ({ ...x, rule: JSON.parse(x.rule) }));
  const targets: AiContext["targets"] = {};
  for (const date of days) { targets[date] = {}; for (const dep of departments) targets[date][dep] = resolveForDate(trows.filter((x) => x.department_id === dep), sets, date).targets; }

  // employees: active people holding a role of these departments here
  const roleRows = (await db.prepare(
    `SELECT sr.staff_id, ro.id AS role_id, ro.name_en, ro.department_id, ro.pre_open_minutes FROM staff_roles sr JOIN roles ro ON ro.id = sr.role_id JOIN staff s ON s.id = sr.staff_id
     WHERE sr.restaurant_id = ? AND ro.department_id IN (${dmarks}) AND s.active = 1`,
  ).bind(restaurantId, ...departments).all<{ staff_id: number; role_id: number; name_en: string; department_id: string; pre_open_minutes: number }>()).results;
  for (const x of roleRows) x.pre_open_minutes = roleCatalogue.find((r) => r.id === x.role_id)?.pre_open_minutes ?? 0;
  const ids = [...new Set(roleRows.map((x) => x.staff_id))];
  if (!ids.length) return null;
  const im = ids.map(() => "?").join(",");
  const people = (await db.prepare(`SELECT id, first_name, name, promised_hours, scheduling_notes FROM staff WHERE id IN (${im})`).bind(...ids).all<{ id: number; first_name: string; name: string; promised_hours: number | null; scheduling_notes: string | null }>()).results;
  const limits = new Map((await db.prepare(`SELECT staff_id, max_weekly_hours FROM staff_limits WHERE staff_id IN (${im})`).bind(...ids).all<{ staff_id: number; max_weekly_hours: number }>()).results.map((x) => [x.staff_id, x.max_weekly_hours]));
  const avail = (await db.prepare(`SELECT staff_id, dow, start_time, end_time, kind, replacement_ok, valid_from, valid_to, note FROM staff_availability WHERE staff_id IN (${im})`).bind(...ids).all<any>()).results;
  const offs = (await db.prepare(`SELECT staff_id, start_date, end_date, start_time, end_time, status FROM time_off_requests WHERE status IN ('requested','approved') AND staff_id IN (${im}) AND start_date <= ? AND end_date >= ?`).bind(...ids, days[6], days[0]).all<any>()).results;
  const skills = (await db.prepare(`SELECT k.staff_id, p.code FROM staff_post_skills k JOIN posts p ON p.id = k.post_id WHERE k.staff_id IN (${im})`).bind(...ids).all<{ staff_id: number; code: string }>()).results;
  const seen = new Set((await db.prepare(`SELECT DISTINCT staff_id FROM shifts WHERE staff_id IN (${im}) AND start_at >= ? AND start_at < ?`).bind(...ids, `${new Date(Date.parse(`${week}T00:00:00Z`) - 56 * 86_400_000).toISOString().slice(0, 10)}T00:00`, bounds.start).all<{ staff_id: number }>()).results.map((x) => x.staff_id));
  const employees = people.map((p) => ({
    id: p.id, first_name: p.first_name || p.name.split(" ")[0], is_new: !seen.has(p.id), promised_hours: p.promised_hours, max_weekly_hours: limits.get(p.id) ?? null, notes: p.scheduling_notes,
    roles: roleRows.filter((x) => x.staff_id === p.id).map((x) => ({ id: x.role_id, name: x.name_en, department: x.department_id })),
    fixed_days_off: avail.filter((a) => a.staff_id === p.id && a.kind === "day_off").map((a) => a.dow),
    days_off_replacement_ok: avail.filter((a) => a.staff_id === p.id && a.kind === "day_off" && a.replacement_ok === 1).map((a) => a.dow),
    unavailable: avail.filter((a) => a.staff_id === p.id && a.kind !== "day_off").map((a) => ({ dow: a.dow, start_time: a.start_time, end_time: a.end_time, valid_from: a.valid_from, valid_to: a.valid_to, note: a.note })),
    time_off: offs.filter((o) => o.staff_id === p.id).map((o) => ({ start_date: o.start_date, end_date: o.end_date, start_time: o.start_time, end_time: o.end_time, status: o.status })),
    kitchen_posts: skills.filter((k) => k.staff_id === p.id).map((k) => k.code),
  }));

  // the present (previous) week, existing plans for the target week, shifts elsewhere
  const prevB = weekBounds(prevStart)!;
  const prev = (await db.prepare(
    `SELECT sh.id, sh.staff_id, sh.role_id, sh.start_at, sh.end_at FROM shifts sh JOIN roles ro ON ro.id = sh.role_id
     WHERE sh.restaurant_id = ? AND sh.status = 'ok' AND ro.department_id IN (${dmarks}) AND sh.start_at >= ? AND sh.start_at < ?`,
  ).bind(restaurantId, ...departments, prevB.start, prevB.end).all<{ id: number; staff_id: number; role_id: number; start_at: string; end_at: string }>()).results;
  const extra = new Map<number, number[]>();
  if (prev.length) for (const x of (await db.prepare(`SELECT shift_id, role_id FROM shift_roles WHERE shift_id IN (${prev.map(() => "?").join(",")})`).bind(...prev.map((x) => x.id)).all<{ shift_id: number; role_id: number }>()).results) extra.set(x.shift_id, [...(extra.get(x.shift_id) ?? []), x.role_id]);
  const next = (await db.prepare(
    `SELECT sh.staff_id, sh.role_id, sh.start_at, sh.end_at, sh.restaurant_id, ro.department_id FROM shifts sh JOIN roles ro ON ro.id = sh.role_id
     WHERE sh.status = 'ok' AND sh.staff_id IN (${im}) AND sh.start_at >= ? AND sh.start_at < ?`,
  ).bind(...ids, bounds.start, bounds.end).all<{ staff_id: number; role_id: number; start_at: string; end_at: string; restaurant_id: number; department_id: string }>()).results;
  const here = (x: { restaurant_id: number; department_id: string }) => x.restaurant_id === restaurantId && departments.includes(x.department_id);
  const roles = (await rolesFor(db, c.get("me").client_id)).filter((r) => r.pre_open_minutes > 0) as { name_en: string; pre_open_minutes: number }[];
  return {
    lang,
    // hours of the days of this very week, special hours included
    restaurant: { id: rest.id, name: rest.name, breakfast_by_dow: r.breakfast_by_dow,
      open_by_dow: days.map((d, i) => hoursFor(r.special_hours, d, r.open_by_dow[i], r.close_by_dow[i]).open),
      close_by_dow: days.map((d, i) => hoursFor(r.special_hours, d, r.open_by_dow[i], r.close_by_dow[i]).close),
      closed_dates: days.filter((d, i) => hoursFor(r.special_hours, d, r.open_by_dow[i], r.close_by_dow[i]).closed) },
    week: { start: week, days }, departments, overtime_hours: settings.overtime_hours, period_boundaries: boundaries, targets,
    pre_open_minutes: Object.fromEntries(roles.map((x) => [x.name_en, x.pre_open_minutes])),
    employees,
    current_week_shifts: prev.map((x) => ({ staff_id: x.staff_id, role_ids: [x.role_id, ...(extra.get(x.id) ?? [])], date: x.start_at.slice(0, 10), start: x.start_at.slice(11, 16), end: x.end_at.slice(11, 16) })),
    already_planned_elsewhere: next.filter((x) => !here(x)).map((x) => ({ staff_id: x.staff_id, start_at: x.start_at, end_at: x.end_at })),
    existing_next_week: next.filter(here).map((x) => ({ staff_id: x.staff_id, role_id: x.role_id, start_at: x.start_at, end_at: x.end_at })),
  };
}

app.post("/api/admin/ai-schedule", requireAdmin, async (c) => {
  const b = await c.req.json<{ restaurant_id?: number; departments?: string[]; week?: string; extra_prompt?: string; dry_run?: boolean; lang?: string }>();
  if (!b.restaurant_id || !Array.isArray(b.departments) || !b.departments.length || !b.week) return c.json({ error: "bad_request" }, 400);
  if (!weekBounds(b.week)) return c.json({ error: "week_must_be_a_monday" }, 400);
  const ctx = await buildAiContext(c, b.restaurant_id, b.departments.slice(0, 5), b.week, b.lang === "en" ? "en" : "fr");
  if (!ctx) return c.json({ error: "nothing_to_schedule" }, 422);
  const user = buildUserPrompt(ctx, (b.extra_prompt ?? "").slice(0, 3000));
  const summary = { employees: ctx.employees.length, new_employees: ctx.employees.filter((x) => x.is_new).length, with_promised_hours: ctx.employees.filter((x) => x.promised_hours != null).length,
    time_off: ctx.employees.reduce((n, x) => n + x.time_off.length, 0), unavailabilities: ctx.employees.reduce((n, x) => n + x.unavailable.length + x.fixed_days_off.length, 0), current_week_shifts: ctx.current_week_shifts.length, existing_next_week: ctx.existing_next_week.length };
  if (b.dry_run) return c.json({ summary, system: SYSTEM_PROMPT, user, characters: SYSTEM_PROMPT.length + user.length });
  const key = await anthropicKey(c.env, c.get("me").client_id);
  if (!key) return c.json({ error: "no_ai_key" }, 422);
  let text: string;
  try { text = await callClaude(key, SYSTEM_PROMPT, user, fetch, c.env.ANTHROPIC_API_BASE); } catch (e) { return c.json({ error: "ai_failed", detail: String((e as Error).message) }, 502); }
  let proposal;
  try { proposal = parseProposal(text); } catch { return c.json({ error: "ai_bad_answer" }, 502); }
  const checked = checkProposal(ctx, proposal);
  return c.json({ summary, week: b.week, proposal: { shifts: checked.shifts, summary: proposal.summary, concerns: proposal.concerns }, warnings: checked.warnings, dropped: checked.dropped.length, employees: ctx.employees.map((e) => ({ id: e.id, first_name: e.first_name, promised_hours: e.promised_hours, roles: e.roles })) });
});

// Applies a proposal the admin reviewed: creates the shifts, optionally replacing the week's existing ones for these departments.
app.post("/api/admin/ai-schedule/apply", requireAdmin, async (c) => {
  const b = await c.req.json<{ restaurant_id?: number; departments?: string[]; week?: string; replace?: boolean; shifts?: { staff_id: number; role_id: number; start_at: string; end_at: string; until_close?: boolean; notes?: string }[] }>();
  if (!b.restaurant_id || !Array.isArray(b.departments) || !b.week || !Array.isArray(b.shifts)) return c.json({ error: "bad_request" }, 400);
  const bounds = weekBounds(b.week);
  if (!bounds) return c.json({ error: "week_must_be_a_monday" }, 400);
  if (b.shifts.length > 400) return c.json({ error: "too_many" }, 400);
  let removed = 0;
  if (b.replace) {
    const dm = b.departments.map(() => "?").join(",");
    const r = await c.env.DB.prepare(`DELETE FROM shifts WHERE restaurant_id = ? AND start_at >= ? AND start_at < ? AND role_id IN (SELECT id FROM roles WHERE department_id IN (${dm}))`).bind(b.restaurant_id, bounds.start, bounds.end, ...b.departments).run();
    removed = r.meta.changes ?? 0;
  }
  let created = 0; const skipped: { staff_id: number; start_at: string; error: string }[] = [];
  for (const s of b.shifts) {
    const input: ShiftInput = { staff_id: s.staff_id, restaurant_id: b.restaurant_id, role_id: s.role_id, start_at: s.start_at, end_at: s.end_at, until_close: !!s.until_close, notes: s.notes, force: true };
    if (s.start_at < bounds.start || s.start_at >= bounds.end) { skipped.push({ staff_id: s.staff_id, start_at: s.start_at, error: "outside_week" }); continue; }
    const problem = await validateShift(c, input);
    if (problem) { skipped.push({ staff_id: s.staff_id, start_at: s.start_at, error: String((problem.body as { error?: string }).error) }); continue; }
    await c.env.DB.prepare("INSERT INTO shifts (staff_id, restaurant_id, role_id, start_at, end_at, notes, until_close) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(s.staff_id, b.restaurant_id, s.role_id, s.start_at, s.end_at, s.notes ?? null, s.until_close ? 1 : 0).run();
    created++;
  }
  emit(c, "schedule.applied", async () => ({ restaurant_id: b.restaurant_id, week: b.week, created, removed }));
  return c.json({ ok: true, created, removed, skipped });
});

// Promised hours and planner notes of one employee (admin).
app.put("/api/staff/:id/planning", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const { promised_hours, scheduling_notes } = await c.req.json<{ promised_hours?: number | string | null; scheduling_notes?: string | null }>();
  if (!id) return c.json({ error: "bad_id" }, 400);
  const n = promised_hours === null || promised_hours === undefined || promised_hours === "" ? null : Number(String(promised_hours).replace(",", "."));
  if (n !== null && (!Number.isFinite(n) || n < 0 || n > 168)) return c.json({ error: "invalid_hours" }, 400);
  const r = await c.env.DB.prepare("UPDATE staff SET promised_hours = ?, scheduling_notes = ? WHERE id = ?").bind(n, scheduling_notes?.trim().slice(0, 1000) || null, id).run();
  return r.meta.changes ? c.json({ ok: true, promised_hours: n }) : c.json({ error: "not_found" }, 404);
});

// ---------- Sick calls and replacements ----------
const flowError = (c: Context<any>, e: unknown) => {
  if (e instanceof FlowError) return c.json({ error: e.code }, e.status as 400);
  throw e;
};

// An employee reports sick for one of their own upcoming shifts (or a manager/admin does it for them).
app.post("/api/shifts/:id/sick", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  const me = c.get("me");
  const row = await c.env.DB.prepare("SELECT sh.staff_id, sh.restaurant_id, ro.department_id FROM shifts sh JOIN roles ro ON ro.id = sh.role_id WHERE sh.id = ?").bind(id).first<{ staff_id: number; restaurant_id: number; department_id: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.staff_id !== me.id && !(await canManage(c.env.DB, me, row.restaurant_id, row.department_id))) return c.json({ error: "forbidden" }, 403);
  try {
    const b = await c.req.json<{ reason?: string; note?: string }>().catch(() => ({} as { reason?: string; note?: string }));
    const reason = (ABSENCE_REASONS as readonly string[]).includes(b.reason ?? "") ? b.reason! : null;
    const started = await startSickCall(c.env, c.env.DB, id, me.id, { reason, note: (b.note ?? "").trim().slice(0, 200) || null });
    emit(c, "coverage.opened", () => coverageData(c.env.DB, started.request_id));
    return c.json(started, 201);
  } catch (e) { return flowError(c, e); }
});

// Replacement requests the caller may follow: open ones plus the last 7 days.
app.get("/api/coverage", async (c) => {
  const me = c.get("me");
  const since = Date.now() - 7 * 86_400_000;
  const rows = await c.env.DB.prepare(
    `SELECT cr.id, cr.shift_id, cr.status, cr.restaurant_id, cr.reason, cr.reason_note, rs.name AS restaurant, cr.start_at, cr.end_at, cr.created_at, cr.escalated_at, cr.filled_at,
            ro.department_id, ro.name_fr, ro.name_en, sh.until_close, sick.name AS sick_name, sick.sex AS sex, fb.name AS filled_by_name,
            (SELECT count(*) FROM coverage_offers WHERE request_id = cr.id) AS offers,
            (SELECT count(*) FROM coverage_offers WHERE request_id = cr.id AND status = 'declined') AS declined,
            (SELECT count(*) FROM coverage_offers WHERE request_id = cr.id AND status = 'sent') AS waiting
     FROM coverage_requests cr JOIN restaurants rs ON rs.id = cr.restaurant_id JOIN roles ro ON ro.id = cr.role_id
          JOIN shifts sh ON sh.id = cr.shift_id JOIN staff sick ON sick.id = cr.sick_staff_id LEFT JOIN staff fb ON fb.id = cr.filled_by
     WHERE rs.client_id = ?4 AND (cr.status = 'open' OR cr.created_at >= ?1)
       AND (?2 = 1 OR EXISTS (SELECT 1 FROM managers m WHERE m.staff_id = ?3 AND m.restaurant_id = cr.restaurant_id AND m.department_id = ro.department_id))
     ORDER BY (cr.status = 'open') DESC, cr.created_at DESC LIMIT 100`,
  ).bind(since, me.is_admin ? 1 : 0, me.id, me.client_id).all();
  return c.json(rows.results);
});

async function requestScope(c: Context<any>, id: number) {
  const req = await c.env.DB.prepare(
    "SELECT cr.id, cr.restaurant_id, cr.role_id, cr.sick_staff_id, cr.start_at, cr.end_at, cr.status, ro.department_id FROM coverage_requests cr JOIN roles ro ON ro.id = cr.role_id WHERE cr.id = ?",
  ).bind(id).first() as { id: number; restaurant_id: number; role_id: number; sick_staff_id: number; start_at: string; end_at: string; status: string; department_id: string } | null;
  if (!req) return { error: c.json({ error: "not_found" }, 404) };
  if (!(await canManage(c.env.DB, c.get("me"), req.restaurant_id, req.department_id))) return { error: c.json({ error: "forbidden" }, 403) };
  return { req };
}

app.get("/api/coverage/:id/candidates", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  const { req, error } = await requestScope(c, id);
  if (error) return error;
  const settings = await loadSettingsFrom(c.env.DB, c.get("me").client_id);
  const r = await gatherCandidates(c.env.DB, { restaurant_id: req!.restaurant_id, role_id: req!.role_id, start_at: req!.start_at, end_at: req!.end_at, sick_staff_id: req!.sick_staff_id }, settings);
  return c.json({ eligible: r.eligible.map((p) => ({ staff_id: p.staff_id, name: p.name, week_hours: Math.round(p.week_hours * 10) / 10 })), excluded: r.excluded });
});

// A manager picks the replacement by hand (for example after the "action required" message).
app.post("/api/coverage/:id/assign", async (c) => {
  const id = intParam(c.req.param("id"));
  const { staff_id } = await c.req.json<{ staff_id?: number }>();
  if (!id || !staff_id) return c.json({ error: "bad_request" }, 400);
  const { req, error } = await requestScope(c, id);
  if (error) return error;
  const holds = await c.env.DB.prepare("SELECT 1 FROM staff_roles WHERE staff_id = ? AND restaurant_id = ? AND role_id = ?").bind(staff_id, req!.restaurant_id, req!.role_id).first();
  if (!holds) return c.json({ error: "staff_does_not_hold_role_at_restaurant" }, 422);
  try {
    const out = await fillRequest(c.env, c.env.DB, await loadConnections(c.env, c.env.DB, c.get("me").client_id), id, staff_id, "manager");
    if (out === "ok") emit(c, "coverage.filled", () => coverageData(c.env.DB, id));
    return out === "ok" ? c.json({ ok: true }) : c.json({ error: out === "conflict" ? "overlap" : "already_filled" }, 409);
  } catch (e) { return flowError(c, e); }
});

app.post("/api/coverage/:id/cancel", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  const { error } = await requestScope(c, id);
  if (error) return error;
  try { await cancelRequest(c.env.DB, id); return c.json({ ok: true }); } catch (e) { return flowError(c, e); }
});

// ---------- Messaging connections and log (admin) ----------
app.get("/api/connections", requireAdmin, async (c) => c.json(publicConnectionView(await loadConnections(c.env, c.env.DB, c.get("me").client_id))));

app.put("/api/connections", requireAdmin, async (c) => {
  const b = await c.req.json<{ twilio?: { sid?: string; token?: string; from?: string } | null; smtp?: { host?: string; port?: number; secure?: string; user?: string; pass?: string; from?: string } | null }>();
  const writes: [string, string | null][] = [];
  if (b.twilio === null) for (const k of ["sid", "token", "from"]) writes.push([`conn_twilio_${k}`, null]);
  else if (b.twilio) {
    const { sid, token, from } = b.twilio;
    if (sid && !/^AC[0-9A-Za-z]{32}$/.test(sid)) return c.json({ error: "invalid_twilio_sid" }, 400);
    const phone = from ? normalizePhone(from) : undefined;
    if (from && !phone) return c.json({ error: "invalid_phone" }, 400);
    if (sid) writes.push(["conn_twilio_sid", sid]);
    if (token) writes.push(["conn_twilio_token", token]); // empty = keep the saved token
    if (phone) writes.push(["conn_twilio_from", phone]);
  }
  if (b.smtp === null) for (const k of ["host", "port", "secure", "user", "pass", "from"]) writes.push([`conn_smtp_${k}`, null]);
  else if (b.smtp) {
    const { host, port, secure, user, pass, from } = b.smtp;
    if (host && !/^[A-Za-z0-9.-]{1,253}$/.test(host)) return c.json({ error: "invalid_host" }, 400);
    if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) return c.json({ error: "invalid_port" }, 400);
    if (secure !== undefined && !["implicit", "starttls", "none"].includes(secure)) return c.json({ error: "invalid_secure" }, 400);
    if (from && !from.includes("@")) return c.json({ error: "invalid_email" }, 400);
    if (host) writes.push(["conn_smtp_host", host]);
    if (port !== undefined) writes.push(["conn_smtp_port", String(port)]);
    if (secure) writes.push(["conn_smtp_secure", secure]);
    if (user !== undefined) writes.push(["conn_smtp_user", user]);
    if (pass) writes.push(["conn_smtp_pass", pass]); // empty = keep the saved password
    if (from) writes.push(["conn_smtp_from", from]);
  }
  const cid = c.get("me").client_id;
  await c.env.DB.batch(writes.map(([k, v]) => (v === null ? delSettingStmt(c.env.DB, cid, k) : putSettingStmt(c.env.DB, cid, k, v))));
  return c.json(publicConnectionView(await loadConnections(c.env, c.env.DB, c.get("me").client_id)));
});

app.post("/api/connections/test", requireAdmin, async (c) => {
  const { channel, to } = await c.req.json<{ channel?: string; to?: string }>();
  const conn = await loadConnections(c.env, c.env.DB, c.get("me").client_id);
  const lang: Lang = c.get("me") && (await c.env.DB.prepare("SELECT lang FROM staff WHERE id = ?").bind(c.get("me").id).first<{ lang: string }>())?.lang === "en" ? "en" : "fr";
  if (channel === "sms") {
    const phone = normalizePhone(to);
    if (!phone) return c.json({ error: "invalid_phone" }, 400);
    return c.json(await deliver(c.env.DB, conn, "sms", phone, T.test(lang), "test", c.get("me").id));
  }
  if (channel === "email" && to && to.includes("@")) return c.json(await deliver(c.env.DB, conn, "email", to.trim(), T.test(lang), "test", c.get("me").id));
  return c.json({ error: "invalid_request" }, 400);
});

app.get("/api/admin/notifications", requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT n.id, n.created_at, n.channel, n.to_addr, n.subject, n.kind, n.status, n.error, s.name AS staff_name FROM notifications n LEFT JOIN staff s ON s.id = n.staff_id WHERE s.client_id = ? ORDER BY n.id DESC LIMIT 60",
  ).bind(c.get("me").client_id).all();
  return c.json(rows.results);
});

// ---------- Roles held by staff ----------
// Admin: any. Manager: only for departments they manage at that restaurant.
app.post("/api/staff-roles", async (c) => {
  const me = c.get("me");
  const b = await c.req.json<{ staff_id: number; restaurant_id: number; role_id: number }>();
  const role = await c.env.DB.prepare("SELECT department_id FROM roles WHERE id = ?")
    .bind(b.role_id)
    .first<{ department_id: string }>();
  if (!role) return c.json({ error: "role_not_found" }, 404);
  if (!(await canManage(c.env.DB, me, b.restaurant_id, role.department_id))) return c.json({ error: "forbidden" }, 403);
  try {
    await c.env.DB.prepare("INSERT OR IGNORE INTO staff_roles (staff_id, restaurant_id, role_id) VALUES (?, ?, ?)")
      .bind(b.staff_id, b.restaurant_id, b.role_id)
      .run();
    // The list of visible schedules follows the roles: a new role turns its schedule on (automatic and hand-picked lists alike).
    await c.env.DB.prepare("INSERT OR IGNORE INTO staff_view_access (staff_id, restaurant_id, department_id) VALUES (?, ?, ?)")
      .bind(b.staff_id, b.restaurant_id, role.department_id).run();
  } catch {
    return c.json({ error: "invalid_reference" }, 400);
  }
  return c.json({ ok: true }, 201);
});

// Removing a role that still has shifts needs a decision: move them to another role the person holds
// at that restaurant, or delete them. Without a decision the API answers 409 with the options.
// effective_from ('YYYY-MM-DD') limits the move/delete to shifts starting on or after that day, so history stays as it was.
app.delete("/api/staff-roles", async (c) => {
  const me = c.get("me");
  const db = c.env.DB;
  const b = await c.req.json<{ staff_id: number; restaurant_id: number; role_id: number; reassign_to_role_id?: number; delete_shifts?: boolean; effective_from?: string }>();
  if (b.effective_from !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(b.effective_from)) return c.json({ error: "invalid_times" }, 400);
  const from = b.effective_from ?? "0000-00-00";
  const role = await db.prepare("SELECT department_id FROM roles WHERE id = ?").bind(b.role_id).first<{ department_id: string }>();
  if (!role) return c.json({ error: "role_not_found" }, 404);
  if (!(await canManage(db, me, b.restaurant_id, role.department_id))) return c.json({ error: "forbidden" }, 403);

  const count = (await db.prepare("SELECT count(*) AS n FROM shifts WHERE staff_id = ? AND restaurant_id = ? AND role_id = ? AND start_at >= ?")
    .bind(b.staff_id, b.restaurant_id, b.role_id, from).first<{ n: number }>())?.n ?? 0;
  const stmts = [];
  if (count > 0) {
    if (b.reassign_to_role_id) {
      const target = await db
        .prepare(
          `SELECT ro.department_id FROM staff_roles sr JOIN roles ro ON ro.id = sr.role_id
           WHERE sr.staff_id = ? AND sr.restaurant_id = ? AND sr.role_id = ? AND sr.role_id != ?`,
        )
        .bind(b.staff_id, b.restaurant_id, b.reassign_to_role_id, b.role_id)
        .first<{ department_id: string }>();
      if (!target) return c.json({ error: "staff_does_not_hold_role_at_restaurant" }, 422);
      if (!(await canManage(db, me, b.restaurant_id, target.department_id))) return c.json({ error: "forbidden" }, 403);
      stmts.push(db.prepare("UPDATE shifts SET role_id = ? WHERE staff_id = ? AND restaurant_id = ? AND role_id = ? AND start_at >= ?")
        .bind(b.reassign_to_role_id, b.staff_id, b.restaurant_id, b.role_id, from));
    } else if (b.delete_shifts) {
      stmts.push(db.prepare("DELETE FROM shifts WHERE staff_id = ? AND restaurant_id = ? AND role_id = ? AND start_at >= ?").bind(b.staff_id, b.restaurant_id, b.role_id, from));
    } else {
      const alternatives = await db
        .prepare(
          `SELECT ro.id, ro.department_id, ro.name_fr, ro.name_en FROM staff_roles sr JOIN roles ro ON ro.id = sr.role_id
           WHERE sr.staff_id = ? AND sr.restaurant_id = ? AND sr.role_id != ?`,
        )
        .bind(b.staff_id, b.restaurant_id, b.role_id)
        .all();
      return c.json({ error: "has_shifts", count, alternatives: alternatives.results }, 409);
    }
  }
  stmts.push(db.prepare("DELETE FROM staff_roles WHERE staff_id = ? AND restaurant_id = ? AND role_id = ?").bind(b.staff_id, b.restaurant_id, b.role_id));
  // Automatic lists mirror the roles: drop the schedule when the last role of that department here goes (hand-picked lists are left as ticked).
  stmts.push(db.prepare(
    `DELETE FROM staff_view_access WHERE staff_id = ?1 AND restaurant_id = ?2 AND department_id = ?3
       AND EXISTS (SELECT 1 FROM staff WHERE id = ?1 AND view_custom = 0)
       AND NOT EXISTS (SELECT 1 FROM staff_roles sr JOIN roles ro ON ro.id = sr.role_id WHERE sr.staff_id = ?1 AND sr.restaurant_id = ?2 AND ro.department_id = ?3 AND sr.role_id != ?4)`,
  ).bind(b.staff_id, b.restaurant_id, role.department_id, b.role_id));
  await db.batch(stmts);
  return c.json({ ok: true, moved_or_deleted: count });
});

// ---------- Managers (admin) ----------
app.post("/api/managers", requireAdmin, async (c) => {
  const b = await c.req.json<{ staff_id: number; restaurant_id: number; department_id: string }>();
  try {
    await c.env.DB.prepare("INSERT OR IGNORE INTO managers (staff_id, restaurant_id, department_id) VALUES (?, ?, ?)")
      .bind(b.staff_id, b.restaurant_id, b.department_id)
      .run();
  } catch {
    return c.json({ error: "invalid_reference" }, 400);
  }
  return c.json({ ok: true }, 201);
});

app.delete("/api/managers", requireAdmin, async (c) => {
  const b = await c.req.json<{ staff_id: number; restaurant_id: number; department_id: string }>();
  await c.env.DB.prepare("DELETE FROM managers WHERE staff_id = ? AND restaurant_id = ? AND department_id = ?")
    .bind(b.staff_id, b.restaurant_id, b.department_id)
    .run();
  return c.json({ ok: true });
});

// ---------- Schedule (view) ----------
// GET /api/schedule?restaurant=1&department=floor&week=2026-11-02
app.get("/api/schedule", async (c) => {
  const me = c.get("me");
  const restaurantId = intParam(c.req.query("restaurant"));
  const department = c.req.query("department");
  const bounds = weekBounds(c.req.query("week") ?? "");
  if (!restaurantId || !department) return c.json({ error: "restaurant_and_department_required" }, 400);
  if (!bounds) return c.json({ error: "week_must_be_a_monday" }, 400);
  if (!(await canView(c.env.DB, me, restaurantId, department))) return c.json({ error: "forbidden" }, 403);

  const shifts = await c.env.DB.prepare(
    `SELECT sh.id, sh.staff_id, s.name AS staff_name, s.first_name, s.last_name, s.sex, s.print_order, s.color AS staff_color, (SELECT updated_at FROM staff_photos WHERE staff_id = s.id) AS photo_v, sh.role_id, ro.department_id, ro.name_fr, ro.name_en,
            sh.start_at, sh.end_at, sh.until_close, sh.notes, sh.status, sh.replaced_staff_id,
            (SELECT name FROM staff WHERE id = sh.replaced_staff_id) AS replaced_name
     FROM shifts sh JOIN staff s ON s.id = sh.staff_id JOIN roles ro ON ro.id = sh.role_id
     WHERE sh.restaurant_id = ? AND (ro.department_id = ? OR EXISTS (SELECT 1 FROM shift_roles x JOIN roles r2 ON r2.id = x.role_id WHERE x.shift_id = sh.id AND r2.department_id = ?)
            OR EXISTS (SELECT 1 FROM shift_segments g JOIN roles r3 ON r3.id = g.role_id WHERE g.shift_id = sh.id AND r3.department_id = ?))
       AND sh.start_at >= ? AND sh.start_at < ? AND ${shiftVisible(me)}
     ORDER BY sh.start_at, s.name`,
  )
    .bind(restaurantId, department, department, department, bounds.start, bounds.end)
    .all<any>();
  // Extra roles of multi-role shifts (cook + dishwasher…)
  const extraRoles = new Map<number, { id: number; name_fr: string; name_en: string; department_id: string; no_count: boolean }[]>();
  if (shifts.results.length) {
    const sids = shifts.results.map((x: any) => x.id);
    for (const r of (await c.env.DB.prepare(`SELECT x.shift_id, ro.id, ro.name_fr, ro.name_en, ro.department_id, x.no_count FROM shift_roles x JOIN roles ro ON ro.id = x.role_id WHERE x.shift_id IN (${sids.map(() => "?").join(",")})`).bind(...sids).all<any>()).results) extraRoles.set(r.shift_id, [...(extraRoles.get(r.shift_id) ?? []), { id: r.id, name_fr: r.name_fr, name_en: r.name_en, department_id: r.department_id, no_count: r.no_count === 1 }]);
    for (const sh of shifts.results as any[]) sh.extra_roles = extraRoles.get(sh.id) ?? [];
    // Different roles by hour: [{ start_at, end_at, roles: [...] }]
    const segs = new Map<number, Map<string, { start_at: string; end_at: string; roles: any[] }>>();
    for (const r of (await c.env.DB.prepare(`SELECT g.shift_id, g.start_at, g.end_at, g.no_count, ro.id, ro.name_fr, ro.name_en, ro.department_id FROM shift_segments g JOIN roles ro ON ro.id = g.role_id WHERE g.shift_id IN (${sids.map(() => "?").join(",")}) ORDER BY g.start_at, ro.id`).bind(...sids).all<any>()).results) {
      const m = segs.get(r.shift_id) ?? new Map(); const k = `${r.start_at}|${r.end_at}`;
      const e = m.get(k) ?? { start_at: r.start_at, end_at: r.end_at, roles: [] };
      e.roles.push({ id: r.id, name_fr: r.name_fr, name_en: r.name_en, department_id: r.department_id, no_count: r.no_count === 1 }); m.set(k, e); segs.set(r.shift_id, m);
    }
    for (const sh of shifts.results as any[]) sh.segments = [...(segs.get(sh.id)?.values() ?? [])];
  }
  const editable = await canManage(c.env.DB, me, restaurantId, department);
  const settings = await loadSettings(c.env.DB, me.client_id);

  // Weekly hours per person (all restaurants and departments) and "working elsewhere" markers.
  // Managers/admins see them for everyone on this schedule; everyone else only sees their own hours.
  const ids = new Set<number>((shifts.results as { staff_id: number }[]).map((x) => x.staff_id));
  if (editable) {
    const roster = await c.env.DB.prepare(
      "SELECT DISTINCT sr.staff_id FROM staff_roles sr JOIN roles ro ON ro.id = sr.role_id JOIN staff s ON s.id = sr.staff_id WHERE sr.restaurant_id = ? AND ro.department_id = ? AND s.active = 1",
    ).bind(restaurantId, department).all<{ staff_id: number }>();
    for (const r of roster.results) ids.add(r.staff_id);
  }
  const visible = [...ids].filter((id) => editable || id === me.id);
  const hours: Record<number, { here: number; all: number }> = {};
  let elsewhere: unknown[] = [];
  if (visible.length) {
    const marks = visible.map(() => "?").join(",");
    const h = await c.env.DB.prepare(
      `SELECT staff_id,
              sum((julianday(end_at) - julianday(start_at)) * 24) AS h_all,
              sum(CASE WHEN restaurant_id = ? THEN (julianday(end_at) - julianday(start_at)) * 24 ELSE 0 END) AS h_here
       FROM shifts sh WHERE status = 'ok' AND staff_id IN (${marks}) AND start_at >= ? AND start_at < ? AND ${shiftVisible(me)} GROUP BY staff_id`,
    ).bind(restaurantId, ...visible, bounds.start, bounds.end).all<{ staff_id: number; h_all: number; h_here: number }>();
    for (const r of h.results) hours[r.staff_id] = { here: Math.round(r.h_here * 100) / 100, all: Math.round(r.h_all * 100) / 100 };
    if (editable) {
      elsewhere = (await c.env.DB.prepare(
        `SELECT sh.staff_id, sh.restaurant_id, rs.name AS restaurant, ro.department_id, ro.name_en, ro.name_fr, sh.start_at, sh.end_at
         FROM shifts sh JOIN restaurants rs ON rs.id = sh.restaurant_id JOIN roles ro ON ro.id = sh.role_id
         WHERE sh.status = 'ok' AND sh.staff_id IN (${marks}) AND sh.start_at >= ? AND sh.start_at < ? AND ${shiftVisible(me)}
           AND NOT (sh.restaurant_id = ? AND (ro.department_id = ? OR EXISTS (SELECT 1 FROM shift_roles x JOIN roles r2 ON r2.id = x.role_id WHERE x.shift_id = sh.id AND r2.department_id = ?) OR EXISTS (SELECT 1 FROM shift_segments g JOIN roles r3 ON r3.id = g.role_id WHERE g.shift_id = sh.id AND r3.department_id = ?)))
         ORDER BY sh.start_at`,
      ).bind(...visible, bounds.start, bounds.end, restaurantId, department, department, department).all()).results;
    }
  }
  // Time off overlapping this week: everyone's for managers/admin, only the caller's own for the rest.
  const weekEndDay = new Date(`${bounds.start.slice(0, 10)}T00:00:00Z`); weekEndDay.setUTCDate(weekEndDay.getUTCDate() + 6);
  const offIds = [...ids].filter((id) => editable || id === me.id);
  const time_off = offIds.length ? (await c.env.DB.prepare(
    `SELECT t.id, t.staff_id, s.first_name, s.last_name, s.name AS staff_name, t.start_date, t.end_date, t.start_time, t.end_time, t.note, t.status FROM time_off_requests t JOIN staff s ON s.id = t.staff_id WHERE t.status IN ('requested','approved') AND t.staff_id IN (${offIds.map(() => "?").join(",")}) AND t.start_date <= ? AND t.end_date >= ? ORDER BY t.start_date`,
  ).bind(...offIds, weekEndDay.toISOString().slice(0, 10), bounds.start.slice(0, 10)).all()).results : [];
  // Kitchen posts: competencies of the people on this schedule (everyone may see them: they drive the "post not covered" warning).
  const skills: Record<number, number[]> = {};
  const sIds = [...ids];
  if (sIds.length) for (const r of (await c.env.DB.prepare(`SELECT staff_id, post_id FROM staff_post_skills WHERE staff_id IN (${sIds.map(() => "?").join(",")})`).bind(...sIds).all<{ staff_id: number; post_id: number }>()).results) (skills[r.staff_id] ??= []).push(r.post_id);
  const anySkills = !!(await c.env.DB.prepare("SELECT 1 FROM staff_post_skills k JOIN staff s ON s.id = k.staff_id WHERE s.client_id = ? LIMIT 1").bind(me.client_id).first());
  // Delivery staff on duty (times only, no names): they can take the kitchen's out-of-the-oven post.
  const delivery_presence = department === "kitchen"
    ? (await c.env.DB.prepare(
        `SELECT sh.start_at, sh.end_at FROM shifts sh JOIN roles ro ON ro.id = sh.role_id
           WHERE sh.restaurant_id = ?1 AND sh.status = 'ok' AND sh.start_at >= ?2 AND sh.start_at < ?3 AND ro.department_id = 'delivery' AND ${shiftVisible(me)}
         UNION SELECT sh.start_at, sh.end_at FROM shifts sh JOIN shift_roles x ON x.shift_id = sh.id JOIN roles ro ON ro.id = x.role_id
           WHERE sh.restaurant_id = ?1 AND sh.status = 'ok' AND sh.start_at >= ?2 AND sh.start_at < ?3 AND ro.department_id = 'delivery'
         UNION SELECT g.start_at, g.end_at FROM shift_segments g JOIN shifts sh ON sh.id = g.shift_id JOIN roles ro ON ro.id = g.role_id
           WHERE sh.restaurant_id = ?1 AND sh.status = 'ok' AND sh.start_at >= ?2 AND sh.start_at < ?3 AND ro.department_id = 'delivery'`,
      ).bind(restaurantId, bounds.start, bounds.end).all()).results
    : [];
  const days_off: Record<number, number[]> = {};
  if (visible.length) for (const r of (await c.env.DB.prepare(`SELECT staff_id, dow FROM staff_availability WHERE kind = 'day_off' AND staff_id IN (${visible.map(() => "?").join(",")})`).bind(...visible).all<{ staff_id: number; dow: number }>()).results) (days_off[r.staff_id] ??= []).push(r.dow);
  const personal: Record<number, number> = {};
  if (visible.length) for (const r of (await c.env.DB.prepare(`SELECT staff_id, max_weekly_hours FROM staff_limits WHERE staff_id IN (${visible.map(() => "?").join(",")})`).bind(...visible).all<{ staff_id: number; max_weekly_hours: number }>()).results) personal[r.staff_id] = r.max_weekly_hours;
  const published = !!(await c.env.DB.prepare("SELECT 1 FROM schedule_publications WHERE restaurant_id = ? AND department_id = ? AND week_start = ?").bind(restaurantId, department, c.req.query("week")).first());
  return c.json({ week: c.req.query("week"), editable, published, shifts: shifts.results, hours, elsewhere, time_off, days_off, skills, any_skills: anySkills, delivery_presence, limits: { overtime_hours: settings.overtime_hours, by_staff: personal } });
});

// Publish (or take back) one schedule: restaurant + department + week. Administrators, and managers of that department.
app.post("/api/schedule/publish", async (c) => {
  const me = c.get("me");
  const b = await c.req.json<{ restaurant_id?: number; department_id?: string; week?: string; published?: boolean; notify?: boolean }>().catch(() => ({} as any));
  if (!b.restaurant_id || !b.department_id || !weekBounds(b.week ?? "") || typeof b.published !== "boolean") return c.json({ error: "bad_request" }, 400);
  if (!(await canManage(c.env.DB, me, b.restaurant_id, b.department_id))) return c.json({ error: "forbidden" }, 403);
  if (b.published) {
    // Nobody may be booked twice at the same time (any restaurant, any department): fix the conflicts first.
    const wb = weekBounds(b.week!)!;
    const clash = await c.env.DB.prepare(
      `SELECT count(*) AS n FROM shifts a JOIN roles ra ON ra.id = a.role_id
       JOIN shifts b ON b.staff_id = a.staff_id AND b.id != a.id AND b.status = 'ok' AND a.start_at < b.end_at AND b.start_at < a.end_at
       WHERE a.restaurant_id = ? AND ra.department_id = ? AND a.status = 'ok' AND a.start_at >= ? AND a.start_at < ?`,
    ).bind(b.restaurant_id, b.department_id, wb.start, wb.end).first<{ n: number }>();
    if (clash?.n) return c.json({ error: "conflicts", count: clash.n }, 409);
  }
  const wasPublished = !!(await c.env.DB.prepare("SELECT 1 FROM schedule_publications WHERE restaurant_id = ? AND department_id = ? AND week_start = ?").bind(b.restaurant_id, b.department_id, b.week).first());
  if (b.published) await c.env.DB.prepare("INSERT OR REPLACE INTO schedule_publications (restaurant_id, department_id, week_start, published_at, published_by) VALUES (?, ?, ?, ?, ?)").bind(b.restaurant_id, b.department_id, b.week, Date.now(), me.id).run();
  else await c.env.DB.prepare("DELETE FROM schedule_publications WHERE restaurant_id = ? AND department_id = ? AND week_start = ?").bind(b.restaurant_id, b.department_id, b.week).run();
  emit(c, b.published ? "schedule.published" : "schedule.unpublished", async () => ({ restaurant_id: b.restaurant_id, department_id: b.department_id, week: b.week }));
  // Tell every employee who works in it (only when it goes from draft to published, and unless the caller says notify:false).
  let notified = 0;
  if (b.published && !wasPublished && b.notify !== false) {
    const wb = weekBounds(b.week!)!;
    const rows = (await c.env.DB.prepare(
      `SELECT s.id, s.name, s.phone, s.email, s.lang, s.notify_channel, sh.start_at, sh.end_at, sh.until_close
       FROM shifts sh JOIN staff s ON s.id = sh.staff_id
       WHERE sh.restaurant_id = ? AND (SELECT department_id FROM roles WHERE id = sh.role_id) = ? AND sh.status = 'ok' AND sh.start_at >= ? AND sh.start_at < ?
         AND s.active = 1 AND s.client_id = ? ORDER BY sh.start_at`,
    ).bind(b.restaurant_id, b.department_id, wb.start, wb.end, me.client_id).all<{ id: number; name: string; phone: string | null; email: string | null; lang: string; notify_channel: string; start_at: string; end_at: string; until_close: number }>()).results;
    const people = new Map<number, { person: StaffContact; shifts: typeof rows }>();
    for (const r of rows) { const e = people.get(r.id) ?? { person: { id: r.id, name: r.name, phone: r.phone, email: r.email, lang: r.lang, notify_channel: r.notify_channel }, shifts: [] }; e.shifts.push(r); people.set(r.id, e); }
    notified = people.size;
    if (notified) c.executionCtx.waitUntil((async () => {
      try {
        const conn = await loadConnections(c.env, c.env.DB, me.client_id);
        const restaurant = (await c.env.DB.prepare("SELECT name FROM restaurants WHERE id = ?").bind(b.restaurant_id).first<{ name: string }>())?.name ?? "";
        const last = new Date(Date.parse(`${b.week}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
        for (const { person, shifts } of people.values()) {
          await notifyStaff(c.env.DB, conn, person, (lang, channel) => T.schedulePublished(lang, {
            restaurant, from: formatDate(b.week!, lang), to: formatDate(last, lang), url: conn.appUrl, sms: channel === "sms",
            lines: shifts.map((x) => formatWhen(x.start_at, x.end_at, !!x.until_close, lang)),
          }), "schedule_published");
        }
      } catch { /* messaging never blocks publishing */ }
    })());
  }
  return c.json({ ok: true, published: b.published, notified });
});

// The caller's own shifts across every restaurant and department.
app.get("/api/my-shifts", async (c) => {
  const bounds = weekBounds(c.req.query("week") ?? "");
  if (!bounds) return c.json({ error: "week_must_be_a_monday" }, 400);
  const r = await c.env.DB.prepare(
    `SELECT sh.id, sh.staff_id, sh.role_id, sh.restaurant_id, rs.name AS restaurant, ro.department_id, ro.name_fr, ro.name_en, (SELECT sex FROM staff WHERE id = sh.staff_id) AS sex,
            sh.start_at, sh.end_at, sh.until_close, sh.notes, sh.status
     FROM shifts sh JOIN restaurants rs ON rs.id = sh.restaurant_id JOIN roles ro ON ro.id = sh.role_id
     WHERE sh.staff_id = ? AND sh.start_at >= ? AND sh.start_at < ? AND ${shiftVisible(c.get("me"))} ORDER BY sh.start_at`,
  )
    .bind(c.get("me").id, bounds.start, bounds.end)
    .all();
  const rows = r.results as { start_at: string; end_at: string; status: string }[];
  const minutes = (a: string, b: string) => (Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`)) / 60000;
  const total_hours = Math.round((rows.filter((x) => x.status === "ok").reduce((n, x) => n + minutes(x.start_at, x.end_at), 0) / 60) * 100) / 100;
  const mine = await c.env.DB.prepare("SELECT max_weekly_hours FROM staff_limits WHERE staff_id = ?").bind(c.get("me").id).first<{ max_weekly_hours: number }>();
  const general = (await loadSettings(c.env.DB, c.get("me").client_id)).overtime_hours;
  // Gross pay for the shifts shown (their own rate, else the role's / the general default; a multi-role shift is paid at its highest rate).
  const me = c.get("me"), cid = me.client_id;
  const payRows = (await c.env.DB.prepare(
    `SELECT sh.id, sh.start_at, sh.end_at, COALESCE(rw.hourly_cents, w.hourly_cents, ${roleRateSql(cid)}, ${generalRateSql(cid)}) AS rate_cents
     FROM shifts sh JOIN roles ro ON ro.id = sh.role_id LEFT JOIN staff_wages w ON w.staff_id = sh.staff_id LEFT JOIN staff_role_wages rw ON rw.staff_id = sh.staff_id AND rw.role_id = sh.role_id
     WHERE sh.staff_id = ? AND sh.status = 'ok' AND sh.start_at >= ? AND sh.start_at < ? AND ${shiftVisible(me)}`,
  ).bind(me.id, bounds.start, bounds.end).all<{ id: number; start_at: string; end_at: string; rate_cents: number | null }>()).results;
  const extraRates = (await c.env.DB.prepare(
    `SELECT x.shift_id, COALESCE(rw.hourly_cents, w.hourly_cents, ${roleRateSql(cid)}, ${generalRateSql(cid)}) AS rate_cents
     FROM (SELECT shift_id, role_id FROM shift_roles UNION SELECT shift_id, role_id FROM shift_segments) x JOIN shifts sh ON sh.id = x.shift_id JOIN roles ro ON ro.id = x.role_id
          LEFT JOIN staff_wages w ON w.staff_id = sh.staff_id LEFT JOIN staff_role_wages rw ON rw.staff_id = sh.staff_id AND rw.role_id = x.role_id
     WHERE sh.staff_id = ? AND sh.status = 'ok' AND sh.start_at >= ? AND sh.start_at < ?`,
  ).bind(me.id, bounds.start, bounds.end).all<{ shift_id: number; rate_cents: number | null }>()).results;
  const bestRate = new Map<number, number>();
  for (const e of extraRates) if (e.rate_cents != null) bestRate.set(e.shift_id, Math.max(bestRate.get(e.shift_id) ?? 0, e.rate_cents));
  for (const x of payRows) { const b = bestRate.get(x.id); if (b != null && (x.rate_cents == null || b > x.rate_cents)) x.rate_cents = b; }
  const weekDays = Array.from({ length: 8 }, (_, i) => new Date(Date.parse(`${bounds.start.slice(0, 10)}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
  const pay = computeCosts(payRows, weekDays);
  return c.json({ week: c.req.query("week"), shifts: r.results, total_hours, gross_cents: pay.total_cents, unrated_hours: pay.unrated_hours, limits: { overtime_hours: mine ? Math.min(general, mine.max_weekly_hours) : general, personal_max: mine?.max_weekly_hours ?? null } });
});

// SQL sorts "Édouard" after "Zack" (byte order). Names are sorted here instead, accents ignored, French rules.
const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });
const sortByName = <T extends { name: string }>(rows: T[]): T[] => [...rows].sort((a, b) => collator.compare(a.name, b.name));

// ---------- Roster & admin overview ----------
// Staff who can be scheduled on a given restaurant+department (managers/admin only).
// ---------- End-of-shift checklists ----------
async function checklistShift(c: any, id: number) {
  const me = c.get("me") as Me, db: D1Database = c.env.DB;
  const sh = await db.prepare("SELECT sh.id, sh.staff_id, sh.restaurant_id, sh.role_id, sh.start_at, sh.end_at, sh.status, ro.department_id, s.name AS staff_name FROM shifts sh JOIN roles ro ON ro.id = sh.role_id JOIN staff s ON s.id = sh.staff_id WHERE sh.id = ?").bind(id).first<{ id: number; staff_id: number; restaurant_id: number; role_id: number; start_at: string; end_at: string; status: string; department_id: string; staff_name: string }>();
  if (!sh) return null;
  const owner = sh.staff_id === me.id;
  if (!owner && !(await canManage(db, me, sh.restaurant_id, sh.department_id))) return null;
  return { sh, owner, me, db };
}
app.get("/api/shifts/:id/checklist", async (c) => {
  const id = intParam(c.req.param("id"));
  const ctx = id ? await checklistShift(c, id) : null;
  if (!ctx) return c.json({ error: "not_found" }, 404);
  const lists = await listsForShift(ctx.db, ctx.sh, ctx.me.client_id);
  // kitchen workers choose the post(s) they worked
  const kitchen = (await ctx.db.prepare("SELECT 1 FROM roles WHERE id IN (SELECT ?1 UNION SELECT role_id FROM shift_roles WHERE shift_id = ?2 UNION SELECT role_id FROM shift_segments WHERE shift_id = ?2) AND department_id = 'kitchen' LIMIT 1").bind(ctx.sh.role_id, ctx.sh.id).first()) ? true : false;
  const picked = new Set(lists.filter((l) => l.kind === "post").map((l) => l.target_id));
  const posts = kitchen ? (await ctx.db.prepare("SELECT p.id, p.name_fr, p.name_en FROM posts p JOIN checklists c ON c.target_id = p.id AND c.kind = 'post' AND c.client_id = ? WHERE p.all_posts = 0 ORDER BY p.sort").bind(ctx.me.client_id).all<{ id: number; name_fr: string; name_en: string }>()).results.filter((p) => !picked.has(p.id)) : [];
  return c.json({ shift: { id: ctx.sh.id, start_at: ctx.sh.start_at, end_at: ctx.sh.end_at, staff_name: ctx.sh.staff_name }, editable: ctx.owner || ctx.me.is_admin || true, lists, posts_available: posts });
});
app.post("/api/shifts/:id/checklist/posts", async (c) => {
  const id = intParam(c.req.param("id"));
  const b = await c.req.json<{ post_id?: number }>().catch(() => ({} as { post_id?: number }));
  const ctx = id ? await checklistShift(c, id) : null;
  if (!ctx || !b.post_id) return c.json({ error: "not_found" }, 404);
  const list = await ctx.db.prepare("SELECT id FROM checklists WHERE client_id = ? AND kind = 'post' AND target_id = ?").bind(ctx.me.client_id, b.post_id).first<{ id: number }>();
  if (!list) return c.json({ error: "not_found" }, 404);
  await ctx.db.prepare("INSERT OR IGNORE INTO shift_checklists (shift_id, checklist_id) VALUES (?, ?)").bind(ctx.sh.id, list.id).run();
  return c.json({ ok: true });
});
app.delete("/api/shifts/:id/checklist/posts/:postId", async (c) => {
  const id = intParam(c.req.param("id")), postId = intParam(c.req.param("postId"));
  const ctx = id ? await checklistShift(c, id) : null;
  if (!ctx || !postId) return c.json({ error: "not_found" }, 404);
  const list = await ctx.db.prepare("SELECT id FROM checklists WHERE client_id = ? AND kind = 'post' AND target_id = ?").bind(ctx.me.client_id, postId).first<{ id: number }>();
  if (list) await ctx.db.batch([
    ctx.db.prepare("DELETE FROM shift_checklists WHERE shift_id = ? AND checklist_id = ?").bind(ctx.sh.id, list.id),
    ctx.db.prepare("DELETE FROM shift_checklist_done WHERE shift_id = ? AND item_id IN (SELECT id FROM checklist_items WHERE checklist_id = ?)").bind(ctx.sh.id, list.id),
  ]);
  return c.json({ ok: true });
});
app.put("/api/shifts/:id/checklist/items", async (c) => {
  const id = intParam(c.req.param("id"));
  const b = await c.req.json<{ item_id?: number; done?: boolean }>().catch(() => ({} as { item_id?: number; done?: boolean }));
  const ctx = id ? await checklistShift(c, id) : null;
  if (!ctx || !b.item_id || typeof b.done !== "boolean") return c.json({ error: "not_found" }, 404);
  // the item has to be on one of this shift's lists
  const lists = await listsForShift(ctx.db, ctx.sh, ctx.me.client_id);
  if (!lists.some((l) => l.items.some((i) => i.id === b.item_id))) return c.json({ error: "not_found" }, 404);
  await (b.done
    ? ctx.db.prepare("INSERT OR IGNORE INTO shift_checklist_done (shift_id, item_id, done_by, done_at) VALUES (?, ?, ?, ?)").bind(ctx.sh.id, b.item_id, ctx.me.id, Date.now())
    : ctx.db.prepare("DELETE FROM shift_checklist_done WHERE shift_id = ? AND item_id = ?").bind(ctx.sh.id, b.item_id)).run();
  return c.json({ ok: true });
});

// Shifts whose end-of-shift list the caller should be doing now: on shift, or up to an hour after it ended, until everything is ticked.
const CHECKLIST_GRACE_MIN = 60;
app.get("/api/my-checklist", async (c) => {
  const me = c.get("me"), db = c.env.DB;
  const now = localNow(c.env.TIMEZONE);
  const test = (await getSetting(db, me.client_id, "checklist_test")) === "1";
  // test mode: the tab is always there, for the shifts of the last and next 7 days (finished lists stay too)
  const since = new Date(Date.parse(`${now}:00Z`) - (test ? 7 * 86_400_000 : CHECKLIST_GRACE_MIN * 60_000)).toISOString().slice(0, 16);
  const until = test ? new Date(Date.parse(`${now}:00Z`) + 7 * 86_400_000).toISOString().slice(0, 16) : now;
  const shifts = (await db.prepare(
    `SELECT sh.id, sh.staff_id, sh.restaurant_id, sh.role_id, sh.start_at, sh.end_at, rs.name AS restaurant, ro.name_fr, ro.name_en, ro.department_id
     FROM shifts sh JOIN restaurants rs ON rs.id = sh.restaurant_id JOIN roles ro ON ro.id = sh.role_id
     WHERE sh.staff_id = ? AND sh.status = 'ok' AND sh.start_at <= ? AND sh.end_at >= ? AND ${shiftVisible(me)} ORDER BY sh.start_at LIMIT 12`,
  ).bind(me.id, until, since).all<ShiftRefFull>()).results;
  const out = [];
  for (const sh of shifts) {
    const p = await checklistProgress(db, sh, me.client_id);
    const kitchen = sh.department_id === "kitchen";
    if (!p.total && !kitchen) continue; // nothing to do for this role
    if (!test && p.total && p.done === p.total) continue; // finished: the tab goes away
    out.push({ id: sh.id, restaurant: sh.restaurant, role_fr: sh.name_fr, role_en: sh.name_en, start_at: sh.start_at, end_at: sh.end_at, total: p.total, done: p.done, needs_post: kitchen && !p.lists.some((l) => l.kind === "post") });
  }
  return c.json({ test, shifts: out });
});

// Administration: edit the lists. Items keep their id when edited, so the history of past shifts stays right.
app.get("/api/admin/checklists", requireAdmin, async (c) => {
  const cid = c.get("me").client_id, db = c.env.DB;
  const lists = (await db.prepare("SELECT id, kind, target_id FROM checklists WHERE client_id = ?").bind(cid).all<{ id: number; kind: string; target_id: number }>()).results;
  const items = lists.length ? (await db.prepare(`SELECT id, checklist_id, text_fr, text_en, last_out FROM checklist_items WHERE checklist_id IN (${lists.map(() => "?").join(",")}) ORDER BY position, id`).bind(...lists.map((l) => l.id)).all<{ checklist_id: number }>()).results : [];
  const posts = (await db.prepare("SELECT id, name_fr, name_en, department_id FROM posts WHERE all_posts = 0 ORDER BY sort").all()).results;
  const roles = (await db.prepare("SELECT id, name_fr, name_en, department_id FROM roles ORDER BY id").all()).results;
  return c.json({ lists: lists.map((l) => ({ ...l, items: items.filter((i) => i.checklist_id === l.id) })), posts, roles, test_mode: (await getSetting(db, cid, "checklist_test")) === "1" });
});
app.put("/api/admin/checklists", requireAdmin, async (c) => {
  const cid = c.get("me").client_id, db = c.env.DB;
  const b = await c.req.json<{ kind?: string; target_id?: number; items?: { id?: number; text_fr?: string; text_en?: string; last_out?: boolean }[] }>().catch(() => ({} as { kind?: string; target_id?: number; items?: { id?: number; text_fr?: string; text_en?: string; last_out?: boolean }[] }));
  if ((b.kind !== "post" && b.kind !== "role") || !b.target_id || !Array.isArray(b.items) || b.items.length > 60) return c.json({ error: "invalid_checklist" }, 400);
  const exists = b.kind === "post" ? await db.prepare("SELECT 1 FROM posts WHERE id = ?").bind(b.target_id).first() : await db.prepare("SELECT 1 FROM roles WHERE id = ?").bind(b.target_id).first();
  if (!exists) return c.json({ error: "not_found" }, 404);
  const items = b.items.map((x) => ({ id: x.id, fr: (x.text_fr ?? "").trim(), en: (x.text_en ?? "").trim(), last: x.last_out ? 1 : 0 })).filter((x) => x.fr);
  if (items.some((x) => x.fr.length > 200 || x.en.length > 200)) return c.json({ error: "invalid_checklist" }, 400);
  await db.prepare("INSERT OR IGNORE INTO checklists (client_id, kind, target_id) VALUES (?, ?, ?)").bind(cid, b.kind, b.target_id).run();
  const list = (await db.prepare("SELECT id FROM checklists WHERE client_id = ? AND kind = ? AND target_id = ?").bind(cid, b.kind, b.target_id).first<{ id: number }>())!;
  const current = (await db.prepare("SELECT id FROM checklist_items WHERE checklist_id = ?").bind(list.id).all<{ id: number }>()).results.map((r) => r.id);
  const keep = new Set(items.filter((x) => x.id && current.includes(x.id)).map((x) => x.id!));
  await db.batch([
    ...current.filter((i) => !keep.has(i)).map((i) => db.prepare("DELETE FROM checklist_items WHERE id = ?").bind(i)),
    ...items.map((x, pos) => x.id && keep.has(x.id)
      ? db.prepare("UPDATE checklist_items SET position = ?, text_fr = ?, text_en = ?, last_out = ? WHERE id = ? AND checklist_id = ?").bind(pos + 1, x.fr, x.en || null, x.last, x.id, list.id)
      : db.prepare("INSERT INTO checklist_items (checklist_id, position, text_fr, text_en, last_out) VALUES (?, ?, ?, ?, ?)").bind(list.id, pos + 1, x.fr, x.en || null, x.last)),
  ]);
  return c.json({ ok: true, id: list.id });
});
app.put("/api/admin/checklists/test-mode", requireAdmin, async (c) => {
  const cid = c.get("me").client_id;
  const { on } = await c.req.json<{ on?: boolean }>().catch(() => ({} as { on?: boolean }));
  if (typeof on !== "boolean") return c.json({ error: "bad_request" }, 400);
  await (on ? putSettingStmt(c.env.DB, cid, "checklist_test", "1") : delSettingStmt(c.env.DB, cid, "checklist_test")).run();
  return c.json({ ok: true, on });
});
// Who did their end-of-shift list on a day (all restaurants of the client).
app.get("/api/admin/checklist-report", requireAdmin, async (c) => {
  const cid = c.get("me").client_id, db = c.env.DB;
  const date = c.req.query("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "invalid_date" }, 400);
  const shifts = (await db.prepare(
    `SELECT sh.id, sh.staff_id, sh.restaurant_id, sh.role_id, sh.start_at, sh.end_at, s.name AS staff_name, rs.name AS restaurant, ro.name_fr, ro.name_en, ro.department_id
     FROM shifts sh JOIN staff s ON s.id = sh.staff_id JOIN restaurants rs ON rs.id = sh.restaurant_id JOIN roles ro ON ro.id = sh.role_id
     WHERE rs.client_id = ? AND sh.status = 'ok' AND substr(sh.start_at, 1, 10) = ? ORDER BY rs.name, sh.end_at, s.name`,
  ).bind(cid, date).all<ShiftRefFull>()).results;
  const rows = [];
  for (const sh of shifts) {
    const p = await checklistProgress(db, sh, cid);
    if (!p.total && !(await db.prepare("SELECT 1 FROM roles WHERE id = ? AND department_id = 'kitchen'").bind(sh.role_id).first())) continue;
    rows.push({ shift_id: sh.id, staff_name: sh.staff_name, restaurant: sh.restaurant, role_fr: sh.name_fr, role_en: sh.name_en, start_at: sh.start_at, end_at: sh.end_at, total: p.total, done: p.done,
      missing: p.lists.flatMap((l) => l.items.filter((i) => !i.done).map((i) => ({ text_fr: i.text_fr, text_en: i.text_en }))) });
  }
  return c.json(rows);
});
type ShiftRefFull = { id: number; staff_id: number; restaurant_id: number; role_id: number; start_at: string; end_at: string; staff_name: string; restaurant: string; name_fr: string; name_en: string; department_id: string };

// ---------- Web Push (this device) ----------
app.get("/api/push/key", async (c) => c.json({ publicKey: (await getVapid(c.env.DB)).publicKey }));
app.get("/api/push/status", async (c) => {
  const endpoint = c.req.query("endpoint") ?? "";
  const mine = (await c.env.DB.prepare("SELECT endpoint FROM push_subscriptions WHERE staff_id = ?").bind(c.get("me").id).all<{ endpoint: string }>()).results;
  return c.json({ devices: mine.length, this_device: !!endpoint && mine.some((x) => x.endpoint === endpoint) });
});
app.post("/api/push/subscribe", async (c) => {
  const b = await c.req.json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>().catch(() => ({} as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }));
  if (!b.endpoint || !/^https:\/\//.test(b.endpoint) || b.endpoint.length > 1000 || !b.keys?.p256dh || !b.keys?.auth || b.keys.p256dh.length > 200 || b.keys.auth.length > 100) return c.json({ error: "invalid_subscription" }, 400);
  await c.env.DB.prepare("INSERT INTO push_subscriptions (staff_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET staff_id = excluded.staff_id, p256dh = excluded.p256dh, auth = excluded.auth")
    .bind(c.get("me").id, b.endpoint, b.keys.p256dh, b.keys.auth, (c.req.header("user-agent") ?? "").slice(0, 200), Date.now()).run();
  return c.json({ ok: true });
});
app.delete("/api/push/subscribe", async (c) => {
  const b = await c.req.json<{ endpoint?: string }>().catch(() => ({} as { endpoint?: string }));
  if (!b.endpoint) return c.json({ error: "bad_request" }, 400);
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE staff_id = ? AND endpoint = ?").bind(c.get("me").id, b.endpoint).run();
  return c.json({ ok: true });
});
app.post("/api/push/test", async (c) => {
  const me = c.get("me");
  const sent = await pushToStaff(c.env.DB, me.id, { title: (await loadConnections(c.env, c.env.DB, me.client_id)).brand ?? "Mikes", body: "✓ Notifications activées / enabled", url: "/", tag: "test" }, { appUrl: c.env.APP_URL ?? new URL(c.req.url).origin });
  return c.json({ sent });
});

// ---------- Communities ----------
// A message board per restaurant and group of departments. People get in through their roles (or by managing a department of the group);
// administrators see them all. Managers of a department of the group, and administrators, moderate (pin, delete).
const COMMUNITY_DEPTS = ["floor", "kitchen", "prep", "delivery", "admin"];
type CommunityRow = { id: number; name: string; restaurant_id: number; restaurant: string; position: number };
async function myCommunities(db: D1Database, me: Me): Promise<(CommunityRow & { unread: number; last_post_at: string | null; departments: string[] })[]> {
  const base = "SELECT DISTINCT c.id, c.name, c.restaurant_id, r.name AS restaurant, c.position FROM communities c JOIN restaurants r ON r.id = c.restaurant_id";
  const rows = me.is_admin
    ? (await db.prepare(`${base} WHERE r.client_id = ? ORDER BY r.name, c.position, c.id`).bind(me.client_id).all<CommunityRow>()).results
    : (await db.prepare(
        `SELECT * FROM (
           ${base} JOIN community_departments cd ON cd.community_id = c.id JOIN roles ro ON ro.department_id = cd.department_id
             JOIN staff_roles sr ON sr.role_id = ro.id AND sr.restaurant_id = c.restaurant_id WHERE sr.staff_id = ?1 AND r.client_id = ?2
           UNION
           ${base} JOIN community_departments cd ON cd.community_id = c.id JOIN managers m ON m.department_id = cd.department_id AND m.restaurant_id = c.restaurant_id WHERE m.staff_id = ?1 AND r.client_id = ?2
         ) ORDER BY restaurant, position, id`,
      ).bind(me.id, me.client_id).all<CommunityRow>()).results;
  if (!rows.length) return [];
  const marks = rows.map(() => "?").join(",");
  const stats = (await db.prepare(
    `SELECT c.id, (SELECT max(created_at) FROM community_posts WHERE community_id = c.id) AS last_post_at,
            (SELECT count(*) FROM community_posts p WHERE p.community_id = c.id AND p.staff_id != ? AND p.id > coalesce((SELECT last_post_id FROM community_reads WHERE community_id = c.id AND staff_id = ?), 0)) AS unread
     FROM communities c WHERE c.id IN (${marks})`,
  ).bind(me.id, me.id, ...rows.map((r) => r.id)).all<{ id: number; last_post_at: string | null; unread: number }>()).results;
  const deps = (await db.prepare(`SELECT community_id, department_id FROM community_departments WHERE community_id IN (${marks})`).bind(...rows.map((r) => r.id)).all<{ community_id: number; department_id: string }>()).results;
  return rows.map((r) => ({ ...r, departments: deps.filter((d) => d.community_id === r.id).map((d) => d.department_id), ...(stats.find((x) => x.id === r.id) ?? { unread: 0, last_post_at: null }) }));
}
async function communityAccess(db: D1Database, me: Me, id: number) {
  return (await myCommunities(db, me)).find((x) => x.id === id) ?? null;
}
async function moderates(db: D1Database, me: Me, communityId: number) {
  if (me.is_admin) return true;
  return !!(await db.prepare(
    "SELECT 1 FROM managers m JOIN communities c ON c.restaurant_id = m.restaurant_id JOIN community_departments cd ON cd.community_id = c.id AND cd.department_id = m.department_id WHERE m.staff_id = ? AND c.id = ?",
  ).bind(me.id, communityId).first());
}

app.get("/api/communities", async (c) => c.json(await myCommunities(c.env.DB, c.get("me"))));

app.get("/api/communities/:id/posts", async (c) => {
  const me = c.get("me"), db = c.env.DB;
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  const community = await communityAccess(db, me, id);
  if (!community) return c.json({ error: "forbidden" }, 403);
  const before = intParam(c.req.query("before")) ?? 0;
  const mod = await moderates(db, me, id);
  const tops = (await db.prepare(
    `SELECT p.id, p.body, p.pinned, p.created_at, p.staff_id, s.name AS author, s.first_name, s.color, (SELECT updated_at FROM staff_photos WHERE staff_id = s.id) AS photo_v
     FROM community_posts p JOIN staff s ON s.id = p.staff_id
     WHERE p.community_id = ? AND p.parent_id IS NULL AND (? = 0 OR p.id < ?)
     ORDER BY ${before ? "p.id DESC" : "p.pinned DESC, p.id DESC"} LIMIT 31`,
  ).bind(id, before, before).all<{ id: number; body: string; pinned: number; created_at: string; staff_id: number }>()).results;
  const more = tops.length > 30;
  const page = tops.slice(0, 30);
  const replies = page.length ? (await db.prepare(
    `SELECT p.id, p.parent_id, p.body, p.created_at, p.staff_id, s.name AS author, s.first_name, s.color, (SELECT updated_at FROM staff_photos WHERE staff_id = s.id) AS photo_v
     FROM community_posts p JOIN staff s ON s.id = p.staff_id WHERE p.parent_id IN (${page.map(() => "?").join(",")}) ORDER BY p.id`,
  ).bind(...page.map((x) => x.id)).all<{ id: number; parent_id: number; staff_id: number }>()).results : [];
  const allIds = [...page.map((x) => x.id), ...replies.map((x) => x.id)];
  const media = allIds.length ? (await db.prepare(`SELECT id, post_id, kind, mime FROM community_media WHERE post_id IN (${allIds.map(() => "?").join(",")}) ORDER BY id`).bind(...allIds).all<{ id: number; post_id: number; kind: string; mime: string }>()).results : [];
  const reacts = allIds.length ? (await db.prepare(`SELECT post_id, emoji, count(*) AS n, max(staff_id = ?) AS mine FROM community_reactions WHERE post_id IN (${allIds.map(() => "?").join(",")}) GROUP BY post_id, emoji ORDER BY min(rowid)`).bind(me.id, ...allIds).all<{ post_id: number; emoji: string; n: number; mine: number }>()).results : [];
  const mark = (x: { id: number; staff_id: number }) => ({ ...x, media: media.filter((m) => m.post_id === x.id), reactions: reacts.filter((r) => r.post_id === x.id).map((r) => ({ emoji: r.emoji, count: r.n, mine: r.mine === 1 })), mine: x.staff_id === me.id, can_delete: mod || x.staff_id === me.id });
  if (!before) {
    const last = (await db.prepare("SELECT coalesce(max(id), 0) AS m FROM community_posts WHERE community_id = ?").bind(id).first<{ m: number }>())?.m ?? 0;
    await db.prepare("INSERT INTO community_reads (community_id, staff_id, last_post_id) VALUES (?, ?, ?) ON CONFLICT (community_id, staff_id) DO UPDATE SET last_post_id = excluded.last_post_id").bind(id, me.id, last).run();
  }
  return c.json({ community, moderator: mod, more, posts: page.map((x) => ({ ...mark(x), pinned: x.pinned === 1, replies: replies.filter((r) => r.parent_id === x.id).map(mark) })) });
});

app.post("/api/communities/:id/posts", async (c) => {
  const me = c.get("me"), db = c.env.DB;
  const id = intParam(c.req.param("id"));
  const b = await c.req.json<{ body?: string; parent_id?: number; media_ids?: number[] }>().catch(() => ({} as { body?: string; parent_id?: number; media_ids?: number[] }));
  if (!id) return c.json({ error: "bad_id" }, 400);
  if (!(await communityAccess(db, me, id))) return c.json({ error: "forbidden" }, 403);
  const body = (b.body ?? "").trim();
  const mediaIds = [...new Set((b.media_ids ?? []).filter((x) => Number.isInteger(x)))];
  if (mediaIds.length > MAX_MEDIA_PER_POST || body.length > 2000 || (!body && !mediaIds.length)) return c.json({ error: "invalid_body" }, 400);
  // only the caller's own, not yet published uploads of this community
  if (mediaIds.length) {
    const ok = await db.prepare(`SELECT count(*) AS n FROM community_media WHERE id IN (${mediaIds.map(() => "?").join(",")}) AND staff_id = ? AND community_id = ? AND post_id IS NULL`).bind(...mediaIds, me.id, id).first<{ n: number }>();
    if (ok?.n !== mediaIds.length) return c.json({ error: "invalid_media" }, 400);
  }
  if (b.parent_id) {
    const parent = await db.prepare("SELECT 1 FROM community_posts WHERE id = ? AND community_id = ? AND parent_id IS NULL").bind(b.parent_id, id).first();
    if (!parent) return c.json({ error: "not_found" }, 404);
  }
  const r = await db.prepare("INSERT INTO community_posts (community_id, parent_id, staff_id, body) VALUES (?, ?, ?, ?)").bind(id, b.parent_id ?? null, me.id, body).run();
  if (mediaIds.length) await db.prepare(`UPDATE community_media SET post_id = ? WHERE id IN (${mediaIds.map(() => "?").join(",")})`).bind(r.meta.last_row_id, ...mediaIds).run();
  const preview = body ? "" : (await db.prepare("SELECT kind FROM community_media WHERE post_id = ? LIMIT 1").bind(r.meta.last_row_id).first<{ kind: string }>())?.kind === "video" ? "🎥" : "📷";
  // everyone of the community who enabled notifications (the author excepted)
  c.executionCtx.waitUntil((async () => {
    try {
      const community = (await communityAccess(db, me, id))!;
      const people = (await db.prepare(
        `SELECT DISTINCT s.id FROM staff s JOIN push_subscriptions ps ON ps.staff_id = s.id
         WHERE s.active = 1 AND s.id != ?1 AND s.client_id = ?2 AND (s.is_admin = 1
           OR s.id IN (SELECT sr.staff_id FROM staff_roles sr JOIN roles ro ON ro.id = sr.role_id JOIN community_departments cd ON cd.department_id = ro.department_id WHERE cd.community_id = ?3 AND sr.restaurant_id = ?4)
           OR s.id IN (SELECT m.staff_id FROM managers m JOIN community_departments cd ON cd.department_id = m.department_id WHERE cd.community_id = ?3 AND m.restaurant_id = ?4))`,
      ).bind(me.id, me.client_id, id, community.restaurant_id).all<{ id: number }>()).results;
      const first = me.name.split(" ")[0];
      for (const p of people) await pushToStaff(db, p.id, { title: `${first} · ${community.name}`, body: (body || preview).slice(0, 140), url: `/?view=community&c=${id}`, tag: `community-${id}` }, { appUrl: c.env.APP_URL ?? new URL(c.req.url).origin });
    } catch { /* notifications never block a post */ }
  })());
  return c.json({ id: r.meta.last_row_id }, 201);
});

// Photos and videos of community posts. Uploaded first (raw body), attached to the post when it is published.
const MEDIA_TYPES: Record<string, "image" | "video"> = { "image/jpeg": "image", "image/png": "image", "image/webp": "image", "video/mp4": "video", "video/quicktime": "video", "video/webm": "video" };
const MAX_IMAGE_BYTES = 3 * 1024 * 1024, MAX_VIDEO_BYTES = 20 * 1024 * 1024, MAX_MEDIA_PER_POST = 4, MEDIA_CHUNK = 600_000;
function sniffMedia(b: Uint8Array, mime: string): boolean {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (mime === "image/jpeg") return at(0, 0xff, 0xd8);
  if (mime === "image/png") return at(0, 0x89, 0x50, 0x4e, 0x47);
  if (mime === "image/webp") return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50);
  if (mime === "video/webm") return at(0, 0x1a, 0x45, 0xdf, 0xa3);
  return at(4, 0x66, 0x74, 0x79, 0x70); // mp4 / mov: "ftyp"
}
const toB64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
app.post("/api/communities/:id/media", async (c) => {
  const me = c.get("me"), db = c.env.DB;
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  if (!(await communityAccess(db, me, id))) return c.json({ error: "forbidden" }, 403);
  const mime = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const kind = MEDIA_TYPES[mime];
  if (!kind) return c.json({ error: "invalid_type" }, 400);
  const limit = kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (Number(c.req.header("content-length") ?? 0) > limit) return c.json({ error: "too_large", max: limit }, 413);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (!bytes.length || bytes.length > limit) return c.json({ error: bytes.length ? "too_large" : "invalid_media", max: limit }, bytes.length ? 413 : 400);
  if (!sniffMedia(bytes, mime)) return c.json({ error: "invalid_media" }, 400);
  const r = await db.prepare("INSERT INTO community_media (community_id, staff_id, kind, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, me.id, kind, mime, bytes.length, Date.now()).run();
  const mid = r.meta.last_row_id as number;
  for (let i = 0, n = 0; i < bytes.length; i += MEDIA_CHUNK, n++) {
    await db.prepare("INSERT INTO community_media_chunks (media_id, idx, data) VALUES (?, ?, ?)").bind(mid, n, toB64(bytes.subarray(i, i + MEDIA_CHUNK))).run();
  }
  return c.json({ id: mid, kind, mime }, 201);
});
app.get("/api/community-media/:id", async (c) => {
  const me = c.get("me"), db = c.env.DB;
  const id = intParam(c.req.param("id"));
  if (!id) return c.body(null, 404);
  const m = await db.prepare("SELECT community_id, mime, size FROM community_media WHERE id = ?").bind(id).first<{ community_id: number; mime: string; size: number }>();
  if (!m) return c.body(null, 404);
  if (!(await communityAccess(db, me, m.community_id))) return c.body(null, 403);
  let start = 0, end = m.size - 1, status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), m.size - 1) : m.size - 1; }
    else { start = Math.max(0, m.size - Number(range[2])); }
    if (start > end || start >= m.size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${m.size}` } });
    status = 206;
  }
  const first = Math.floor(start / MEDIA_CHUNK), last = Math.floor(end / MEDIA_CHUNK);
  const rows = (await db.prepare("SELECT idx, data FROM community_media_chunks WHERE media_id = ? AND idx BETWEEN ? AND ? ORDER BY idx").bind(id, first, last).all<{ idx: number; data: string }>()).results;
  const parts = rows.map((r) => Uint8Array.from(atob(r.data), (ch) => ch.charCodeAt(0)));
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { joined.set(p, o); o += p.length; }
  const out = joined.subarray(start - first * MEDIA_CHUNK, end - first * MEDIA_CHUNK + 1);
  return new Response(out, { status, headers: {
    "content-type": m.mime, "content-length": String(out.length), "accept-ranges": "bytes", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
    ...(status === 206 ? { "content-range": `bytes ${start}-${end}/${m.size}` } : {}),
  } });
});

app.delete("/api/community-posts/:id", async (c) => {
  const me = c.get("me"), db = c.env.DB;
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  const post = await db.prepare("SELECT community_id, staff_id FROM community_posts WHERE id = ?").bind(id).first<{ community_id: number; staff_id: number }>();
  if (!post) return c.json({ error: "not_found" }, 404);
  if (!(await communityAccess(db, me, post.community_id))) return c.json({ error: "forbidden" }, 403);
  if (post.staff_id !== me.id && !(await moderates(db, me, post.community_id))) return c.json({ error: "forbidden" }, 403);
  await db.prepare("DELETE FROM community_posts WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// any single emoji (with its skin-tone / variation selectors and joiners), nothing else
const isEmoji = (e: string) => e.length > 0 && e.length <= 24 && /^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*$/u.test(e);
app.put("/api/community-posts/:id/reaction", async (c) => {
  const me = c.get("me"), db = c.env.DB;
  const id = intParam(c.req.param("id"));
  const b = await c.req.json<{ emoji?: string; on?: boolean }>().catch(() => ({} as { emoji?: string; on?: boolean }));
  if (!id || !isEmoji(b.emoji ?? "") || typeof b.on !== "boolean") return c.json({ error: "bad_request" }, 400);
  const post = await db.prepare("SELECT community_id FROM community_posts WHERE id = ?").bind(id).first<{ community_id: number }>();
  if (!post) return c.json({ error: "not_found" }, 404);
  if (!(await communityAccess(db, me, post.community_id))) return c.json({ error: "forbidden" }, 403);
  await (b.on
    ? db.prepare("INSERT OR IGNORE INTO community_reactions (post_id, staff_id, emoji) VALUES (?, ?, ?)").bind(id, me.id, b.emoji)
    : db.prepare("DELETE FROM community_reactions WHERE post_id = ? AND staff_id = ? AND emoji = ?").bind(id, me.id, b.emoji)).run();
  return c.json({ ok: true });
});

app.put("/api/community-posts/:id/pin", async (c) => {
  const me = c.get("me"), db = c.env.DB;
  const id = intParam(c.req.param("id"));
  const { pinned } = await c.req.json<{ pinned?: boolean }>().catch(() => ({} as { pinned?: boolean }));
  if (!id || typeof pinned !== "boolean") return c.json({ error: "bad_request" }, 400);
  const post = await db.prepare("SELECT community_id FROM community_posts WHERE id = ? AND parent_id IS NULL").bind(id).first<{ community_id: number }>();
  if (!post) return c.json({ error: "not_found" }, 404);
  if (!(await moderates(db, me, post.community_id))) return c.json({ error: "forbidden" }, 403);
  await db.prepare("UPDATE community_posts SET pinned = ? WHERE id = ?").bind(pinned ? 1 : 0, id).run();
  return c.json({ ok: true });
});

// Administration: which communities each restaurant has and which departments they gather.
app.get("/api/admin/communities", requireAdmin, async (c) => {
  const cid = c.get("me").client_id;
  const rows = (await c.env.DB.prepare("SELECT c.id, c.name, c.restaurant_id, c.position FROM communities c JOIN restaurants r ON r.id = c.restaurant_id WHERE r.client_id = ? ORDER BY c.restaurant_id, c.position, c.id").bind(cid).all<{ id: number; name: string; restaurant_id: number }>()).results;
  const deps = (await c.env.DB.prepare("SELECT cd.community_id, cd.department_id FROM community_departments cd JOIN communities c ON c.id = cd.community_id JOIN restaurants r ON r.id = c.restaurant_id WHERE r.client_id = ?").bind(cid).all<{ community_id: number; department_id: string }>()).results;
  return c.json(rows.map((x) => ({ ...x, departments: deps.filter((d) => d.community_id === x.id).map((d) => d.department_id) })));
});
const validCommunity = (b: { name?: string; departments?: string[] }) => {
  const name = (b.name ?? "").trim();
  const deps = [...new Set((b.departments ?? []).filter((d) => COMMUNITY_DEPTS.includes(d)))];
  return name && name.length <= 60 && deps.length ? { name, deps } : null;
};
app.post("/api/admin/communities", requireAdmin, async (c) => {
  const b = await c.req.json<{ restaurant_id?: number; name?: string; departments?: string[] }>().catch(() => ({} as { restaurant_id?: number; name?: string; departments?: string[] }));
  const v = validCommunity(b);
  if (!b.restaurant_id || !v) return c.json({ error: "invalid_community" }, 400);
  const pos = ((await c.env.DB.prepare("SELECT max(position) AS m FROM communities WHERE restaurant_id = ?").bind(b.restaurant_id).first<{ m: number | null }>())?.m ?? 0) + 1;
  const r = await c.env.DB.prepare("INSERT INTO communities (restaurant_id, name, position) VALUES (?, ?, ?)").bind(b.restaurant_id, v.name, pos).run();
  const id = r.meta.last_row_id as number;
  await c.env.DB.batch(v.deps.map((d) => c.env.DB.prepare("INSERT INTO community_departments (community_id, department_id) VALUES (?, ?)").bind(id, d)));
  return c.json({ id }, 201);
});
app.put("/api/admin/communities/:id", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const b = await c.req.json<{ name?: string; departments?: string[] }>().catch(() => ({} as { name?: string; departments?: string[] }));
  const v = validCommunity(b);
  if (!id || !v) return c.json({ error: "invalid_community" }, 400);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE communities SET name = ? WHERE id = ?").bind(v.name, id),
    c.env.DB.prepare("DELETE FROM community_departments WHERE community_id = ?").bind(id),
    ...v.deps.map((d) => c.env.DB.prepare("INSERT INTO community_departments (community_id, department_id) VALUES (?, ?)").bind(id, d)),
  ]);
  return c.json({ ok: true });
});
app.delete("/api/admin/communities/:id", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  await c.env.DB.prepare("DELETE FROM communities WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

app.get("/api/roster", async (c) => {
  const restaurantId = intParam(c.req.query("restaurant"));
  const department = c.req.query("department");
  if (!restaurantId || !department) return c.json({ error: "restaurant_and_department_required" }, 400);
  if (!(await canManage(c.env.DB, c.get("me"), restaurantId, department))) return c.json({ error: "forbidden" }, 403);
  const rows = await c.env.DB.prepare(
    `SELECT s.id AS staff_id, s.name, s.first_name, s.last_name, s.sex, s.print_order, s.color, (SELECT updated_at FROM staff_photos WHERE staff_id = s.id) AS photo_v, sr.role_id FROM staff_roles sr
     JOIN staff s ON s.id = sr.staff_id JOIN roles ro ON ro.id = sr.role_id
     WHERE sr.restaurant_id = ? AND ro.department_id = ? AND s.active = 1 ORDER BY s.name`,
  )
    .bind(restaurantId, department)
    .all<{ staff_id: number; name: string; first_name: string; last_name: string; sex: string | null; print_order: number | null; color: string | null; photo_v: number | null; role_id: number }>();
  const byStaff = new Map<number, { staff_id: number; name: string; first_name: string; last_name: string; sex: string | null; print_order: number | null; color: string | null; photo_v: number | null; role_ids: number[] }>();
  for (const r of rows.results) {
    const e = byStaff.get(r.staff_id) ?? { staff_id: r.staff_id, name: r.name, first_name: r.first_name, last_name: r.last_name, sex: r.sex, print_order: r.print_order, color: r.color, photo_v: r.photo_v, role_ids: [] };
    e.role_ids.push(r.role_id);
    byStaff.set(r.staff_id, e);
  }
  // All roles each person holds at this restaurant (any department): a shift can cover roles outside the schedule being edited.
  const allRoles = (await c.env.DB.prepare("SELECT staff_id, role_id FROM staff_roles WHERE restaurant_id = ?").bind(restaurantId).all<{ staff_id: number; role_id: number }>()).results;
  return c.json(sortByName([...byStaff.values()].map((e) => ({ ...e, all_role_ids: allRoles.filter((r) => r.staff_id === e.staff_id).map((r) => r.role_id) }))));
});

app.get("/api/admin/overview", requireAdmin, async (c) => {
  const db = c.env.DB;
  const cid = c.get("me").client_id;
  const [staff, roles, managers, restaurants, roleWages] = await Promise.all([
    db.prepare("SELECT id, name, first_name, last_name, sex, print_order, promised_hours, scheduling_notes, email, phone, is_admin, active, lang, notify_channel, color, (SELECT updated_at FROM staff_photos WHERE staff_id = staff.id) AS photo_v, (SELECT hourly_cents FROM staff_wages WHERE staff_id = staff.id) AS hourly_cents, (SELECT last3 FROM staff_sin WHERE staff_id = staff.id) AS sin_last3, (SELECT max_weekly_hours FROM staff_limits WHERE staff_id = staff.id) AS max_weekly_hours FROM staff WHERE client_id = ? ORDER BY name").bind(cid).all(),
    db.prepare("SELECT sr.staff_id, sr.restaurant_id, sr.role_id FROM staff_roles sr JOIN staff s ON s.id = sr.staff_id WHERE s.client_id = ?").bind(cid).all<{ staff_id: number; restaurant_id: number; role_id: number }>(),
    db.prepare("SELECT m.staff_id, m.restaurant_id, m.department_id FROM managers m JOIN staff s ON s.id = m.staff_id WHERE s.client_id = ?").bind(cid).all<{ staff_id: number; restaurant_id: number; department_id: string }>(),
    db.prepare("SELECT id, name, open_time, close_time FROM restaurants WHERE client_id = ? ORDER BY name").bind(cid).all(),
    db.prepare("SELECT w.staff_id, w.role_id, w.hourly_cents FROM staff_role_wages w JOIN staff s ON s.id = w.staff_id WHERE s.client_id = ?").bind(cid).all<{ staff_id: number; role_id: number; hourly_cents: number }>(),
  ]);
  return c.json({
    restaurants: await withOpenHours(db, restaurants.results as { id: number; name: string; open_time: string; close_time: string }[]),
    default_rates: await defaultRates(db, cid),
    staff: sortByName(staff.results as any[]).map((s) => ({
      ...s,
      is_admin: s.is_admin === 1,
      active: s.active !== 0,
      roles: roles.results.filter((r) => r.staff_id === s.id),
      managers: managers.results.filter((m) => m.staff_id === s.id),
      role_rates: Object.fromEntries(roleWages.results.filter((w) => w.staff_id === s.id).map((w) => [w.role_id, w.hourly_cents])),
    })),
  });
});

app.put("/api/staff/:id", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  const b = await c.req.json<{ first_name?: string; last_name?: string; name?: string; email?: string; phone?: string; lang?: string; notify_channel?: string; color?: string | null; sex?: string | null; print_order?: number | string | null }>();
  const nm = namesFrom(b);
  const po = b.print_order === null || b.print_order === undefined || b.print_order === "" ? null : Number(b.print_order);
  if (po !== null && !(Number.isInteger(po) && po >= 1 && po <= 999)) return c.json({ error: "invalid_order" }, 400);
  if (!nm) return c.json({ error: "name_required" }, 400);
  if (b.color != null && !/^#[0-9a-fA-F]{6}$/.test(b.color)) return c.json({ error: "invalid_color" }, 400);
  const lang = b.lang === "en" ? "en" : "fr";
  const channel = b.notify_channel === "email" ? "email" : "sms";
  const phone = b.phone?.trim() ? normalizePhone(b.phone) : null;
  if (b.phone?.trim() && !phone) return c.json({ error: "invalid_phone" }, 400);
  try {
    await c.env.DB.prepare("UPDATE staff SET name=?, first_name=?, last_name=?, email=?, phone=?, lang=?, notify_channel=?, color=?, sex=?, print_order=? WHERE id=?")
      .bind(nm.name, nm.first, nm.last, b.email?.trim().toLowerCase() || null, phone, lang, channel, b.color?.toLowerCase() ?? null, b.sex === "M" || b.sex === "F" ? b.sex : null, po, id)
      .run();
  } catch {
    return c.json({ error: "email_taken" }, 409);
  }
  emit(c, "staff.updated", () => staffData(c.env.DB, id));
  return c.json({ ok: true });
});

// ---------- Shifts (edit) ----------
interface ShiftInput {
  staff_id: number;
  restaurant_id: number;
  role_id: number;
  start_at: string;
  end_at: string;
  notes?: string;
  until_close?: boolean;
  force?: boolean;
  extra_role_ids?: number[];  // other roles covered by the same shift (e.g. cook + dishwasher)
  no_count_role_ids?: number[]; // extra roles that must not count toward that department's targets
  segments?: { start_at: string; end_at: string; role_ids: number[]; no_count_role_ids?: number[] }[]; // different roles at different hours
}

async function validateShift(c: any, b: ShiftInput, ignoreShiftId?: number) {
  const db: D1Database = c.env.DB;
  if (!SHIFT_TIME_RE.test(b.start_at ?? "") || !SHIFT_TIME_RE.test(b.end_at ?? "") || b.start_at >= b.end_at)
    return { status: 400, body: { error: "invalid_times" } };
  const role = await db.prepare("SELECT department_id FROM roles WHERE id = ?").bind(b.role_id).first<{ department_id: string }>();
  if (!role) return { status: 404, body: { error: "role_not_found" } };
  if (!(await canManage(db, c.get("me"), b.restaurant_id, role.department_id)))
    return { status: 403, body: { error: "forbidden" } };
  const holds = await db
    .prepare("SELECT 1 FROM staff_roles WHERE staff_id = ? AND restaurant_id = ? AND role_id = ?")
    .bind(b.staff_id, b.restaurant_id, b.role_id)
    .first();
  if (!holds) return { status: 422, body: { error: "staff_does_not_hold_role_at_restaurant" } };
  // Extra roles: at most 3, all held by the person here, and the caller must manage each department involved.
  const extras = [...new Set(b.extra_role_ids ?? [])].filter((r) => r !== b.role_id);
  if (extras.length > 3 || extras.some((r) => !Number.isInteger(r))) return { status: 400, body: { error: "invalid_roles" } };
  // Roles by hours: ranges inside the shift, not overlapping, each with 1-3 roles held here and managed by the caller.
  const segs = b.segments ?? [];
  if (segs.length > 8) return { status: 400, body: { error: "invalid_segments" } };
  const sorted = [...segs].sort((x, y) => (x.start_at < y.start_at ? -1 : 1));
  for (let i = 0; i < sorted.length; i++) {
    const g = sorted[i];
    if (!SHIFT_TIME_RE.test(g.start_at ?? "") || !SHIFT_TIME_RE.test(g.end_at ?? "") || g.start_at >= g.end_at || g.start_at < b.start_at || g.end_at > b.end_at || (i > 0 && g.start_at < sorted[i - 1].end_at) || !Array.isArray(g.role_ids) || g.role_ids.length < 1 || g.role_ids.length > 3)
      return { status: 400, body: { error: "invalid_segments" } };
    for (const rid of g.role_ids) {
      const r = await db.prepare("SELECT ro.department_id, (SELECT 1 FROM staff_roles WHERE staff_id = ? AND restaurant_id = ? AND role_id = ro.id) AS held FROM roles ro WHERE ro.id = ?").bind(b.staff_id, b.restaurant_id, rid).first<{ department_id: string; held: number | null }>();
      if (!r) return { status: 404, body: { error: "role_not_found" } };
      if (!r.held) return { status: 422, body: { error: "staff_does_not_hold_role_at_restaurant" } };
      if (!(await canManage(db, c.get("me"), b.restaurant_id, r.department_id))) return { status: 403, body: { error: "forbidden" } };
    }
  }
  for (const rid of extras) {
    const r = await db.prepare("SELECT ro.department_id, (SELECT 1 FROM staff_roles WHERE staff_id = ? AND restaurant_id = ? AND role_id = ro.id) AS held FROM roles ro WHERE ro.id = ?").bind(b.staff_id, b.restaurant_id, rid).first<{ department_id: string; held: number | null }>();
    if (!r) return { status: 404, body: { error: "role_not_found" } };
    if (!r.held) return { status: 422, body: { error: "staff_does_not_hold_role_at_restaurant" } };
    if (!(await canManage(db, c.get("me"), b.restaurant_id, r.department_id))) return { status: 403, body: { error: "forbidden" } };
  }

  // Overlap check spans every restaurant and department for this person.
  const others = await db
    .prepare(
      `SELECT sh.id, sh.start_at, sh.end_at, rs.name AS restaurant
       FROM shifts sh JOIN restaurants rs ON rs.id = sh.restaurant_id
       WHERE sh.staff_id = ? AND sh.id != ? AND sh.status = 'ok' AND sh.start_at < ? AND sh.end_at > ?`,
    )
    .bind(b.staff_id, ignoreShiftId ?? -1, b.end_at, b.start_at)
    .all<{ id: number; start_at: string; end_at: string; restaurant: string }>();
  const clashes = findOverlaps(b, others.results);
  if (clashes.length && !b.force)
    return { status: 409, body: { error: "overlap", conflicts: clashes.map(({ restaurant, start_at, end_at }) => ({ restaurant, start_at, end_at })) } };
  if (b.force) return null;
  // Requested or approved time off (whole or part of a day): warn, the manager can still save anyway.
  const offs = (await db.prepare("SELECT start_date, end_date, start_time, end_time, status FROM time_off_requests WHERE staff_id = ? AND status IN ('requested','approved') AND start_date <= ? AND end_date >= ?")
    .bind(b.staff_id, b.end_at.slice(0, 10), b.start_at.slice(0, 10)).all<{ start_date: string; end_date: string; start_time: string | null; end_time: string | null; status: string }>()).results;
  const off = offs.find((o) => overlapsTimeOff(o, b.start_at, b.end_at));
  if (off) return { status: 409, body: { error: "time_off", time_off: off } };
  // Weekly unavailability (school schedule, other job…).
  const rules = (await db.prepare("SELECT dow, start_time, end_time, valid_from, valid_to, note FROM staff_availability WHERE staff_id = ?").bind(b.staff_id).all<Unavailable>()).results;
  const blocked = findUnavailable(rules, b.start_at, b.end_at);
  if (blocked) return { status: 409, body: { error: "unavailable", rule: blocked } };
  // Personal weekly maximum (e.g. 17 h for an employee under 16).
  const lim = await db.prepare("SELECT max_weekly_hours FROM staff_limits WHERE staff_id = ?").bind(b.staff_id).first<{ max_weekly_hours: number }>();
  if (lim) {
    const wk = weekBounds(mondayOfDate(b.start_at.slice(0, 10)))!;
    const used = await db.prepare("SELECT coalesce(sum((julianday(end_at) - julianday(start_at)) * 24), 0) AS h FROM shifts WHERE staff_id = ? AND status = 'ok' AND id != ? AND start_at >= ? AND start_at < ?")
      .bind(b.staff_id, ignoreShiftId ?? -1, wk.start, wk.end).first<{ h: number }>();
    const mine = (Date.parse(`${b.end_at}:00Z`) - Date.parse(`${b.start_at}:00Z`)) / 3_600_000;
    const total = (used?.h ?? 0) + mine;
    if (total > lim.max_weekly_hours + 1e-9) return { status: 409, body: { error: "max_hours", max: lim.max_weekly_hours, would_be: Math.round(total * 100) / 100 } };
  }
  return null;
}

async function saveExtraRoles(db: D1Database, shiftId: number, b: ShiftInput) {
  const extras = [...new Set(b.extra_role_ids ?? [])].filter((r) => r !== b.role_id);
  await db.batch([
    db.prepare("DELETE FROM shift_segments WHERE shift_id = ?").bind(shiftId),
    ...(b.segments ?? []).flatMap((g) => [...new Set(g.role_ids)].map((rid) =>
      db.prepare("INSERT INTO shift_segments (shift_id, start_at, end_at, role_id, no_count) VALUES (?, ?, ?, ?, ?)").bind(shiftId, g.start_at, g.end_at, rid, (g.no_count_role_ids ?? []).includes(rid) ? 1 : 0))),
    db.prepare("DELETE FROM shift_roles WHERE shift_id = ?").bind(shiftId),
    ...extras.map((rid) => db.prepare("INSERT INTO shift_roles (shift_id, role_id, no_count) VALUES (?, ?, ?)").bind(shiftId, rid, (b.no_count_role_ids ?? []).includes(rid) ? 1 : 0)),
  ]);
}

app.post("/api/shifts", async (c) => {
  const b = await c.req.json<ShiftInput>();
  const problem = await validateShift(c, b);
  if (problem) return c.json(problem.body, problem.status as 400);
  const r = await c.env.DB.prepare(
    "INSERT INTO shifts (staff_id, restaurant_id, role_id, start_at, end_at, notes, until_close) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(b.staff_id, b.restaurant_id, b.role_id, b.start_at, b.end_at, b.notes ?? null, b.until_close ? 1 : 0)
    .run();
  await saveExtraRoles(c.env.DB, r.meta.last_row_id as number, b);
  emit(c, "shift.created", () => shiftData(c.env.DB, r.meta.last_row_id as number));
  return c.json({ id: r.meta.last_row_id }, 201);
});

app.put("/api/shifts/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  const existing = await c.env.DB.prepare(
    "SELECT sh.restaurant_id, ro.department_id FROM shifts sh JOIN roles ro ON ro.id = sh.role_id WHERE sh.id = ?",
  )
    .bind(id)
    .first<{ restaurant_id: number; department_id: string }>();
  if (!existing) return c.json({ error: "not_found" }, 404);
  // Must manage the shift as it is now AND as it will become.
  if (!(await canManage(c.env.DB, c.get("me"), existing.restaurant_id, existing.department_id)))
    return c.json({ error: "forbidden" }, 403);
  const b = await c.req.json<ShiftInput>();
  const problem = await validateShift(c, b, id);
  if (problem) return c.json(problem.body, problem.status as 400);
  await c.env.DB.prepare(
    "UPDATE shifts SET staff_id=?, restaurant_id=?, role_id=?, start_at=?, end_at=?, notes=?, until_close=? WHERE id=?",
  )
    .bind(b.staff_id, b.restaurant_id, b.role_id, b.start_at, b.end_at, b.notes ?? null, b.until_close ? 1 : 0, id)
    .run();
  await saveExtraRoles(c.env.DB, id, b);
  emit(c, "shift.updated", () => shiftData(c.env.DB, id));
  return c.json({ ok: true });
});

app.delete("/api/shifts/:id", async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  const existing = await c.env.DB.prepare(
    "SELECT sh.restaurant_id, ro.department_id FROM shifts sh JOIN roles ro ON ro.id = sh.role_id WHERE sh.id = ?",
  )
    .bind(id)
    .first<{ restaurant_id: number; department_id: string }>();
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (!(await canManage(c.env.DB, c.get("me"), existing.restaurant_id, existing.department_id)))
    return c.json({ error: "forbidden" }, 403);
  const before = await shiftData(c.env.DB, id);
  await c.env.DB.prepare("UPDATE staff_absences SET outcome = 'shift_removed' WHERE outcome = 'open' AND request_id IN (SELECT id FROM coverage_requests WHERE shift_id = ?)").bind(id).run();
  await c.env.DB.prepare("DELETE FROM shifts WHERE id = ?").bind(id).run();
  emit(c, "shift.deleted", async () => before);
  return c.json({ ok: true });
});

// ---------- Public routes (no Access login): reply links and the Twilio webhook ----------
// These must be reachable without logging in, so the hostname needs an Access "Bypass" rule for /r/* and /hooks/*.
// The reply link is protected by its long random token; the webhook by Twilio's request signature.
const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

interface OfferView { client_id: number; sex: string | null; id: number; request_id: number; staff_id: number; status: string; req_status: string; lang: string; restaurant: string; name_fr: string; name_en: string; start_at: string; end_at: string; until_close: number }
const offerByToken = (db: D1Database, token: string) => db.prepare(
  `SELECT o.id, o.request_id, o.staff_id, o.status, cr.status AS req_status, s.lang, s.sex, rs.name AS restaurant, rs.client_id, ro.name_fr, ro.name_en, cr.start_at, cr.end_at, sh.until_close
   FROM coverage_offers o JOIN coverage_requests cr ON cr.id = o.request_id JOIN staff s ON s.id = o.staff_id
        JOIN restaurants rs ON rs.id = cr.restaurant_id JOIN roles ro ON ro.id = cr.role_id JOIN shifts sh ON sh.id = cr.shift_id
   WHERE o.token = ?`,
).bind(token).first<OfferView>();

app.get("/r/:token", async (c) => {
  await ensureMigrated(c.env.DB);
  const token = c.req.param("token");
  const o = /^[A-Za-z0-9_-]{20,64}$/.test(token) ? await offerByToken(c.env.DB, token) : null;
  const lang: Lang = o?.lang === "en" ? "en" : "fr";
  const L = lang === "fr"
    ? { title: "Remplacement demandé", yes: "Accepter", no: "Refuser", gone: "Ce lien n’est plus valide.", filled: "Le remplacement a déjà été comblé. Merci quand même!", done: "Merci, c’est noté.", accepted: "Confirmé! Le quart est à ton horaire.", declined: "Refusé. Merci de nous avoir répondu.", err: "Une erreur est survenue. Réessaie." }
    : { title: "Replacement needed", yes: "Accept", no: "Decline", gone: "This link is no longer valid.", filled: "The replacement has already been filled. Thanks anyway!", done: "Thanks, noted.", accepted: "Confirmed! The shift is on your schedule.", declined: "Declined. Thanks for answering.", err: "Something went wrong. Please try again." };
  const open = !!o && o.status === "sent" && o.req_status === "open";
  const detail = o ? `${genderedRole(lang === "fr" ? o.name_fr : o.name_en, o.sex)} — ${o.restaurant}<br><b>${esc(formatWhen(o.start_at, o.end_at, !!o.until_close, lang))}</b>` : "";
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Mikes</title>
<style>body{font:18px/1.4 system-ui,sans-serif;margin:0;background:#f6f4f1;color:#1f1f23}header{background:#da291c;color:#fff;padding:14px 18px;font-weight:800;font-style:italic;font-size:1.5rem}main{max-width:480px;margin:0 auto;padding:22px 18px}
.card{background:#fff;border-radius:14px;padding:18px;border:1px solid #e3dfd9}button{width:100%;min-height:52px;border-radius:12px;border:0;font:inherit;font-weight:700;margin-top:12px}.y{background:#da291c;color:#fff}.n{background:#fff;border:1px solid #c9c4bc}</style></head>
<body><header>Mikes</header><main><div class="card"><h2 style="margin-top:0">${L.title}</h2>
${o ? `<p>${detail}</p>` : `<p>${L.gone}</p>`}
${open ? `<div id="btns"><button class="y" onclick="ans(true)">${L.yes}</button><button class="n" onclick="ans(false)">${L.no}</button></div>` : o ? `<p>${o.status === "accepted" ? L.accepted : o.status === "declined" ? L.declined : L.filled}</p>` : ""}
<p id="msg" role="status"></p></div></main>
<script>async function ans(a){document.getElementById('btns').style.display='none';try{const r=await fetch('/hooks/offer/${esc(token)}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accept:a})});const j=await r.json();
document.getElementById('msg').textContent=j.result==='accepted'?${JSON.stringify(L.accepted)}:j.result==='declined'?${JSON.stringify(L.declined)}:${JSON.stringify(L.filled)}}catch(e){document.getElementById('msg').textContent=${JSON.stringify(L.err)};document.getElementById('btns').style.display=''}}</script></body></html>`;
  const brand = o ? await loadBrand(c.env.DB, o.client_id) : null;
  const branded = brand ? html.replace("<title>Mikes</title>", `<title>${esc(brand.name)}</title>`).replace("<header>Mikes</header>", `<header>${esc(brand.name)}</header>`).replaceAll("#da291c", brand.color) : html;
  return c.html(branded, 200, { "cache-control": "no-store" });
});

app.post("/hooks/offer/:token", async (c) => {
  await ensureMigrated(c.env.DB);
  const token = c.req.param("token");
  const o = /^[A-Za-z0-9_-]{20,64}$/.test(token) ? await offerByToken(c.env.DB, token) : null;
  if (!o) return c.json({ error: "invalid_link" }, 404);
  const { accept } = await c.req.json<{ accept?: boolean }>().catch(() => ({ accept: undefined }));
  if (typeof accept !== "boolean") return c.json({ error: "bad_request" }, 400);
  const result = await answerOffer(c.env, c.env.DB, o, accept);
  if (result === "accepted") emitTo(c, o.client_id, "coverage.filled", () => coverageData(c.env.DB, o.request_id));
  return c.json({ result });
});

// Calendar feed (iCalendar) for one employee, read by Google/Apple/Outlook calendars. Protected by its secret token.
app.get("/cal/:file", async (c) => {
  await ensureMigrated(c.env.DB);
  const token = c.req.param("file").replace(/\.ics$/, "");
  const who = /^[A-Za-z0-9_-]{20,64}$/.test(token) ? await c.env.DB.prepare("SELECT s.id, s.name, s.client_id FROM calendar_tokens ct JOIN staff s ON s.id = ct.staff_id WHERE ct.token = ?").bind(token).first<{ id: number; client_id: number; name: string }>() : null;
  if (!who) return c.text("not found", 404);
  const from = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 16), to = new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 16);
  const rows = await c.env.DB.prepare(
    `SELECT sh.id, sh.start_at, sh.end_at, sh.until_close, sh.notes, rs.name AS restaurant, ro.name_fr, (SELECT sex FROM staff WHERE id = sh.staff_id) AS sex
     FROM shifts sh JOIN restaurants rs ON rs.id = sh.restaurant_id JOIN roles ro ON ro.id = sh.role_id
     WHERE sh.staff_id = ? AND sh.status = 'ok' AND sh.start_at >= ? AND sh.start_at < ? AND ${shiftVisible({ id: 0, is_admin: false })} ORDER BY sh.start_at`,
  ).bind(who.id, from, to).all<{ id: number; start_at: string; end_at: string; until_close: number; notes: string | null; restaurant: string; name_fr: string; sex: string | null }>();
  const brandName = (await loadBrand(c.env.DB, who.client_id)).name;
  const stamp = (v: string) => v.replace(/[-:]/g, "") + "00";
  const fold = (v: string) => v.replace(/[\\;,]/g, (m) => "\\" + m).replace(/\n/g, "\\n");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mikes//Horaire//FR", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${fold(brandName)} - Horaire`, `X-WR-TIMEZONE:${c.env.TIMEZONE ?? "America/Toronto"}`];
  const now = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  for (const r of rows.results) {
    lines.push("BEGIN:VEVENT", `UID:shift-${r.id}@mikes`, `DTSTAMP:${now}`,
      `DTSTART;TZID=${c.env.TIMEZONE ?? "America/Toronto"}:${stamp(r.start_at)}`, `DTEND;TZID=${c.env.TIMEZONE ?? "America/Toronto"}:${stamp(r.end_at)}`,
      `SUMMARY:${fold(`${brandName} ${r.restaurant} - ${genderedRole(r.name_fr, r.sex)}`)}`, ...(r.notes ? [`DESCRIPTION:${fold(r.notes)}`] : []), "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return c.body(lines.join("\r\n") + "\r\n", 200, { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=300" });
});

// Inbound SMS from Twilio: YES / NO to an offer, or SICK to report the next shift.
app.post("/hooks/twilio", async (c) => {
  await ensureMigrated(c.env.DB);
  const form = await c.req.formData().catch(() => null);
  const params: Record<string, string> = {};
  form?.forEach((v, k) => { if (typeof v === "string") params[k] = v; });
  // Which client's Twilio account is calling? (Each client has its own; the signature is checked with that client's token.)
  let clientId = 1;
  for (const cl of (await c.env.DB.prepare("SELECT id FROM clients WHERE active = 1").all<{ id: number }>()).results) {
    const cn = await loadConnections(c.env, c.env.DB, cl.id);
    if (cn.twilio && cn.twilio.sid === params.AccountSid) { clientId = cl.id; break; }
  }
  const conn = await loadConnections(c.env, c.env.DB, clientId);
  const url = conn.appUrl ? `${conn.appUrl}/hooks/twilio` : c.req.url;
  if (!conn.twilio || !(await verifyTwilioSignature(conn.twilio.token, url, params, c.req.header("X-Twilio-Signature")))) return c.text("forbidden", 403);
  const twiml = (text?: string) => c.body(`<?xml version="1.0" encoding="UTF-8"?><Response>${text ? `<Message>${esc(text)}</Message>` : ""}</Response>`, 200, { "content-type": "text/xml" });
  const from = normalizePhone(params.From);
  const person = from ? await c.env.DB.prepare("SELECT id, name, lang, sex FROM staff WHERE phone = ? AND client_id = ?").bind(from, clientId).first<{ id: number; name: string; lang: string; sex: string | null }>() : null;
  if (!person) return twiml();
  const lang: Lang = person.lang === "en" ? "en" : "fr";
  const word = (params.Body ?? "").trim().toLowerCase();

  if (/^(oui|o|yes|y|1|ok)\b/.test(word) || /^(non|n|no|2)\b/.test(word)) {
    const accept = /^(oui|o|yes|y|1|ok)\b/.test(word);
    const offer = await c.env.DB.prepare("SELECT id, request_id, staff_id, status FROM coverage_offers WHERE staff_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1").bind(person.id).first<{ id: number; request_id: number; staff_id: number; status: string }>();
    if (!offer) return twiml(T.noOpenOffer(lang).text);
    const result = await answerOffer(c.env, c.env.DB, offer, accept);
    if (result === "accepted") emitTo(c, clientId, "coverage.filled", () => coverageData(c.env.DB, offer.request_id));
    // The winner also receives the normal confirmation message from the flow; answer the others right here.
    if (result === "declined") return twiml(lang === "fr" ? "Mikes: merci, c’est noté." : "Mikes: thanks, noted.");
    if (result === "filled" || result === "closed") return twiml(lang === "fr" ? "Mikes: le remplacement est déjà comblé. Merci!" : "Mikes: the replacement is already filled. Thanks!");
    if (result === "conflict") return twiml(lang === "fr" ? "Mikes: tu as déjà un quart à ce moment-là." : "Mikes: you already have a shift at that time.");
    return twiml();
  }
  if (/^(malade|sick|malad)/.test(word)) {
    const now = localNow(c.env.TIMEZONE);
    const soon = new Date(`${now}:00Z`); soon.setUTCHours(soon.getUTCHours() + 24);
    const shift = await c.env.DB.prepare(
      "SELECT id FROM shifts WHERE staff_id = ? AND status = 'ok' AND end_at > ? AND start_at < ? ORDER BY start_at LIMIT 1",
    ).bind(person.id, now, soon.toISOString().slice(0, 16)).first<{ id: number }>();
    if (!shift) return twiml(T.noUpcomingShift(lang).text);
    try {
      const started = await startSickCall(c.env, c.env.DB, shift.id, person.id, { reason: "sick" });
      emitTo(c, clientId, "coverage.opened", () => coverageData(c.env.DB, started.request_id));
      const row = await c.env.DB.prepare("SELECT sh.start_at, sh.end_at, sh.until_close, rs.name AS restaurant, ro.name_fr, ro.name_en FROM shifts sh JOIN restaurants rs ON rs.id = sh.restaurant_id JOIN roles ro ON ro.id = sh.role_id WHERE sh.id = ?").bind(shift.id).first<{ start_at: string; end_at: string; until_close: number; restaurant: string; name_fr: string; name_en: string }>();
      return twiml(row ? T.sickRecorded(lang, { restaurant: row.restaurant, role: genderedRole(lang === "fr" ? row.name_fr : row.name_en, person.sex), when: formatWhen(row.start_at, row.end_at, !!row.until_close, lang) }).text : undefined);
    } catch (e) {
      if (e instanceof FlowError) return twiml(lang === "fr" ? "Mikes: ce quart est déjà signalé ou terminé." : "Mikes: that shift is already reported or over.");
      throw e;
    }
  }
  return twiml(T.smsHelp(lang).text);
});


app.notFound((c) => c.json({ error: "not_found" }, 404));

export default {
  fetch: app.fetch,
  // Cloudflare cron (every 5 minutes): tell the managers to act when nobody accepted a replacement in time.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => { await ensureMigrated(env.DB); await escalateDue(env, env.DB); await sendShiftReminders(env, env.DB).catch(() => 0); await env.DB.prepare("DELETE FROM community_media WHERE post_id IS NULL AND created_at < ?").bind(Date.now() - 86_400_000).run().catch(() => {}); await flushDeliveries(env.DB); })());
  },
};
