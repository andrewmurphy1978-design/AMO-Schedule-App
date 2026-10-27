// Applies pending migrations on the first request after each deploy, so a plain
// `wrangler deploy` (Cloudflare's automatic git deploy) is enough — no terminal step.
import m0001 from "../migrations/0001_init.sql";
import m0002 from "../migrations/0002_staff_prefs.sql";

const MIGRATIONS: [string, string][] = [
  ["0001_init", m0001],
  ["0002_staff_prefs", m0002],
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
