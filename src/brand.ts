// Per-client branding (name, colour, logo, texts, email sender name). Stored in the `settings` table so each
// client edits it from Administration; the sign-in screen reads it without being signed in.

export const BRAND_TEXT_KEYS = ["name", "sender_name", "title_fr", "title_en", "intro_fr", "intro_en", "footer_fr", "footer_en"] as const;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] as const;
export const MAX_LOGO_BYTES = 300 * 1024;

export interface Brand {
  name: string; color: string; sender_name: string;
  title_fr: string; title_en: string; intro_fr: string; intro_en: string; footer_fr: string; footer_en: string;
  logo: boolean; logo_v: number;
}

export const DEFAULT_BRAND: Brand = {
  name: "Mikes", color: "#da291c", sender_name: "",
  title_fr: "", title_en: "", intro_fr: "", intro_en: "", footer_fr: "", footer_en: "", logo: false, logo_v: 0,
};

export function parseBrand(rows: { key: string; value: string }[]): Brand {
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const b: Brand = { ...DEFAULT_BRAND };
  for (const k of BRAND_TEXT_KEYS) { const v = m.get(`brand_${k}`); if (v != null && (v !== "" || k !== "name")) b[k] = v; }
  const c = m.get("brand_color"); if (c && /^#[0-9a-f]{6}$/i.test(c)) b.color = c.toLowerCase();
  b.logo = m.has("brand_logo_type");
  b.logo_v = Number(m.get("brand_logo_v") ?? 0);
  return b;
}

/** Validates an admin's branding update; returns the cleaned key/value pairs or an error code. */
export function validateBrandPatch(p: Record<string, unknown>): { values: Record<string, string> } | { error: string } {
  const values: Record<string, string> = {};
  for (const k of BRAND_TEXT_KEYS) {
    if (!(k in p)) continue;
    const v = typeof p[k] === "string" ? (p[k] as string).trim() : "";
    const max = k.startsWith("intro") || k.startsWith("footer") ? 300 : 80;
    if (v.length > max) return { error: `too_long:${k}` };
    if (k === "name" && !v) return { error: "name_required" };
    if (/[\r\n]/.test(v) && (k === "name" || k === "sender_name")) return { error: `invalid:${k}` };
    values[`brand_${k}`] = v;
  }
  if ("color" in p) {
    if (typeof p.color !== "string" || !/^#[0-9a-f]{6}$/i.test(p.color)) return { error: "invalid_color" };
    values.brand_color = p.color.toLowerCase();
  }
  return { values };
}

/** "Name <address>" when a sender name is set (an address already in that form is left alone). */
export function senderAddress(from: string, senderName: string): string {
  if (!senderName || from.includes("<")) return from;
  return `${senderName.replace(/[<>"\r\n]/g, "")} <${from}>`;
}

export function darken(hex: string, f = 0.78): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.round(((n >> s) & 255) * f).toString(16).padStart(2, "0");
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}
