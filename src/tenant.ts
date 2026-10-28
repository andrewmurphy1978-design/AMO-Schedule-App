// Multi-client helpers. A client owns restaurants and staff; everything else is reached through them.
// Settings of client 1 keep their plain keys; client N stores them as "cN:key" so existing installs need no data migration.

export const settingKey = (clientId: number, key: string) => (clientId === 1 ? key : `c${clientId}:${key}`);

/** The settings of one client with the prefix removed, optionally only keys starting with `prefix` (e.g. "conn_"). */
export async function clientSettingRows(db: D1Database, clientId: number, prefix = ""): Promise<{ key: string; value: string }[]> {
  const stripped = clientId === 1 ? "" : `c${clientId}:`;
  const like = `${stripped}${prefix}`.replace(/[\\%_]/g, (m) => `\\${m}`) + "%";
  const rows = await db.prepare("SELECT key, value FROM settings WHERE key LIKE ? ESCAPE '\\' AND key != ?").bind(like, settingKey(clientId, "brand_logo")).all<{ key: string; value: string }>();
  return rows.results
    // client 1 has plain keys: leave out the prefixed rows of other clients
    .filter((r) => clientId !== 1 || !/^c\d+:/.test(r.key))
    .map((r) => ({ key: r.key.slice(stripped.length), value: r.value }));
}

export const getSetting = async (db: D1Database, clientId: number, key: string) =>
  (await db.prepare("SELECT value FROM settings WHERE key = ?").bind(settingKey(clientId, key)).first<{ value: string }>())?.value ?? null;

export const putSettingStmt = (db: D1Database, clientId: number, key: string, value: string) =>
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(settingKey(clientId, key), value);

export const delSettingStmt = (db: D1Database, clientId: number, key: string) =>
  db.prepare("DELETE FROM settings WHERE key = ?").bind(settingKey(clientId, key));
