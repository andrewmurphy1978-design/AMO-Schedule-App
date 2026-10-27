import { Hono, type Context } from "hono";
import { ensureMigrated } from "./migrate.ts";
import { fetchAccessKeys, verifyAccessJwt } from "./access.ts";
import { findOverlaps, SHIFT_TIME_RE } from "./conflicts.ts";
import { weekBounds } from "./week.ts";

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


// Adds open_by_dow (7 opening times, Monday..Sunday) to restaurant rows.
async function withOpenHours<T extends { id: number; open_time: string }>(db: D1Database, rows: T[]) {
  const hours = await db.prepare("SELECT restaurant_id, dow, open_time FROM restaurant_open_hours").all<{ restaurant_id: number; dow: number; open_time: string }>();
  return rows.map((r) => ({
    ...r,
    open_by_dow: Array.from({ length: 7 }, (_, d) => hours.results.find((h) => h.restaurant_id === r.id && h.dow === d)?.open_time ?? r.open_time),
  }));
}

const intParam = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null);

// ---------- Me ----------
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

// Opening time per weekday (open_times = 7 values, Monday..Sunday) and one closing time per restaurant.
// Until-close shifts follow the closing time.
app.put("/api/restaurants/:id/hours", requireAdmin, async (c) => {
  const id = intParam(c.req.param("id"));
  const b = await c.req.json<{ open_times?: string[]; open_time?: string; close_time?: string }>();
  if (!id) return c.json({ error: "bad_id" }, 400);
  const opens = b.open_times ?? (b.open_time ? Array(7).fill(b.open_time) : null);
  if (opens && (opens.length !== 7 || !opens.every((x) => typeof x === "string" && TIME_RE.test(x)))) return c.json({ error: "invalid_times" }, 400);
  if (b.close_time && !TIME_RE.test(b.close_time)) return c.json({ error: "invalid_times" }, 400);
  const current = await c.env.DB.prepare("SELECT open_time, close_time FROM restaurants WHERE id = ?").bind(id).first<{ open_time: string; close_time: string }>();
  if (!current) return c.json({ error: "not_found" }, 404);
  const close = b.close_time ?? current.close_time;
  const effective = opens ?? (await withOpenHours(c.env.DB, [{ id, open_time: current.open_time }]))[0].open_by_dow;
  if (effective.some((o) => o >= close)) return c.json({ error: "invalid_times" }, 400);
  const db = c.env.DB;
  await db.batch([
    db.prepare("UPDATE restaurants SET open_time = ?, close_time = ? WHERE id = ?").bind(opens ? opens[0] : current.open_time, close, id),
    ...(opens
      ? [db.prepare("DELETE FROM restaurant_open_hours WHERE restaurant_id = ?").bind(id),
         ...opens.map((o, d) => db.prepare("INSERT INTO restaurant_open_hours (restaurant_id, dow, open_time) VALUES (?, ?, ?)").bind(id, d, o))]
      : []),
    // 'F' shifts end at closing time; keep their stored end in step (only when the shift starts before closing).
    db.prepare("UPDATE shifts SET end_at = substr(start_at, 1, 10) || 'T' || ?1 WHERE restaurant_id = ?2 AND until_close = 1 AND substr(start_at, 12, 5) < ?1").bind(close, id),
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
            sh.start_at, sh.end_at, sh.until_close, sh.notes
     FROM shifts sh JOIN staff s ON s.id = sh.staff_id JOIN roles ro ON ro.id = sh.role_id
     WHERE sh.restaurant_id = ? AND ro.department_id = ? AND sh.start_at >= ? AND sh.start_at < ?
     ORDER BY sh.start_at, s.name`,
  )
    .bind(restaurantId, department, bounds.start, bounds.end)
    .all();
  const editable = await canManage(c.env.DB, me, restaurantId, department);
  return c.json({ week: c.req.query("week"), editable, shifts: shifts.results });
});

// The caller's own shifts across every restaurant and department.
app.get("/api/my-shifts", async (c) => {
  const bounds = weekBounds(c.req.query("week") ?? "");
  if (!bounds) return c.json({ error: "week_must_be_a_monday" }, 400);
  const r = await c.env.DB.prepare(
    `SELECT sh.id, sh.restaurant_id, rs.name AS restaurant, ro.department_id, ro.name_fr, ro.name_en,
            sh.start_at, sh.end_at, sh.until_close, sh.notes
     FROM shifts sh JOIN restaurants rs ON rs.id = sh.restaurant_id JOIN roles ro ON ro.id = sh.role_id
     WHERE sh.staff_id = ? AND sh.start_at >= ? AND sh.start_at < ? ORDER BY sh.start_at`,
  )
    .bind(c.get("me").id, bounds.start, bounds.end)
    .all();
  return c.json({ week: c.req.query("week"), shifts: r.results });
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
  const [staff, roles, managers, restaurants] = await Promise.all([
    db.prepare("SELECT id, name, email, phone, is_admin, lang, notify_channel, color, (SELECT updated_at FROM staff_photos WHERE staff_id = staff.id) AS photo_v FROM staff ORDER BY name").all(),
    db.prepare("SELECT staff_id, restaurant_id, role_id FROM staff_roles").all<{ staff_id: number; restaurant_id: number; role_id: number }>(),
    db.prepare("SELECT staff_id, restaurant_id, department_id FROM managers").all<{ staff_id: number; restaurant_id: number; department_id: string }>(),
    db.prepare("SELECT id, name, open_time, close_time FROM restaurants ORDER BY name").all(),
  ]);
  return c.json({
    restaurants: await withOpenHours(db, restaurants.results as { id: number; name: string; open_time: string; close_time: string }[]),
    staff: (staff.results as any[]).map((s) => ({
      ...s,
      is_admin: s.is_admin === 1,
      roles: roles.results.filter((r) => r.staff_id === s.id),
      managers: managers.results.filter((m) => m.staff_id === s.id),
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
  try {
    await c.env.DB.prepare("UPDATE staff SET name=?, email=?, phone=?, lang=?, notify_channel=?, color=? WHERE id=?")
      .bind(b.name.trim(), b.email?.trim().toLowerCase() || null, b.phone?.trim() || null, lang, channel, b.color?.toLowerCase() ?? null, id)
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
       WHERE sh.staff_id = ? AND sh.id != ? AND sh.start_at < ? AND sh.end_at > ?`,
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

app.notFound((c) => c.json({ error: "not_found" }, 404));

export default app;
