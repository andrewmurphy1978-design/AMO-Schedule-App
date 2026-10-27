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
