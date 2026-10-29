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
import m0029 from "../migrations/0029_kitchen_posts.sql";
import m0030 from "../migrations/0030_breakfast_runner.sql";
import m0031 from "../migrations/0031_ai_schedule.sql";
import m0032 from "../migrations/0032_remove_repeated_roles.sql";
import m0033 from "../migrations/0033_login.sql";
import m0034 from "../migrations/0034_clients.sql";
import m0035 from "../migrations/0035_api_tokens.sql";
import m0036 from "../migrations/0036_webhooks.sql";
import m0037 from "../migrations/0037_publications.sql";
import m0038 from "../migrations/0038_absence_reason.sql";
import m0039 from "../migrations/0039_absences.sql";
import m0040 from "../migrations/0040_view_access.sql";
import m0041 from "../migrations/0041_half_hour_targets.sql";
import m0042 from "../migrations/0042_special_hours.sql";
import m0043 from "../migrations/0043_dinner_start.sql";

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
  ["0029_kitchen_posts", m0029],
  ["0030_breakfast_runner", m0030],
  ["0031_ai_schedule", m0031],
  ["0032_remove_repeated_roles", m0032],
  ["0033_login", m0033],
  ["0034_clients", m0034],
  ["0035_api_tokens", m0035],
  ["0036_webhooks", m0036],
  ["0037_publications", m0037],
  ["0038_absence_reason", m0038],
  ["0039_absences", m0039],
  ["0040_view_access", m0040],
  ["0041_half_hour_targets", m0041],
  ["0042_special_hours", m0042],
  ["0043_dinner_start", m0043],
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
