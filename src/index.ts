import { Hono, type Context } from "hono";
import { ensureMigrated } from "./migrate.ts";
import { fetchAccessKeys, verifyAccessJwt } from "./access.ts";
import { findOverlaps, SHIFT_TIME_RE } from "./conflicts.ts";
import { weekBounds } from "./week.ts";
import { computeCosts, parseRate } from "./payroll.ts";
import { parseSettings, validateSettingsPatch, type Settings } from "./settings.ts";
import { normalizePhone } from "./phone.ts";
import { loadConnections, deliver } from "./notify.ts";
import { publicConnectionView } from "./connections.ts";
import { verifyTwilioSignature } from "./twilio.ts";
import { T, formatWhen, type Lang } from "./templates.ts";
import { answerOffer, cancelRequest, escalateDue, fillRequest, gatherCandidates, startSickCall, FlowError } from "./sick.ts";
import { loadSettingsFrom } from "./settings-db.ts";
import { localNow } from "./week.ts";

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
  let row = await c.env.DB.prepare("SELECT id, name, email, is_admin FROM staff WHERE lower(email) = ?")
    .bind(email)
    .first<{ id: number; name: string; email: string; is_admin: number }>();
  if (!row && c.env.ADMIN_EMAIL && email === c.env.ADMIN_EMAIL.toLowerCase()) {
    // An admin record created without an email (e.g. by an import) is claimed by the first ADMIN_EMAIL login.
    row = await c.env.DB.prepare(
      "UPDATE staff SET email = ? WHERE id = (SELECT id FROM staff WHERE is_admin = 1 AND email IS NULL ORDER BY id LIMIT 1) RETURNING id, name, email, is_admin",
    )
      .bind(email)
      .first<{ id: number; name: string; email: string; is_admin: number }>();
  }
  if (!row && c.env.ADMIN_EMAIL && email === c.env.ADMIN_EMAIL.toLowerCase()) {
    const r = await c.env.DB.prepare("INSERT INTO staff (name, email, is_admin) VALUES (?, ?, 1)")
      .bind(email.split("@")[0], email)
      .run();
    row = { id: r.meta.last_row_id as number, name: email.split("@")[0], email, is_admin: 1 };
  }
  if (!row) return c.json({ error: "unknown_user", email }, 403);
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
  return rows.map((r) => {
    const day = (d: number) => hours.results.find((h) => h.restaurant_id === r.id && h.dow === d);
    return {
      ...r,
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
const SLOTS = ["06:30", "08:00", "09:00", "11:00", "14:00", "17:00", "close"];

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
  for (const [slot, n] of entries) if (!SLOTS.includes(slot) || !Number.isInteger(n) || n < 0 || n > 99) return c.json({ error: "invalid_target" }, 400);
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
  return c.json((await (me.is_admin ? stmt : stmt.bind(me.id)).all()).results);
});

app.post("/api/staff", requireAdmin, async (c) => {
  const b = await c.req.json<{ name?: string; email?: string; phone?: string; is_admin?: boolean }>();
  if (!b.name?.trim()) return c.json({ error: "name_required" }, 400);
  try {
    const r = await c.env.DB.prepare("INSERT INTO staff (name, email, phone, is_admin) VALUES (?, ?, ?, ?)")
      .bind(b.name.trim(), b.email?.trim().toLowerCase() || null, b.phone ?? null, b.is_admin ? 1 : 0)
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
  const rows = await c.env.DB.prepare(
    `SELECT sh.start_at, sh.end_at, ro.department_id, COALESCE(rw.hourly_cents, w.hourly_cents) AS rate_cents
     FROM shifts sh JOIN roles ro ON ro.id = sh.role_id LEFT JOIN staff_wages w ON w.staff_id = sh.staff_id
          LEFT JOIN staff_role_wages rw ON rw.staff_id = sh.staff_id AND rw.role_id = sh.role_id
     WHERE sh.restaurant_id = ? AND sh.status = 'ok' AND sh.start_at >= ? AND sh.start_at < ?`,
  )
    .bind(restaurantId, `${prev.toISOString().slice(0, 10)}T00:00`, bounds.end)
    .all<{ start_at: string; end_at: string; department_id: string; rate_cents: number | null }>();
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
            ro.department_id, ro.name_fr, ro.name_en, sh.until_close, sick.name AS sick_name, fb.name AS filled_by_name,
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
    `SELECT sh.id, sh.staff_id, s.name AS staff_name, s.color AS staff_color, (SELECT updated_at FROM staff_photos WHERE staff_id = s.id) AS photo_v, sh.role_id, ro.name_fr, ro.name_en,
            sh.start_at, sh.end_at, sh.until_close, sh.notes, sh.status, sh.replaced_staff_id,
            (SELECT name FROM staff WHERE id = sh.replaced_staff_id) AS replaced_name
     FROM shifts sh JOIN staff s ON s.id = sh.staff_id JOIN roles ro ON ro.id = sh.role_id
     WHERE sh.restaurant_id = ? AND ro.department_id = ? AND sh.start_at >= ? AND sh.start_at < ?
     ORDER BY sh.start_at, s.name`,
  )
    .bind(restaurantId, department, bounds.start, bounds.end)
    .all();
  const editable = await canManage(c.env.DB, me, restaurantId, department);
  const settings = await loadSettings(c.env.DB);

  // Weekly hours per person (all restaurants and departments) and "working elsewhere" markers.
  // Managers/admins see them for everyone on this schedule; everyone else only sees their own hours.
  const ids = new Set<number>((shifts.results as { staff_id: number }[]).map((x) => x.staff_id));
  if (editable) {
    const roster = await c.env.DB.prepare(
      "SELECT DISTINCT sr.staff_id FROM staff_roles sr JOIN roles ro ON ro.id = sr.role_id WHERE sr.restaurant_id = ? AND ro.department_id = ?",
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
           AND NOT (sh.restaurant_id = ? AND ro.department_id = ?)
         ORDER BY sh.start_at`,
      ).bind(...visible, bounds.start, bounds.end, restaurantId, department).all()).results;
    }
  }
  return c.json({ week: c.req.query("week"), editable, shifts: shifts.results, hours, elsewhere, limits: { overtime_hours: settings.overtime_hours } });
});

// The caller's own shifts across every restaurant and department.
app.get("/api/my-shifts", async (c) => {
  const bounds = weekBounds(c.req.query("week") ?? "");
  if (!bounds) return c.json({ error: "week_must_be_a_monday" }, 400);
  const r = await c.env.DB.prepare(
    `SELECT sh.id, sh.restaurant_id, rs.name AS restaurant, ro.department_id, ro.name_fr, ro.name_en,
            sh.start_at, sh.end_at, sh.until_close, sh.notes, sh.status
     FROM shifts sh JOIN restaurants rs ON rs.id = sh.restaurant_id JOIN roles ro ON ro.id = sh.role_id
     WHERE sh.staff_id = ? AND sh.start_at >= ? AND sh.start_at < ? ORDER BY sh.start_at`,
  )
    .bind(c.get("me").id, bounds.start, bounds.end)
    .all();
  const rows = r.results as { start_at: string; end_at: string; status: string }[];
  const minutes = (a: string, b: string) => (Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`)) / 60000;
  const total_hours = Math.round((rows.filter((x) => x.status === "ok").reduce((n, x) => n + minutes(x.start_at, x.end_at), 0) / 60) * 100) / 100;
  return c.json({ week: c.req.query("week"), shifts: r.results, total_hours, limits: { overtime_hours: (await loadSettings(c.env.DB)).overtime_hours } });
});

// ---------- Roster & admin overview ----------
// Staff who can be scheduled on a given restaurant+department (managers/admin only).
app.get("/api/roster", async (c) => {
  const restaurantId = intParam(c.req.query("restaurant"));
  const department = c.req.query("department");
  if (!restaurantId || !department) return c.json({ error: "restaurant_and_department_required" }, 400);
  if (!(await canManage(c.env.DB, c.get("me"), restaurantId, department))) return c.json({ error: "forbidden" }, 403);
  const rows = await c.env.DB.prepare(
    `SELECT s.id AS staff_id, s.name, s.color, (SELECT updated_at FROM staff_photos WHERE staff_id = s.id) AS photo_v, sr.role_id FROM staff_roles sr
     JOIN staff s ON s.id = sr.staff_id JOIN roles ro ON ro.id = sr.role_id
     WHERE sr.restaurant_id = ? AND ro.department_id = ? ORDER BY s.name`,
  )
    .bind(restaurantId, department)
    .all<{ staff_id: number; name: string; color: string | null; photo_v: number | null; role_id: number }>();
  const byStaff = new Map<number, { staff_id: number; name: string; color: string | null; photo_v: number | null; role_ids: number[] }>();
  for (const r of rows.results) {
    const e = byStaff.get(r.staff_id) ?? { staff_id: r.staff_id, name: r.name, color: r.color, photo_v: r.photo_v, role_ids: [] };
    e.role_ids.push(r.role_id);
    byStaff.set(r.staff_id, e);
  }
  return c.json([...byStaff.values()]);
});

app.get("/api/admin/overview", requireAdmin, async (c) => {
  const db = c.env.DB;
  const [staff, roles, managers, restaurants, roleWages] = await Promise.all([
    db.prepare("SELECT id, name, email, phone, is_admin, lang, notify_channel, color, (SELECT updated_at FROM staff_photos WHERE staff_id = staff.id) AS photo_v, (SELECT hourly_cents FROM staff_wages WHERE staff_id = staff.id) AS hourly_cents FROM staff ORDER BY name").all(),
    db.prepare("SELECT staff_id, restaurant_id, role_id FROM staff_roles").all<{ staff_id: number; restaurant_id: number; role_id: number }>(),
    db.prepare("SELECT staff_id, restaurant_id, department_id FROM managers").all<{ staff_id: number; restaurant_id: number; department_id: string }>(),
    db.prepare("SELECT id, name, open_time, close_time FROM restaurants ORDER BY name").all(),
    db.prepare("SELECT staff_id, role_id, hourly_cents FROM staff_role_wages").all<{ staff_id: number; role_id: number; hourly_cents: number }>(),
  ]);
  return c.json({
    restaurants: await withOpenHours(db, restaurants.results as { id: number; name: string; open_time: string; close_time: string }[]),
    staff: (staff.results as any[]).map((s) => ({
      ...s,
      is_admin: s.is_admin === 1,
      roles: roles.results.filter((r) => r.staff_id === s.id),
      managers: managers.results.filter((m) => m.staff_id === s.id),
      role_rates: Object.fromEntries(roleWages.results.filter((w) => w.staff_id === s.id).map((w) => [w.role_id, w.hourly_cents])),
    })),
  });
});

app.put("/api/staff/:id", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  if (!id) return c.json({ error: "bad_id" }, 400);
  const b = await c.req.json<{ name?: string; email?: string; phone?: string; lang?: string; notify_channel?: string; color?: string | null }>();
  if (!b.name?.trim()) return c.json({ error: "name_required" }, 400);
  if (b.color != null && !/^#[0-9a-fA-F]{6}$/.test(b.color)) return c.json({ error: "invalid_color" }, 400);
  const lang = b.lang === "en" ? "en" : "fr";
  const channel = b.notify_channel === "email" ? "email" : "sms";
  const phone = b.phone?.trim() ? normalizePhone(b.phone) : null;
  if (b.phone?.trim() && !phone) return c.json({ error: "invalid_phone" }, 400);
  try {
    await c.env.DB.prepare("UPDATE staff SET name=?, email=?, phone=?, lang=?, notify_channel=?, color=? WHERE id=?")
      .bind(b.name.trim(), b.email?.trim().toLowerCase() || null, phone, lang, channel, b.color?.toLowerCase() ?? null, id)
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
  return null;
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
    `SELECT sh.id, sh.start_at, sh.end_at, sh.until_close, sh.notes, rs.name AS restaurant, ro.name_fr
     FROM shifts sh JOIN restaurants rs ON rs.id = sh.restaurant_id JOIN roles ro ON ro.id = sh.role_id
     WHERE sh.staff_id = ? AND sh.status = 'ok' AND sh.start_at >= ? AND sh.start_at < ? ORDER BY sh.start_at`,
  ).bind(who.id, from, to).all<{ id: number; start_at: string; end_at: string; until_close: number; notes: string | null; restaurant: string; name_fr: string }>();
  const stamp = (v: string) => v.replace(/[-:]/g, "") + "00";
  const fold = (v: string) => v.replace(/[\\;,]/g, (m) => "\\" + m).replace(/\n/g, "\\n");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mikes//Horaire//FR", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Mikes - Horaire", `X-WR-TIMEZONE:${c.env.TIMEZONE ?? "America/Toronto"}`];
  const now = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  for (const r of rows.results) {
    lines.push("BEGIN:VEVENT", `UID:shift-${r.id}@mikes`, `DTSTAMP:${now}`,
      `DTSTART;TZID=${c.env.TIMEZONE ?? "America/Toronto"}:${stamp(r.start_at)}`, `DTEND;TZID=${c.env.TIMEZONE ?? "America/Toronto"}:${stamp(r.end_at)}`,
      `SUMMARY:${fold(`Mikes ${r.restaurant} - ${r.name_fr}`)}`, ...(r.notes ? [`DESCRIPTION:${fold(r.notes)}`] : []), "END:VEVENT");
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
  const person = from ? await c.env.DB.prepare("SELECT id, name, lang FROM staff WHERE phone = ?").bind(from).first<{ id: number; name: string; lang: string }>() : null;
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
      return twiml(row ? T.sickRecorded(lang, { restaurant: row.restaurant, role: lang === "fr" ? row.name_fr : row.name_en, when: formatWhen(row.start_at, row.end_at, !!row.until_close, lang) }).text : undefined);
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
