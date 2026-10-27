import { Hono } from "hono";
import { findOverlaps, SHIFT_TIME_RE } from "./conflicts.ts";
import { weekBounds } from "./week.ts";

type Env = { DB: D1Database; ASSETS: Fetcher; DEV_USER_EMAIL?: string };

interface Me {
  id: number;
  name: string;
  email: string;
  is_admin: boolean;
}

type Vars = { me: Me };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---------- Auth ----------
// In production the app sits behind Cloudflare Access, which sets this header
// after login. DEV_USER_EMAIL (local .dev.vars only) lets us test without it.
app.use("/api/*", async (c, next) => {
  const email = (
    c.req.header("Cf-Access-Authenticated-User-Email") ?? c.env.DEV_USER_EMAIL ?? ""
  ).toLowerCase();
  if (!email) return c.json({ error: "unauthenticated" }, 401);
  const row = await c.env.DB.prepare("SELECT id, name, email, is_admin FROM staff WHERE lower(email) = ?")
    .bind(email)
    .first<{ id: number; name: string; email: string; is_admin: number }>();
  if (!row) return c.json({ error: "unknown_user" }, 403);
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
    ? "SELECT id, name FROM restaurants ORDER BY name"
    : `SELECT DISTINCT r.id, r.name FROM restaurants r WHERE r.id IN
         (SELECT restaurant_id FROM staff_roles WHERE staff_id = ?1
          UNION SELECT restaurant_id FROM managers WHERE staff_id = ?1) ORDER BY r.name`;
  const stmt = c.env.DB.prepare(sql);
  return c.json((await (me.is_admin ? stmt : stmt.bind(me.id)).all()).results);
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

app.delete("/api/staff-roles", async (c) => {
  const me = c.get("me");
  const b = await c.req.json<{ staff_id: number; restaurant_id: number; role_id: number }>();
  const role = await c.env.DB.prepare("SELECT department_id FROM roles WHERE id = ?")
    .bind(b.role_id)
    .first<{ department_id: string }>();
  if (!role) return c.json({ error: "role_not_found" }, 404);
  if (!(await canManage(c.env.DB, me, b.restaurant_id, role.department_id))) return c.json({ error: "forbidden" }, 403);
  await c.env.DB.prepare("DELETE FROM staff_roles WHERE staff_id = ? AND restaurant_id = ? AND role_id = ?")
    .bind(b.staff_id, b.restaurant_id, b.role_id)
    .run();
  return c.json({ ok: true });
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
    `SELECT sh.id, sh.staff_id, s.name AS staff_name, sh.role_id, ro.name_fr, ro.name_en,
            sh.start_at, sh.end_at, sh.notes
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
            sh.start_at, sh.end_at, sh.notes
     FROM shifts sh JOIN restaurants rs ON rs.id = sh.restaurant_id JOIN roles ro ON ro.id = sh.role_id
     WHERE sh.staff_id = ? AND sh.start_at >= ? AND sh.start_at < ? ORDER BY sh.start_at`,
  )
    .bind(c.get("me").id, bounds.start, bounds.end)
    .all();
  return c.json({ week: c.req.query("week"), shifts: r.results });
});

// ---------- Shifts (edit) ----------
interface ShiftInput {
  staff_id: number;
  restaurant_id: number;
  role_id: number;
  start_at: string;
  end_at: string;
  notes?: string;
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
    "INSERT INTO shifts (staff_id, restaurant_id, role_id, start_at, end_at, notes) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(b.staff_id, b.restaurant_id, b.role_id, b.start_at, b.end_at, b.notes ?? null)
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
    "UPDATE shifts SET staff_id=?, restaurant_id=?, role_id=?, start_at=?, end_at=?, notes=? WHERE id=?",
  )
    .bind(b.staff_id, b.restaurant_id, b.role_id, b.start_at, b.end_at, b.notes ?? null, id)
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
