import { Hono, type Context } from "hono";
import { ensureMigrated } from "./migrate.ts";
import { fetchAccessKeys, verifyAccessJwt } from "./access.ts";
import { findOverlaps, SHIFT_TIME_RE } from "./conflicts.ts";
import { weekBounds } from "./week.ts";
import { computeCosts, parseRate } from "./payroll.ts";
import { parseSettings, validateSettingsPatch, type Settings } from "./settings.ts";
import { normalizePhone } from "./phone.ts";
// @ts-ignore plain JS module shared with the browser
import { DEFAULT_BOUNDARIES, periodKeys, remapPeriods, validBoundaries } from "../public/coverage.js";
// @ts-ignore plain JS module shared with the browser
import { splitName, joinName, genderedRole } from "../public/names.js";
import { loadConnections, deliver, notifyStaff } from "./notify.ts";
import { publicConnectionView } from "./connections.ts";
import { verifyTwilioSignature } from "./twilio.ts";
import { T, formatWhen, type Lang } from "./templates.ts";
import { answerOffer, cancelRequest, escalateDue, fillRequest, gatherCandidates, startSickCall, FlowError } from "./sick.ts";
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
  // Local development ONLY (set in .dev.vars, never in production).
  DEV_MODE?: string;
  DEV_USER_EMAIL?: string;
  // Public address of the app (used in links sent by SMS/email) and the restaurants' time zone.
  APP_URL?: string;
  TIMEZONE?: string;
  // Optional secrets: key to read pay slip PDFs with Claude, and the key used to hash Social Insurance Numbers.
  ANTHROPIC_API_KEY?: string; SIN_KEY?: string;
  // Optional: messaging credentials as environment secrets (otherwise they are saved from the Administration screen).
  TWILIO_ACCOUNT_SID?: string; TWILIO_AUTH_TOKEN?: string; TWILIO_FROM?: string; TWILIO_API_BASE?: string;
  SMTP_HOST?: string; SMTP_PORT?: string; SMTP_SECURE?: string; SMTP_USER?: string; SMTP_PASS?: string; SMTP_FROM?: string;
};

interface Me {
  id: number;
  name: string;
  email: string;
  is_admin: boolean;
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
  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud } = c.env;
  if (!team || !aud) return { reason: "access_not_configured" };
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
  const { email, reason } = await identify(c);
  if (!email) return c.json({ error: "unauthenticated", reason }, 401);
  let row = await c.env.DB.prepare("SELECT id, name, email, is_admin, active FROM staff WHERE lower(email) = ?")
    .bind(email)
    .first<{ id: number; name: string; email: string; is_admin: number; active?: number }>();
  if (!row && c.env.ADMIN_EMAIL && email === c.env.ADMIN_EMAIL.toLowerCase()) {
    // An admin record created without an email (e.g. by an import) is claimed by the first ADMIN_EMAIL login.
    row = await c.env.DB.prepare(
      "UPDATE staff SET email = ? WHERE id = (SELECT id FROM staff WHERE is_admin = 1 AND email IS NULL ORDER BY id LIMIT 1) RETURNING id, name, email, is_admin",
    )
      .bind(email)
      .first<{ id: number; name: string; email: string; is_admin: number }>();
  }
  if (!row && c.env.ADMIN_EMAIL && email === c.env.ADMIN_EMAIL.toLowerCase()) {
    const r = await c.env.DB.prepare("INSERT INTO staff (name, first_name, email, is_admin) VALUES (?, ?, ?, 1)")
      .bind(email.split("@")[0], email.split("@")[0], email)
      .run();
    row = { id: r.meta.last_row_id as number, name: email.split("@")[0], email, is_admin: 1 };
  }
  if (!row) return c.json({ error: "unknown_user", email }, 403);
  if (row.active === 0) return c.json({ error: "inactive", email }, 403); // deactivated employees cannot sign in
  c.set("me", { ...row, is_admin: row.is_admin === 1 });
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
async function canView(db: D1Database, me: Me, restaurantId: number, departmentId: string) {
  if (await canManage(db, me, restaurantId, departmentId)) return true;
  const r = await db
    .prepare(
      `SELECT 1 FROM staff_roles sr JOIN roles ro ON ro.id = sr.role_id
       WHERE sr.staff_id = ? AND sr.restaurant_id = ? AND ro.department_id = ?`,
    )
    .bind(me.id, restaurantId, departmentId)
    .first();
  return !!r;
}

const requireAdmin = async (c: any, next: any) => {
  if (!c.get("me").is_admin) return c.json({ error: "forbidden" }, 403);
  await next();
};


// Adds open_by_dow and close_by_dow (7 "HH:MM" values each, Monday..Sunday) to restaurant rows.
async function withOpenHours<T extends { id: number; open_time: string; close_time: string }>(db: D1Database, rows: T[]) {
  const hours = await db.prepare("SELECT restaurant_id, dow, open_time, close_time FROM restaurant_open_hours").all<{ restaurant_id: number; dow: number; open_time: string; close_time: string | null }>();
  const bounds = new Map<number, string[]>();
  for (const p of (await db.prepare("SELECT restaurant_id, boundaries FROM restaurant_periods").all<{ restaurant_id: number; boundaries: string }>()).results) {
    try { const b = JSON.parse(p.boundaries); if (validBoundaries(b)) bounds.set(p.restaurant_id, b); } catch { /* default */ }
  }
  return rows.map((r) => {
    const day = (d: number) => hours.results.find((h) => h.restaurant_id === r.id && h.dow === d);
    return {
      ...r,
      period_bounds: bounds.get(r.id) ?? DEFAULT_BOUNDARIES,
      open_by_dow: Array.from({ length: 7 }, (_, d) => day(d)?.open_time ?? r.open_time),
      close_by_dow: Array.from({ length: 7 }, (_, d) => day(d)?.close_time ?? r.close_time),
    };
  });
}

async function loadSettings(db: D1Database): Promise<Settings> {
  return parseSettings((await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>()).results);
}

const intParam = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null);

// ---------- Me ----------
// Ids of all employees (no names): the browser ranks them to give everyone a distinct automatic colour.
app.get("/api/staff-order", async (c) => c.json((await c.env.DB.prepare("SELECT id FROM staff ORDER BY id").all<{ id: number }>()).results.map((r) => r.id)));

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
  return c.json({ me, managed: managed.results, roles: roles.results });
});

app.get("/api/departments", async (c) =>
  c.json((await c.env.DB.prepare("SELECT * FROM departments").all()).results),
);
app.get("/api/roles", async (c) =>
  c.json((await c.env.DB.prepare("SELECT * FROM roles").all()).results),
);

