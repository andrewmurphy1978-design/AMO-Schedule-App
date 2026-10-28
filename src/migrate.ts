// Applies pending migrations on the first request after each deploy, so a plain
// `wrangler deploy` (Cloudflare's automatic git deploy) is enough — no terminal step.
import m0001 from "../migrations/0001_init.sql";
import m0002 from "../migrations/0002_staff_prefs.sql";
import m0003 from "../migrations/0003_until_close.sql";
import m0004 from "../migrations/0004_targets_hours.sql";
import m0005 from "../migrations/0005_target_sets.sql";
import m0006 from "../migrations/0006_open_time.sql";
import m0007 from "../migrations/0007_open_hours_by_day.sql";
import m0008 from "../migrations/0008_staff_color.sql";
import m0009 from "../migrations/0009_staff_photos.sql";
import m0010 from "../migrations/0010_staff_wages.sql";
import m0011 from "../migrations/0011_close_by_day.sql";
import m0012 from "../migrations/0012_messaging_sick.sql";
import m0013 from "../migrations/0013_prep_dept_role_wages.sql";
import m0014 from "../migrations/0014_payslips_sin.sql";
import m0015 from "../migrations/0015_time_off.sql";
import m0016 from "../migrations/0016_incidents.sql";
import m0017 from "../migrations/0017_pre_open.sql";
import m0018 from "../migrations/0018_default_wages.sql";
import m0019 from "../migrations/0019_availability_limits.sql";
import m0020 from "../migrations/0020_first_last_name.sql";
import m0021 from "../migrations/0021_owner_role.sql";
import m0022 from "../migrations/0022_staff_active.sql";
import m0023 from "../migrations/0023_shift_roles.sql";
import m0024 from "../migrations/0024_target_periods.sql";
import m0025 from "../migrations/0025_sex.sql";
import m0026 from "../migrations/0026_print_order.sql";
import m0027 from "../migrations/0027_shift_roles_no_count.sql";
import m0028 from "../migrations/0028_shift_segments.sql";

const MIGRATIONS: [string, string][] = [
  ["0001_init", m0001],
  ["0002_staff_prefs", m0002],
  ["0003_until_close", m0003],
  ["0004_targets_hours", m0004],
  ["0005_target_sets", m0005],
  ["0006_open_time", m0006],
  ["0007_open_hours_by_day", m0007],
  ["0008_staff_color", m0008],
  ["0009_staff_photos", m0009],
  ["0010_staff_wages", m0010],
  ["0011_close_by_day", m0011],
  ["0012_messaging_sick", m0012],
  ["0013_prep_dept_role_wages", m0013],
  ["0014_payslips_sin", m0014],
  ["0015_time_off", m0015],
  ["0016_incidents", m0016],
  ["0017_pre_open", m0017],
  ["0018_default_wages", m0018],
  ["0019_availability_limits", m0019],
  ["0020_first_last_name", m0020],
  ["0021_owner_role", m0021],
  ["0022_staff_active", m0022],
  ["0023_shift_roles", m0023],
  ["0024_target_periods", m0024],
  ["0025_sex", m0025],
  ["0026_print_order", m0026],
  ["0027_shift_roles_no_count", m0027],
  ["0028_shift_segments", m0028],
];

const statements = (sql: string) =>
  sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

let ready: Promise<void> | null = null;

export function ensureMigrated(db: D1Database): Promise<void> {
  ready ??= run(db).catch((e) => {
    ready = null; // retry on next request
    throw e;
  });
  return ready;
}

async function run(db: D1Database) {
  await db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)");
  const done = new Set((await db.prepare("SELECT name FROM _migrations").all<{ name: string }>()).results.map((r) => r.name));
  for (const [name, sql] of MIGRATIONS) {
    if (done.has(name)) continue;
    try {
      await db.batch([
        ...statements(sql).map((s) => db.prepare(s)),
        db.prepare("INSERT INTO _migrations (name) VALUES (?)").bind(name),
      ]);
    } catch (e) {
      // Another isolate may have applied it concurrently.
      const again = await db.prepare("SELECT 1 FROM _migrations WHERE name = ?").bind(name).first();
      if (!again) throw e;
    }
  }
}
