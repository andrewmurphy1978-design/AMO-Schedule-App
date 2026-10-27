// Deployment-wide settings, stored as text in the `settings` table. Pure parsing/validation so it can be tested.

export interface Settings {
  overtime_hours: number;              // weekly hours above which a person is flagged
  sick_timeout_minutes: number;        // wait this long for a replacement before telling the manager to act
  replacement_allow_overtime: boolean; // may a replacement push someone past overtime_hours?
}

export const DEFAULT_SETTINGS: Settings = { overtime_hours: 40, sick_timeout_minutes: 30, replacement_allow_overtime: false };

export function parseSettings(rows: { key: string; value: string }[]): Settings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const num = (k: keyof Settings, lo: number, hi: number, d: number) => {
    const n = Number(map.get(k));
    return map.has(k) && Number.isFinite(n) && n >= lo && n <= hi ? n : d;
  };
  return {
    overtime_hours: num("overtime_hours", 1, 100, DEFAULT_SETTINGS.overtime_hours),
    sick_timeout_minutes: num("sick_timeout_minutes", 1, 1440, DEFAULT_SETTINGS.sick_timeout_minutes),
    replacement_allow_overtime: map.get("replacement_allow_overtime") === "true",
  };
}

/** Validates a partial update; returns the {key: text} rows to store, or null when anything is invalid. */
export function validateSettingsPatch(patch: unknown): Record<string, string> | null {
  if (!patch || typeof patch !== "object") return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (k === "overtime_hours" || k === "sick_timeout_minutes") {
      const [lo, hi] = k === "overtime_hours" ? [1, 100] : [1, 1440];
      if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) return null;
      out[k] = String(v);
    } else if (k === "replacement_allow_overtime") {
      if (typeof v !== "boolean") return null;
      out[k] = String(v);
    } else return null; // unknown key
  }
  return out;
}