// Minutes before opening that this role should arrive (default start time of its shifts).
app.put("/api/roles/:id/pre-open", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const { minutes } = await c.req.json<{ minutes?: number }>();
  if (!id || !Number.isInteger(minutes) || (minutes as number) < 0 || (minutes as number) > 180) return c.json({ error: "invalid_minutes" }, 400);
  const r = await c.env.DB.prepare("UPDATE roles SET pre_open_minutes = ? WHERE id = ?").bind(minutes, id).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

// Deactivate / reactivate an employee (admin only; not yourself).
app.put("/api/staff/:id/active", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const { active } = await c.req.json<{ active?: boolean }>();
  if (!id || typeof active !== "boolean") return c.json({ error: "bad_request" }, 400);
  if (!active && id === c.get("me").id) return c.json({ error: "cannot_remove_self" }, 409);
  if (!active) {
    const n = await c.env.DB.prepare("SELECT count(*) AS n FROM staff WHERE is_admin = 1 AND active = 1 AND id != ?").bind(id).first<{ n: number }>();
    const isAdmin = await c.env.DB.prepare("SELECT is_admin FROM staff WHERE id = ?").bind(id).first<{ is_admin: number }>();
    if (isAdmin?.is_admin === 1 && !n?.n) return c.json({ error: "last_admin" }, 409);
  }
  const r = await c.env.DB.prepare("UPDATE staff SET active = ? WHERE id = ?").bind(active ? 1 : 0, id).run();
  if (!r.meta.changes) return c.json({ error: "not_found" }, 404);
  // Pending replacement offers to this person are no longer valid.
  if (!active) await c.env.DB.prepare("UPDATE coverage_offers SET status = 'closed' WHERE staff_id = ? AND status = 'sent'").bind(id).run().catch(() => {});
  const future = await c.env.DB.prepare("SELECT count(*) AS n FROM shifts WHERE staff_id = ? AND status = 'ok' AND start_at >= ?").bind(id, localNow(c.env.TIMEZONE)).first<{ n: number }>();
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
    const n = await c.env.DB.prepare("SELECT count(*) AS n FROM staff WHERE is_admin = 1 AND id != ?").bind(id).first<{ n: number }>();
    if (!n?.n) return c.json({ error: "last_admin" }, 409);
  }
  await c.env.DB.prepare("UPDATE staff SET is_admin = ? WHERE id = ?").bind(is_admin ? 1 : 0, id).run();
  return c.json({ ok: true, is_admin });
});

// ---------- Restaurants (admin) ----------
app.get("/api/restaurants", async (c) => {
  const me = c.get("me");
  const sql = me.is_admin
    ? "SELECT id, name, open_time, close_time FROM restaurants ORDER BY name"
    : `SELECT DISTINCT r.id, r.name, r.open_time, r.close_time FROM restaurants r WHERE r.id IN
         (SELECT restaurant_id FROM staff_roles WHERE staff_id = ?1
          UNION SELECT restaurant_id FROM managers WHERE staff_id = ?1) ORDER BY r.name`;
  const stmt = c.env.DB.prepare(sql);
  const rows = (await (me.is_admin ? stmt : stmt.bind(me.id)).all()).results as { id: number; name: string; open_time: string; close_time: string }[];
  return c.json(await withOpenHours(c.env.DB, rows));
});

