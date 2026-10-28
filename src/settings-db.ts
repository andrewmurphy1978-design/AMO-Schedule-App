import { parseSettings, type Settings } from "./settings.ts";
import { clientSettingRows } from "./tenant.ts";

export async function loadSettingsFrom(db: D1Database, clientId = 1): Promise<Settings> {
  return parseSettings(await clientSettingRows(db, clientId));
}
