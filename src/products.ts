// Products: what the customers buy (ready to eat). A product comes in one or more formats (10", 12", 14"...), each with its price and the ingredients it takes,
// with the quantity of each. Ingredients are named like in the ingredients list (the same name = the same ingredient).

export interface ProductIngredient { ingredient: string; qty: number | null; unit: string | null; note: string | null; choice: number | null } // same choice = alternatives (this OR that)
export interface ProductFormat { name: string; price: number | null; ingredients: ProductIngredient[] }
export interface Product { name_fr: string; name_en: string | null; category: string | null; description: string | null; code: string | null; active: boolean; is_promo: boolean; available_from: string | null; available_to: string | null; channels: Channel[]; formats: ProductFormat[] }

export const CHANNELS = ["dine_in", "delivery", "counter"] as const; // dining room, delivery, counter order
export type Channel = (typeof CHANNELS)[number];
export const MAX_FORMATS = 12;
export const MAX_LINES = 40;

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown, max: number, dec: number): number | null => {
  const n = typeof v === "string" ? Number(v.replace(",", ".").trim()) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= max ? Math.round(n * 10 ** dec) / 10 ** dec : null;
};

/** What was typed or imported for one product, cleaned; `error` says what is wrong. */
export function cleanProduct(raw: unknown): { product: Product } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "invalid_product" };
  const r = raw as Record<string, unknown>;
  const name_fr = text(r.name_fr ?? r.name, 80);
  if (!name_fr) return { error: "name_required" };
  const rawFormats = Array.isArray(r.formats) && r.formats.length ? r.formats : [{ name: "" }];
  if (rawFormats.length > MAX_FORMATS) return { error: "too_many_formats" };
  const formats: ProductFormat[] = [];
  const seen = new Set<string>();
  for (const f of rawFormats as Record<string, unknown>[]) {
    if (!f || typeof f !== "object") return { error: "invalid_format" };
    const name = text(f.name, 40) ?? "";
    if (seen.has(name.toLowerCase())) return { error: "duplicate_format" };
    seen.add(name.toLowerCase());
    const lines = Array.isArray(f.ingredients) ? f.ingredients : [];
    if (lines.length > MAX_LINES) return { error: "too_many_ingredients" };
    const ingredients: ProductIngredient[] = [];
    for (const l of lines as Record<string, unknown>[]) {
      const ingredient = text(l?.ingredient ?? l?.name, 80);
      if (!ingredient) continue;               // an empty line is dropped
      if (ingredients.some((x) => x.ingredient.toLowerCase() === ingredient.toLowerCase())) return { error: "duplicate_ingredient" };
      const g = Number(l.choice ?? l.choice_group);
      ingredients.push({ ingredient, qty: num(l.qty, 1_000_000, 3), unit: text(l.unit, 20), note: text(l.note, 80), choice: Number.isInteger(g) && g > 0 && g < 1000 ? g : null });
    }
    normalizeChoices(ingredients);
    formats.push({ name, price: num(f.price, 100_000, 2), ingredients });
  }
  // a promotion (or any product) can be sold only during a period
  const day = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) && !Number.isNaN(Date.parse(v.trim())) ? v.trim() : null);
  const available_from = day(r.available_from), available_to = day(r.available_to);
  if (available_from && available_to && available_from > available_to) return { error: "invalid_period" };
  const is_promo = r.is_promo === true || r.is_promo === 1;
  // where it is sold: one or more of the dining room, delivery and the counter (nothing given = everywhere)
  let channels: Channel[] = [...CHANNELS];
  if (Array.isArray(r.channels)) { channels = CHANNELS.filter((c) => (r.channels as unknown[]).includes(c)); if (!channels.length) return { error: "channel_required" }; }
  return { product: { name_fr, name_en: text(r.name_en, 80), category: text(r.category, 40), description: text(r.description, 300), code: text(r.code, 30), active: r.active !== false && r.active !== 0, is_promo, available_from, available_to, channels, formats } };
}

/** Where an ingredient is used: ingredient name (lower case) -> the products and formats that use it. */
export function usedIn(products: { name_fr: string; formats: ProductFormat[] }[]): Map<string, { product: string; format: string; qty: number | null; unit: string | null }[]> {
  const out = new Map<string, { product: string; format: string; qty: number | null; unit: string | null }[]>();
  for (const p of products) for (const f of p.formats) for (const i of f.ingredients) {
    const k = i.ingredient.toLowerCase();
    out.set(k, [...(out.get(k) ?? []), { product: p.name_fr, format: f.name, qty: i.qty, unit: i.unit }]);
  }
  return out;
}

export type Availability = "always" | "upcoming" | "current" | "expired";
/** Whether a product is on sale on `today` ("YYYY-MM-DD"): always (no period), before its period, during it, or after it. */
export function availability(p: { available_from: string | null; available_to: string | null }, today: string): Availability {
  if (!p.available_from && !p.available_to) return "always";
  if (p.available_from && today < p.available_from) return "upcoming";
  if (p.available_to && today > p.available_to) return "expired";
  return "current";
}

/** A choice needs at least two options (a lone one is a plain ingredient); groups are numbered 1, 2... and their lines kept together, at the place of the first one. */
export function normalizeChoices(lines: ProductIngredient[]): void {
  const count = new Map<number, number>();
  for (const l of lines) if (l.choice !== null) count.set(l.choice, (count.get(l.choice) ?? 0) + 1);
  for (const l of lines) if (l.choice !== null && (count.get(l.choice) ?? 0) < 2) l.choice = null;
  const order: number[] = [];
  for (const l of lines) if (l.choice !== null && !order.includes(l.choice)) order.push(l.choice);
  const out: ProductIngredient[] = [], done = new Set<number>();
  for (const l of lines) {
    if (l.choice === null) { out.push(l); continue; }
    if (done.has(l.choice)) continue;
    done.add(l.choice);
    for (const x of lines) if (x.choice === l.choice) out.push({ ...x, choice: order.indexOf(l.choice) + 1 });
  }
  lines.splice(0, lines.length, ...out);
}