app.post("/api/restaurants", requireAdmin, async (c) => {
  const { name } = await c.req.json<{ name?: string }>();
  if (!name?.trim()) return c.json({ error: "name_required" }, 400);
  try {
    const r = await c.env.DB.prepare("INSERT INTO restaurants (name) VALUES (?)").bind(name.trim()).run();
    return c.json({ id: r.meta.last_row_id, name: name.trim() }, 201);
  } catch {
    return c.json({ error: "name_taken" }, 409);
  }
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Staffing-target period boundaries of a restaurant (see public/coverage.js).
async function boundariesOf(db: D1Database, restaurantId: number): Promise<string[]> {
  const r = await db.prepare("SELECT boundaries FROM restaurant_periods WHERE restaurant_id = ?").bind(restaurantId).first<{ boundaries: string }>();
  try { const b = r ? JSON.parse(r.boundaries) : null; return validBoundaries(b) ? b : DEFAULT_BOUNDARIES; } catch { return DEFAULT_BOUNDARIES; }
}

// Opening and closing time per weekday (open_times / close_times = 7 values each, Monday..Sunday).
// Legacy fields open_time / close_time set the same value for every day. Until-close shifts follow the closing time of their day.
app.put("/api/restaurants/:id/hours", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const b = await c.req.json<{ open_times?: string[]; close_times?: string[]; open_time?: string; close_time?: string }>();
  if (!id) return c.json({ error: "bad_id" }, 400);
  const current = await c.env.DB.prepare("SELECT id, open_time, close_time FROM restaurants WHERE id = ?").bind(id).first<{ id: number; open_time: string; close_time: string }>();
  if (!current) return c.json({ error: "not_found" }, 404);
  const existing = (await withOpenHours(c.env.DB, [current]))[0];
  const opens = b.open_times ?? (b.open_time ? Array(7).fill(b.open_time) : existing.open_by_dow);
  const closes = b.close_times ?? (b.close_time ? Array(7).fill(b.close_time) : existing.close_by_dow);
  const valid = (a: unknown): a is string[] => Array.isArray(a) && a.length === 7 && a.every((x) => typeof x === "string" && TIME_RE.test(x));
  if (!valid(opens) || !valid(closes) || opens.some((o, d) => o >= closes[d])) return c.json({ error: "invalid_times" }, 400);
  const db = c.env.DB;
  await db.batch([
    db.prepare("UPDATE restaurants SET open_time = ?, close_time = ? WHERE id = ?").bind(opens[0], closes[0], id),
    db.prepare("DELETE FROM restaurant_open_hours WHERE restaurant_id = ?").bind(id),
    ...opens.map((o, d) => db.prepare("INSERT INTO restaurant_open_hours (restaurant_id, dow, open_time, close_time) VALUES (?, ?, ?, ?)").bind(id, d, o, closes[d])),
    // 'F' shifts end at the closing time of their weekday (only when the shift starts before closing).
    ...closes.map((cl, d) =>
      db.prepare(
        `UPDATE shifts SET end_at = substr(start_at, 1, 10) || 'T' || ?1
         WHERE restaurant_id = ?2 AND until_close = 1 AND substr(start_at, 12, 5) < ?1
           AND ((CAST(strftime('%w', substr(start_at, 1, 10)) AS INTEGER) + 6) % 7) = ?3`,
      ).bind(cl, id, d)),
  ]);
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
  const validSlots: string[] = periodKeys(await boundariesOf(c.env.DB, b.restaurant_id));
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

// Change the staffing-target periods of one restaurant (admin). Existing targets are carried over to the new periods.
app.put("/api/restaurants/:id/periods", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const { boundaries } = await c.req.json<{ boundaries?: string[] }>();
  if (!id) return c.json({ error: "bad_id" }, 400);
  if (!validBoundaries(boundaries)) return c.json({ error: "invalid_periods" }, 400);
  if (!(await c.env.DB.prepare("SELECT 1 FROM restaurants WHERE id = ?").bind(id).first())) return c.json({ error: "not_found" }, 404);
  const old = await boundariesOf(c.env.DB, id);
  const rows = (await c.env.DB.prepare("SELECT department_id, set_id, dow, slot, count FROM staffing_targets WHERE restaurant_id = ?").bind(id).all<{ department_id: string; set_id: number; dow: number; slot: string; count: number }>()).results;
  const groups = new Map<string, { department_id: string; set_id: number; dow: number; values: Record<string, number> }>();
  for (const r of rows) {
    const k = `${r.department_id}|${r.set_id}|${r.dow}`;
    const g = groups.get(k) ?? { department_id: r.department_id, set_id: r.set_id, dow: r.dow, values: {} };
    g.values[r.slot] = r.count; groups.set(k, g);
  }
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare("INSERT OR REPLACE INTO restaurant_periods (restaurant_id, boundaries) VALUES (?, ?)").bind(id, JSON.stringify(boundaries)),
    c.env.DB.prepare("DELETE FROM staffing_targets WHERE restaurant_id = ?").bind(id),
  ];
  for (const g of groups.values()) for (const [slot, n] of Object.entries(remapPeriods(old, boundaries, g.values) as Record<string, number>))
    stmts.push(c.env.DB.prepare("INSERT INTO staffing_targets (restaurant_id, department_id, set_id, dow, slot, count) VALUES (?, ?, ?, ?, ?, ?)").bind(id, g.department_id, g.set_id, g.dow, slot, n));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, boundaries });
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
  const r = await db
    .prepare("SELECT 1 FROM staff_roles WHERE staff_id = ?1 AND restaurant_id = ?2 UNION SELECT 1 FROM managers WHERE staff_id = ?1 AND restaurant_id = ?2")
    .bind(me.id, restaurantId)
    .first();
  return !!r;
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

// ---------- Staff (admin) ----------
app.get("/api/staff", async (c) => {
  const me = c.get("me");
  const db = c.env.DB;
  // Admins see everyone; managers see staff holding a role at a restaurant they manage.
  const sql = me.is_admin
    ? "SELECT id, name, email, phone FROM staff ORDER BY name"
    : `SELECT DISTINCT s.id, s.name, s.email, s.phone FROM staff s
       JOIN staff_roles sr ON sr.staff_id = s.id
       WHERE sr.restaurant_id IN (SELECT restaurant_id FROM managers WHERE staff_id = ?) ORDER BY s.name`;
  const stmt = db.prepare(sql);
  return c.json(sortByName(((await (me.is_admin ? stmt : stmt.bind(me.id)).all()).results) as { name: string }[]));
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
    const r = await c.env.DB.prepare("INSERT INTO staff (name, first_name, last_name, email, phone, is_admin, sex) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(nm.name, nm.first, nm.last, b.email?.trim().toLowerCase() || null, b.phone ?? null, b.is_admin ? 1 : 0, b.sex === "M" || b.sex === "F" ? b.sex : null)
      .run();
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
app.get("/api/settings", requireAdmin, async (c) => c.json(await loadSettings(c.env.DB)));

app.put("/api/settings", requireAdmin, async (c) => {
  const rows = validateSettingsPatch(await c.req.json().catch(() => null));
  if (!rows) return c.json({ error: "invalid_setting" }, 400);
  await c.env.DB.batch(Object.entries(rows).map(([k, v]) => c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(k, v)));
  return c.json(await loadSettings(c.env.DB));
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
async function defaultRates(db: D1Database) {
  const g = await db.prepare("SELECT value FROM settings WHERE key = 'default_hourly_cents'").first<{ value: string }>();
  const roles = (await db.prepare("SELECT id, default_hourly_cents FROM roles WHERE default_hourly_cents IS NOT NULL").all<{ id: number; default_hourly_cents: number }>()).results;
  return { general_cents: g ? Number(g.value) : null, roles: Object.fromEntries(roles.map((r) => [r.id, r.default_hourly_cents])) };
}
app.get("/api/admin/default-rates", requireAdmin, async (c) => c.json(await defaultRates(c.env.DB)));
app.put("/api/admin/default-rates", requireAdmin, async (c) => {
  const b = await c.req.json<{ general?: string | number | null; roles?: Record<string, string | number | null> }>();
  const stmts: D1PreparedStatement[] = [];
  if (b.general !== undefined) {
    const cents = parseRate(b.general);
    if (b.general !== null && b.general !== "" && cents === null) return c.json({ error: "invalid_rate" }, 400);
    stmts.push(cents === null ? c.env.DB.prepare("DELETE FROM settings WHERE key = 'default_hourly_cents'") : c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('default_hourly_cents', ?)").bind(String(cents)));
  }
  for (const [rid, v] of Object.entries(b.roles ?? {})) {
    const roleId = intParam(rid), cents = parseRate(v);
    if (!roleId || (v !== null && v !== "" && cents === null)) return c.json({ error: "invalid_rate" }, 400);
    stmts.push(c.env.DB.prepare("UPDATE roles SET default_hourly_cents = ? WHERE id = ?").bind(cents, roleId));
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json(await defaultRates(c.env.DB));
});

// GET /api/admin/payroll?restaurant=1&department=kitchen&week=2026-10-26
// -> labour cost of that department (per day and per clock hour) and of the whole restaurant.
app.get("/api/admin/payroll", requireAdmin, async (c) => {
  const restaurantId = intParam(c.req.query("restaurant"));
  const department = c.req.query("department");
  const weekStart = c.req.query("week") ?? "";
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
    `SELECT sh.id, sh.start_at, sh.end_at, ro.department_id, COALESCE(rw.hourly_cents, w.hourly_cents, ro.default_hourly_cents, (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'default_hourly_cents')) AS rate_cents
     FROM shifts sh JOIN roles ro ON ro.id = sh.role_id LEFT JOIN staff_wages w ON w.staff_id = sh.staff_id
          LEFT JOIN staff_role_wages rw ON rw.staff_id = sh.staff_id AND rw.role_id = sh.role_id
     WHERE sh.restaurant_id = ? AND sh.status = 'ok' AND sh.start_at >= ? AND sh.start_at < ?`,
  )
    .bind(restaurantId, from, bounds.end)
    .all<{ id: number; start_at: string; end_at: string; department_id: string; rate_cents: number | null }>();
  // A shift covering several roles (cook + dishwasher) is paid at the highest of their rates; its cost stays in the main role's department.
  const extra = await c.env.DB.prepare(
    `SELECT x.shift_id, COALESCE(rw.hourly_cents, w.hourly_cents, ro.default_hourly_cents, (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'default_hourly_cents')) AS rate_cents
     FROM shift_roles x JOIN shifts sh ON sh.id = x.shift_id JOIN roles ro ON ro.id = x.role_id
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
async function anthropicKey(env: Env): Promise<string | null> {
  if (env.ANTHROPIC_API_KEY?.trim()) return env.ANTHROPIC_API_KEY.trim();
  return (await env.DB.prepare("SELECT value FROM settings WHERE key = 'conn_anthropic_key'").first<{ value: string }>())?.value ?? null;
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

app.get("/api/admin/payslip-setup", requireAdmin, async (c) => c.json({ ai_configured: !!(await anthropicKey(c.env)), max_bytes: MAX_PDF_BYTES }));
app.put("/api/admin/payslip-setup", requireAdmin, async (c) => {
  const { anthropic_key } = await c.req.json<{ anthropic_key?: string | null }>();
  if (!anthropic_key) await c.env.DB.prepare("DELETE FROM settings WHERE key = 'conn_anthropic_key'").run();
  else if (!/^sk-ant-[\w-]{20,}$/.test(anthropic_key.trim())) return c.json({ error: "invalid_key" }, 400);
  else await c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('conn_anthropic_key', ?)").bind(anthropic_key.trim()).run();
  return c.json({ ai_configured: !!(await anthropicKey(c.env)) });
});

// One PDF per request (the browser sends the files of a batch one after the other). The AI reads it and proposes an employee.
app.post("/api/admin/payslips", requireAdmin, async (c) => {
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > MAX_PDF_BYTES) return c.json({ error: "file_too_large", max_bytes: MAX_PDF_BYTES }, 413);
  if (!isPdf(bytes)) return c.json({ error: "not_a_pdf" }, 400);
  const filename = decodeURIComponent(c.req.header("X-Filename") ?? "payslip.pdf").replace(/[^\w .()-]/g, "_").slice(0, 120);
  const b64 = bytesToBase64(bytes);
  const key = await anthropicKey(c.env);
  const ex = key ? await extractPayslip(key, b64).catch(() => null) : null;
  const people = (await c.env.DB.prepare("SELECT s.id, s.name, ss.sin_hash FROM staff s LEFT JOIN staff_sin ss ON ss.staff_id = s.id").all<{ id: number; name: string; sin_hash: string | null }>()).results;
  const m = ex ? await chooseMatch(ex, people, await sinKey(c.env)) : { staff_id: null, kind: "none" as const };
  const sinDigits = ex ? normalizeSin(ex.sin) : null;
  const r = await c.env.DB.prepare(
    `INSERT INTO payslips (filename, content_b64, size, status, period_label, pay_date, extracted_name, extracted_last3, suggested_staff_id, match_kind, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, 'review', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(filename, b64, bytes.length, ex?.period ?? null, ex?.pay_date ?? null, ex?.employee_name ?? null, sinDigits ? sinDigits.slice(-3) : null, m.staff_id, m.kind, c.get("me").id, Date.now()).run();
  return c.json({ id: r.meta.last_row_id, read_by_ai: !!ex, match: m.kind }, 201);
});

app.get("/api/admin/payslips", requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.filename, p.size, p.period_label, p.pay_date, p.extracted_name, p.extracted_last3, p.match_kind, p.suggested_staff_id, sg.name AS suggested_name,
            (SELECT last3 FROM staff_sin WHERE staff_id = p.suggested_staff_id) AS suggested_last3, p.uploaded_at
     FROM payslips p LEFT JOIN staff sg ON sg.id = p.suggested_staff_id WHERE p.status = 'review' ORDER BY p.id`,
  ).all();
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
     UNION SELECT id FROM staff WHERE is_admin = 1 AND active = 1`,
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
    const conn = await loadConnections(c.env, c.env.DB);
    if (forOther) await notifyStaff(c.env.DB, conn, target, (l) => T.timeOffDecision(l, { approved: true, from: start, to: end, note }), "time_off_decision");
    else {
      const ids = (await approversOf(c.env.DB, me.id)).filter((id) => id !== me.id);
      if (ids.length) {
        const people = (await c.env.DB.prepare(`SELECT id, name, phone, email, lang, notify_channel FROM staff WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<any>()).results;
        for (const p of people) await notifyStaff(c.env.DB, conn, p, (l) => T.timeOffRequest(l, { name: me.name, from: start, to: end, note }), "time_off_request");
      }
    }
  } catch { /* messaging problems never block the request */ }
  return c.json({ id: r.meta.last_row_id, status: forOther ? "approved" : "requested" }, 201);
});

// People a manager/admin may enter time off for.
app.get("/api/time-off/people", async (c) => {
  const me = c.get("me");
  const rows = sortByName((await c.env.DB.prepare("SELECT id, name FROM staff WHERE active = 1").all<{ id: number; name: string }>()).results);
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
  return c.json({ ok: true });
});

app.get("/api/time-off/review", async (c) => {
  const me = c.get("me");
  const rows = (await c.env.DB.prepare(
    `SELECT t.id, t.staff_id, s.name AS staff_name, t.start_date, t.end_date, t.start_time, t.end_time, t.note, t.status, t.decision_note
     FROM time_off_requests t JOIN staff s ON s.id = t.staff_id
     WHERE t.status != 'cancelled' AND (t.status = 'requested' OR t.end_date >= date('now','-14 day')) AND t.end_date >= date('now','-14 day')
     ORDER BY (t.status = 'requested') DESC, t.start_date LIMIT 200`,
  ).all<{ staff_id: number }>()).results;
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
  try {
    const person = await c.env.DB.prepare("SELECT id, name, phone, email, lang, notify_channel FROM staff WHERE id = ?").bind(row.staff_id).first<any>();
    if (person) await notifyStaff(c.env.DB, await loadConnections(c.env, c.env.DB), person, (l) => T.timeOffDecision(l, { approved: approve, from: row.start_date, to: row.end_date, note: dn }), "time_off_decision");
  } catch { /* ignore */ }
  // Shifts already planned on those days: tell the manager so they can be moved.
  const clash = await c.env.DB.prepare("SELECT count(*) AS n FROM shifts WHERE staff_id = ? AND status = 'ok' AND substr(start_at,1,10) >= ? AND substr(start_at,1,10) <= ?").bind(row.staff_id, row.start_date, row.end_date).first<{ n: number }>();
  return c.json({ ok: true, shifts_on_those_days: approve ? clash?.n ?? 0 : 0 });
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
     WHERE (?1 IS NULL OR i.staff_id = ?1) ORDER BY i.incident_date DESC, i.id DESC LIMIT 500`,
  ).bind(staffId ?? null).all();
  const counts = await c.env.DB.prepare(
    `SELECT i.staff_id, s.name AS staff_name,
            sum(i.kind = 'no_call_no_show') AS no_shows, sum(i.kind = 'late_arrival') AS lates, sum(i.kind = 'early_departure') AS early, count(*) AS total
     FROM incidents i JOIN staff s ON s.id = i.staff_id WHERE i.incident_date >= date('now', '-365 day') GROUP BY i.staff_id ORDER BY total DESC, s.name`,
  ).all();
  return c.json({ incidents: rows.results, last_12_months: counts.results });
});

app.post("/api/admin/incidents", requireAdmin, async (c) => {
  const b = await c.req.json<{ staff_id?: number; shift_id?: number | null; incident_date?: string; kind?: string; minutes?: number | null; notes?: string }>();
  if (!b.staff_id || !INCIDENT_KINDS.includes(b.kind ?? "")) return c.json({ error: "bad_request" }, 400);
  if (!DATE_RE3.test(b.incident_date ?? "")) return c.json({ error: "invalid_dates" }, 400);
  const needsMinutes = b.kind !== "no_call_no_show";
  const minutes = b.minutes ?? null;
  if (minutes !== null && !(Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440)) return c.json({ error: "invalid_minutes" }, 400);
  if (!(await c.env.DB.prepare("SELECT 1 FROM staff WHERE id = ?").bind(b.staff_id).first())) return c.json({ error: "not_found" }, 404);
  let restaurantId: number | null = null;
  if (b.shift_id) {
    const sh = await c.env.DB.prepare("SELECT restaurant_id, staff_id FROM shifts WHERE id = ?").bind(b.shift_id).first<{ restaurant_id: number; staff_id: number }>();
    if (!sh) return c.json({ error: "shift_not_found" }, 404);
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
app.get("/api/admin/staff/:id/shifts", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const date = c.req.query("date") ?? "";
  if (!id || !DATE_RE3.test(date)) return c.json({ error: "bad_request" }, 400);
  const r = await c.env.DB.prepare(
    `SELECT sh.id, sh.start_at, sh.end_at, sh.until_close, rs.name AS restaurant, ro.name_fr, ro.name_en FROM shifts sh JOIN restaurants rs ON rs.id = sh.restaurant_id JOIN roles ro ON ro.id = sh.role_id
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
    return c.json(await startSickCall(c.env, c.env.DB, id, me.id), 201);
  } catch (e) { return flowError(c, e); }
});

// Replacement requests the caller may follow: open ones plus the last 7 days.
app.get("/api/coverage", async (c) => {
  const me = c.get("me");
  const since = Date.now() - 7 * 86_400_000;
  const rows = await c.env.DB.prepare(
    `SELECT cr.id, cr.shift_id, cr.status, cr.restaurant_id, rs.name AS restaurant, cr.start_at, cr.end_at, cr.created_at, cr.escalated_at, cr.filled_at,
            ro.department_id, ro.name_fr, ro.name_en, sh.until_close, sick.name AS sick_name, sick.sex AS sex, fb.name AS filled_by_name,
            (SELECT count(*) FROM coverage_offers WHERE request_id = cr.id) AS offers,
            (SELECT count(*) FROM coverage_offers WHERE request_id = cr.id AND status = 'declined') AS declined,
            (SELECT count(*) FROM coverage_offers WHERE request_id = cr.id AND status = 'sent') AS waiting
     FROM coverage_requests cr JOIN restaurants rs ON rs.id = cr.restaurant_id JOIN roles ro ON ro.id = cr.role_id
          JOIN shifts sh ON sh.id = cr.shift_id JOIN staff sick ON sick.id = cr.sick_staff_id LEFT JOIN staff fb ON fb.id = cr.filled_by
     WHERE (cr.status = 'open' OR cr.created_at >= ?)
       AND (?2 = 1 OR EXISTS (SELECT 1 FROM managers m WHERE m.staff_id = ?3 AND m.restaurant_id = cr.restaurant_id AND m.department_id = ro.department_id))
     ORDER BY (cr.status = 'open') DESC, cr.created_at DESC LIMIT 100`,
  ).bind(since, me.is_admin ? 1 : 0, me.id).all();
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
  const settings = await loadSettingsFrom(c.env.DB);
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
    const out = await fillRequest(c.env, c.env.DB, await loadConnections(c.env, c.env.DB), id, staff_id, "manager");
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
app.get("/api/connections", requireAdmin, async (c) => c.json(publicConnectionView(await loadConnections(c.env, c.env.DB))));

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
  await c.env.DB.batch(writes.map(([k, v]) => (v === null ? c.env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(k) : c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(k, v))));
  return c.json(publicConnectionView(await loadConnections(c.env, c.env.DB)));
});

app.post("/api/connections/test", requireAdmin, async (c) => {
  const { channel, to } = await c.req.json<{ channel?: string; to?: string }>();
  const conn = await loadConnections(c.env, c.env.DB);
  const lang: Lang = c.get("me") && (await c.env.DB.prepare("SELECT lang FROM staff WHERE id = ?").bind(c.get("me").id).first<{ lang: string }>())?.lang === "en" ? "en" : "fr";
  if (channel === "sms") {
    const phone = normalizePhone(to);
    if (!phone) return c.json({ error: "invalid_phone" }, 400);
    return c.json(await deliver(c.env.DB, conn, "sms", phone, T.test(lang), "test", null));
  }
  if (channel === "email" && to && to.includes("@")) return c.json(await deliver(c.env.DB, conn, "email", to.trim(), T.test(lang), "test", null));
  return c.json({ error: "invalid_request" }, 400);
});

app.get("/api/admin/notifications", requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT n.id, n.created_at, n.channel, n.to_addr, n.subject, n.kind, n.status, n.error, s.name AS staff_name FROM notifications n LEFT JOIN staff s ON s.id = n.staff_id ORDER BY n.id DESC LIMIT 60",
  ).all();
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
    `SELECT sh.id, sh.staff_id, s.name AS staff_name, s.first_name, s.last_name, s.sex, s.color AS staff_color, (SELECT updated_at FROM staff_photos WHERE staff_id = s.id) AS photo_v, sh.role_id, ro.department_id, ro.name_fr, ro.name_en,
            sh.start_at, sh.end_at, sh.until_close, sh.notes, sh.status, sh.replaced_staff_id,
            (SELECT name FROM staff WHERE id = sh.replaced_staff_id) AS replaced_name
     FROM shifts sh JOIN staff s ON s.id = sh.staff_id JOIN roles ro ON ro.id = sh.role_id
     WHERE sh.restaurant_id = ? AND (ro.department_id = ? OR EXISTS (SELECT 1 FROM shift_roles x JOIN roles r2 ON r2.id = x.role_id WHERE x.shift_id = sh.id AND r2.department_id = ?))
       AND sh.start_at >= ? AND sh.start_at < ?
     ORDER BY sh.start_at, s.name`,
  )
    .bind(restaurantId, department, department, bounds.start, bounds.end)
    .all<any>();
  // Extra roles of multi-role shifts (cook + dishwasher…)
  const extraRoles = new Map<number, { id: number; name_fr: string; name_en: string; department_id: string }[]>();
  if (shifts.results.length) {
    const sids = shifts.results.map((x: any) => x.id);
    for (const r of (await c.env.DB.prepare(`SELECT x.shift_id, ro.id, ro.name_fr, ro.name_en, ro.department_id FROM shift_roles x JOIN roles ro ON ro.id = x.role_id WHERE x.shift_id IN (${sids.map(() => "?").join(",")})`).bind(...sids).all<any>()).results) extraRoles.set(r.shift_id, [...(extraRoles.get(r.shift_id) ?? []), { id: r.id, name_fr: r.name_fr, name_en: r.name_en, department_id: r.department_id }]);
    for (const sh of shifts.results as any[]) sh.extra_roles = extraRoles.get(sh.id) ?? [];
  }
  const editable = await canManage(c.env.DB, me, restaurantId, department);
  const settings = await loadSettings(c.env.DB);

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
       FROM shifts WHERE status = 'ok' AND staff_id IN (${marks}) AND start_at >= ? AND start_at < ? GROUP BY staff_id`,
    ).bind(restaurantId, ...visible, bounds.start, bounds.end).all<{ staff_id: number; h_all: number; h_here: number }>();
    for (const r of h.results) hours[r.staff_id] = { here: Math.round(r.h_here * 100) / 100, all: Math.round(r.h_all * 100) / 100 };
    if (editable) {
      elsewhere = (await c.env.DB.prepare(
        `SELECT sh.staff_id, sh.restaurant_id, rs.name AS restaurant, ro.department_id, sh.start_at, sh.end_at
         FROM shifts sh JOIN restaurants rs ON rs.id = sh.restaurant_id JOIN roles ro ON ro.id = sh.role_id
         WHERE sh.status = 'ok' AND sh.staff_id IN (${marks}) AND sh.start_at >= ? AND sh.start_at < ?
           AND NOT (sh.restaurant_id = ? AND (ro.department_id = ? OR EXISTS (SELECT 1 FROM shift_roles x JOIN roles r2 ON r2.id = x.role_id WHERE x.shift_id = sh.id AND r2.department_id = ?)))
         ORDER BY sh.start_at`,
      ).bind(...visible, bounds.start, bounds.end, restaurantId, department, department).all()).results;
    }
  }
  // Time off overlapping this week: everyone's for managers/admin, only the caller's own for the rest.
  const weekEndDay = new Date(`${bounds.start.slice(0, 10)}T00:00:00Z`); weekEndDay.setUTCDate(weekEndDay.getUTCDate() + 6);
  const offIds = [...ids].filter((id) => editable || id === me.id);
  const time_off = offIds.length ? (await c.env.DB.prepare(
    `SELECT t.id, t.staff_id, s.first_name, s.last_name, s.name AS staff_name, t.start_date, t.end_date, t.start_time, t.end_time, t.note, t.status FROM time_off_requests t JOIN staff s ON s.id = t.staff_id WHERE t.status IN ('requested','approved') AND t.staff_id IN (${offIds.map(() => "?").join(",")}) AND t.start_date <= ? AND t.end_date >= ? ORDER BY t.start_date`,
  ).bind(...offIds, weekEndDay.toISOString().slice(0, 10), bounds.start.slice(0, 10)).all()).results : [];
  const days_off: Record<number, number[]> = {};
  if (visible.length) for (const r of (await c.env.DB.prepare(`SELECT staff_id, dow FROM staff_availability WHERE kind = 'day_off' AND staff_id IN (${visible.map(() => "?").join(",")})`).bind(...visible).all<{ staff_id: number; dow: number }>()).results) (days_off[r.staff_id] ??= []).push(r.dow);
  const personal: Record<number, number> = {};
  if (visible.length) for (const r of (await c.env.DB.prepare(`SELECT staff_id, max_weekly_hours FROM staff_limits WHERE staff_id IN (${visible.map(() => "?").join(",")})`).bind(...visible).all<{ staff_id: number; max_weekly_hours: number }>()).results) personal[r.staff_id] = r.max_weekly_hours;
  return c.json({ week: c.req.query("week"), editable, shifts: shifts.results, hours, elsewhere, time_off, days_off, limits: { overtime_hours: settings.overtime_hours, by_staff: personal } });
});

// The caller's own shifts across every restaurant and department.
app.get("/api/my-shifts", async (c) => {
  const bounds = weekBounds(c.req.query("week") ?? "");
  if (!bounds) return c.json({ error: "week_must_be_a_monday" }, 400);
  const r = await c.env.DB.prepare(
    `SELECT sh.id, sh.restaurant_id, rs.name AS restaurant, ro.department_id, ro.name_fr, ro.name_en, (SELECT sex FROM staff WHERE id = sh.staff_id) AS sex,
            sh.start_at, sh.end_at, sh.until_close, sh.notes, sh.status
     FROM shifts sh JOIN restaurants rs ON rs.id = sh.restaurant_id JOIN roles ro ON ro.id = sh.role_id
     WHERE sh.staff_id = ? AND sh.start_at >= ? AND sh.start_at < ? ORDER BY sh.start_at`,
  )
    .bind(c.get("me").id, bounds.start, bounds.end)
    .all();
  const rows = r.results as { start_at: string; end_at: string; status: string }[];
  const minutes = (a: string, b: string) => (Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`)) / 60000;
  const total_hours = Math.round((rows.filter((x) => x.status === "ok").reduce((n, x) => n + minutes(x.start_at, x.end_at), 0) / 60) * 100) / 100;
  const mine = await c.env.DB.prepare("SELECT max_weekly_hours FROM staff_limits WHERE staff_id = ?").bind(c.get("me").id).first<{ max_weekly_hours: number }>();
  const general = (await loadSettings(c.env.DB)).overtime_hours;
  return c.json({ week: c.req.query("week"), shifts: r.results, total_hours, limits: { overtime_hours: mine ? Math.min(general, mine.max_weekly_hours) : general, personal_max: mine?.max_weekly_hours ?? null } });
});

// SQL sorts "Édouard" after "Zack" (byte order). Names are sorted here instead, accents ignored, French rules.
const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });
const sortByName = <T extends { name: string }>(rows: T[]): T[] => [...rows].sort((a, b) => collator.compare(a.name, b.name));

// ---------- Roster & admin overview ----------
// Staff who can be scheduled on a given restaurant+department (managers/admin only).
app.get("/api/roster", async (c) => {
  const restaurantId = intParam(c.req.query("restaurant"));
  const department = c.req.query("department");
  if (!restaurantId || !department) return c.json({ error: "restaurant_and_department_required" }, 400);
  if (!(await canManage(c.env.DB, c.get("me"), restaurantId, department))) return c.json({ error: "forbidden" }, 403);
  const rows = await c.env.DB.prepare(
    `SELECT s.id AS staff_id, s.name, s.first_name, s.last_name, s.sex, s.color, (SELECT updated_at FROM staff_photos WHERE staff_id = s.id) AS photo_v, sr.role_id FROM staff_roles sr
     JOIN staff s ON s.id = sr.staff_id JOIN roles ro ON ro.id = sr.role_id
     WHERE sr.restaurant_id = ? AND ro.department_id = ? AND s.active = 1 ORDER BY s.name`,
  )
    .bind(restaurantId, department)
    .all<{ staff_id: number; name: string; first_name: string; last_name: string; sex: string | null; color: string | null; photo_v: number | null; role_id: number }>();
  const byStaff = new Map<number, { staff_id: number; name: string; first_name: string; last_name: string; sex: string | null; color: string | null; photo_v: number | null; role_ids: number[] }>();
  for (const r of rows.results) {
    const e = byStaff.get(r.staff_id) ?? { staff_id: r.staff_id, name: r.name, first_name: r.first_name, last_name: r.last_name, sex: r.sex, color: r.color, photo_v: r.photo_v, role_ids: [] };
    e.role_ids.push(r.role_id);
    byStaff.set(r.staff_id, e);
  }
  // All roles each person holds at this restaurant (any department): a shift can cover roles outside the schedule being edited.
  const allRoles = (await c.env.DB.prepare("SELECT staff_id, role_id FROM staff_roles WHERE restaurant_id = ?").bind(restaurantId).all<{ staff_id: number; role_id: number }>()).results;
  return c.json(sortByName([...byStaff.values()].map((e) => ({ ...e, all_role_ids: allRoles.filter((r) => r.staff_id === e.staff_id).map((r) => r.role_id) }))));
});

app.get("/api/admin/overview", requireAdmin, async (c) => {
  const db = c.env.DB;
  const [staff, roles, managers, restaurants, roleWages] = await Promise.all([
    db.prepare("SELECT id, name, first_name, last_name, sex, email, phone, is_admin, active, lang, notify_channel, color, (SELECT updated_at FROM staff_photos WHERE staff_id = staff.id) AS photo_v, (SELECT hourly_cents FROM staff_wages WHERE staff_id = staff.id) AS hourly_cents, (SELECT last3 FROM staff_sin WHERE staff_id = staff.id) AS sin_last3, (SELECT max_weekly_hours FROM staff_limits WHERE staff_id = staff.id) AS max_weekly_hours FROM staff ORDER BY name").all(),
    db.prepare("SELECT staff_id, restaurant_id, role_id FROM staff_roles").all<{ staff_id: number; restaurant_id: number; role_id: number }>(),
    db.prepare("SELECT staff_id, restaurant_id, department_id FROM managers").all<{ staff_id: number; restaurant_id: number; department_id: string }>(),
    db.prepare("SELECT id, name, open_time, close_time FROM restaurants ORDER BY name").all(),
    db.prepare("SELECT staff_id, role_id, hourly_cents FROM staff_role_wages").all<{ staff_id: number; role_id: number; hourly_cents: number }>(),
  ]);
  return c.json({
    restaurants: await withOpenHours(db, restaurants.results as { id: number; name: string; open_time: string; close_time: string }[]),
    default_rates: await defaultRates(db),
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
  const b = await c.req.json<{ first_name?: string; last_name?: string; name?: string; email?: string; phone?: string; lang?: string; notify_channel?: string; color?: string | null; sex?: string | null }>();
  const nm = namesFrom(b);
  if (!nm) return c.json({ error: "name_required" }, 400);
  if (b.color != null && !/^#[0-9a-fA-F]{6}$/.test(b.color)) return c.json({ error: "invalid_color" }, 400);
  const lang = b.lang === "en" ? "en" : "fr";
  const channel = b.notify_channel === "email" ? "email" : "sms";
  const phone = b.phone?.trim() ? normalizePhone(b.phone) : null;
  if (b.phone?.trim() && !phone) return c.json({ error: "invalid_phone" }, 400);
  try {
    await c.env.DB.prepare("UPDATE staff SET name=?, first_name=?, last_name=?, email=?, phone=?, lang=?, notify_channel=?, color=?, sex=? WHERE id=?")
      .bind(nm.name, nm.first, nm.last, b.email?.trim().toLowerCase() || null, phone, lang, channel, b.color?.toLowerCase() ?? null, b.sex === "M" || b.sex === "F" ? b.sex : null, id)
      .run();
  } catch {
    return c.json({ error: "email_taken" }, 409);
  }
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
    db.prepare("DELETE FROM shift_roles WHERE shift_id = ?").bind(shiftId),
    ...extras.map((rid) => db.prepare("INSERT INTO shift_roles (shift_id, role_id) VALUES (?, ?)").bind(shiftId, rid)),
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
  await c.env.DB.prepare("DELETE FROM shifts WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ---------- Public routes (no Access login): reply links and the Twilio webhook ----------
// These must be reachable without logging in, so the hostname needs an Access "Bypass" rule for /r/* and /hooks/*.
// The reply link is protected by its long random token; the webhook by Twilio's request signature.
const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

interface OfferView { id: number; request_id: number; staff_id: number; status: string; req_status: string; lang: string; restaurant: string; name_fr: string; name_en: string; start_at: string; end_at: string; until_close: number }
const offerByToken = (db: D1Database, token: string) => db.prepare(
  `SELECT o.id, o.request_id, o.staff_id, o.status, cr.status AS req_status, s.lang, rs.name AS restaurant, ro.name_fr, ro.name_en, cr.start_at, cr.end_at, sh.until_close
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
  const detail = o ? `${lang === "fr" ? o.name_fr : o.name_en} — ${o.restaurant}<br><b>${esc(formatWhen(o.start_at, o.end_at, !!o.until_close, lang))}</b>` : "";
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Mikes</title>
<style>body{font:18px/1.4 system-ui,sans-serif;margin:0;background:#f6f4f1;color:#1f1f23}header{background:#da291c;color:#fff;padding:14px 18px;font-weight:800;font-style:italic;font-size:1.5rem}main{max-width:480px;margin:0 auto;padding:22px 18px}
.card{background:#fff;border-radius:14px;padding:18px;border:1px solid #e3dfd9}button{width:100%;min-height:52px;border-radius:12px;border:0;font:inherit;font-weight:700;margin-top:12px}.y{background:#da291c;color:#fff}.n{background:#fff;border:1px solid #c9c4bc}</style></head>
<body><header>Mikes</header><main><div class="card"><h2 style="margin-top:0">${L.title}</h2>
${o ? `<p>${detail}</p>` : `<p>${L.gone}</p>`}
${open ? `<div id="btns"><button class="y" onclick="ans(true)">${L.yes}</button><button class="n" onclick="ans(false)">${L.no}</button></div>` : o ? `<p>${o.status === "accepted" ? L.accepted : o.status === "declined" ? L.declined : L.filled}</p>` : ""}
<p id="msg" role="status"></p></div></main>
<script>async function ans(a){document.getElementById('btns').style.display='none';try{const r=await fetch('/hooks/offer/${esc(token)}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accept:a})});const j=await r.json();
document.getElementById('msg').textContent=j.result==='accepted'?${JSON.stringify(L.accepted)}:j.result==='declined'?${JSON.stringify(L.declined)}:${JSON.stringify(L.filled)}}catch(e){document.getElementById('msg').textContent=${JSON.stringify(L.err)};document.getElementById('btns').style.display=''}}</script></body></html>`;
  return c.html(html, 200, { "cache-control": "no-store" });
});

app.post("/hooks/offer/:token", async (c) => {
  await ensureMigrated(c.env.DB);
  const token = c.req.param("token");
  const o = /^[A-Za-z0-9_-]{20,64}$/.test(token) ? await offerByToken(c.env.DB, token) : null;
  if (!o) return c.json({ error: "invalid_link" }, 404);
  const { accept } = await c.req.json<{ accept?: boolean }>().catch(() => ({ accept: undefined }));
  if (typeof accept !== "boolean") return c.json({ error: "bad_request" }, 400);
  return c.json({ result: await answerOffer(c.env, c.env.DB, o, accept) });
});

// Calendar feed (iCalendar) for one employee, read by Google/Apple/Outlook calendars. Protected by its secret token.
app.get("/cal/:file", async (c) => {
  await ensureMigrated(c.env.DB);
  const token = c.req.param("file").replace(/\.ics$/, "");
  const who = /^[A-Za-z0-9_-]{20,64}$/.test(token) ? await c.env.DB.prepare("SELECT s.id, s.name FROM calendar_tokens ct JOIN staff s ON s.id = ct.staff_id WHERE ct.token = ?").bind(token).first<{ id: number; name: string }>() : null;
  if (!who) return c.text("not found", 404);
  const from = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 16), to = new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 16);
  const rows = await c.env.DB.prepare(
    `SELECT sh.id, sh.start_at, sh.end_at, sh.until_close, sh.notes, rs.name AS restaurant, ro.name_fr, (SELECT sex FROM staff WHERE id = sh.staff_id) AS sex
     FROM shifts sh JOIN restaurants rs ON rs.id = sh.restaurant_id JOIN roles ro ON ro.id = sh.role_id
     WHERE sh.staff_id = ? AND sh.status = 'ok' AND sh.start_at >= ? AND sh.start_at < ? ORDER BY sh.start_at`,
  ).bind(who.id, from, to).all<{ id: number; start_at: string; end_at: string; until_close: number; notes: string | null; restaurant: string; name_fr: string; sex: string | null }>();
  const stamp = (v: string) => v.replace(/[-:]/g, "") + "00";
  const fold = (v: string) => v.replace(/[\\;,]/g, (m) => "\\" + m).replace(/\n/g, "\\n");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mikes//Horaire//FR", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Mikes - Horaire", `X-WR-TIMEZONE:${c.env.TIMEZONE ?? "America/Toronto"}`];
  const now = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  for (const r of rows.results) {
    lines.push("BEGIN:VEVENT", `UID:shift-${r.id}@mikes`, `DTSTAMP:${now}`,
      `DTSTART;TZID=${c.env.TIMEZONE ?? "America/Toronto"}:${stamp(r.start_at)}`, `DTEND;TZID=${c.env.TIMEZONE ?? "America/Toronto"}:${stamp(r.end_at)}`,
      `SUMMARY:${fold(`Mikes ${r.restaurant} - ${genderedRole(r.name_fr, r.sex)}`)}`, ...(r.notes ? [`DESCRIPTION:${fold(r.notes)}`] : []), "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return c.body(lines.join("\r\n") + "\r\n", 200, { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=300" });
});

// Inbound SMS from Twilio: YES / NO to an offer, or SICK to report the next shift.
app.post("/hooks/twilio", async (c) => {
  await ensureMigrated(c.env.DB);
  const conn = await loadConnections(c.env, c.env.DB);
  const form = await c.req.formData().catch(() => null);
  const params: Record<string, string> = {};
  form?.forEach((v, k) => { if (typeof v === "string") params[k] = v; });
  const url = conn.appUrl ? `${conn.appUrl}/hooks/twilio` : c.req.url;
  if (!conn.twilio || !(await verifyTwilioSignature(conn.twilio.token, url, params, c.req.header("X-Twilio-Signature")))) return c.text("forbidden", 403);
  const twiml = (text?: string) => c.body(`<?xml version="1.0" encoding="UTF-8"?><Response>${text ? `<Message>${esc(text)}</Message>` : ""}</Response>`, 200, { "content-type": "text/xml" });
  const from = normalizePhone(params.From);
  const person = from ? await c.env.DB.prepare("SELECT id, name, lang, sex FROM staff WHERE phone = ?").bind(from).first<{ id: number; name: string; lang: string; sex: string | null }>() : null;
  if (!person) return twiml();
  const lang: Lang = person.lang === "en" ? "en" : "fr";
  const word = (params.Body ?? "").trim().toLowerCase();

  if (/^(oui|o|yes|y|1|ok)\b/.test(word) || /^(non|n|no|2)\b/.test(word)) {
    const accept = /^(oui|o|yes|y|1|ok)\b/.test(word);
    const offer = await c.env.DB.prepare("SELECT id, request_id, staff_id, status FROM coverage_offers WHERE staff_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1").bind(person.id).first<{ id: number; request_id: number; staff_id: number; status: string }>();
    if (!offer) return twiml(T.noOpenOffer(lang).text);
    const result = await answerOffer(c.env, c.env.DB, offer, accept);
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
      await startSickCall(c.env, c.env.DB, shift.id, person.id);
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
    ctx.waitUntil((async () => { await ensureMigrated(env.DB); await escalateDue(env, env.DB); })());
  },
};
