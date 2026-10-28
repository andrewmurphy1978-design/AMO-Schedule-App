import { parseSettings, type Settings } from "./settings.ts";

export async function loadSettingsFrom(db: D1Database): Promise<Settings> {
  return parseSettings((await db.prepare("SELECT key, value FROM settings WHERE key != 'brand_logo'").all<{ key: string; value: string }>()).results);
}
