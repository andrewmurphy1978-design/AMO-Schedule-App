// Stock taking helpers: how an ingredient is packaged (a case holds 12 bags...) and how a count made of several quantities adds up.

export interface InvSpec {
  family: string | null;       // products that go together (e.g. "Boîtes à pizza"): shown under one heading
  base_unit: string | null;    // what is counted one by one: bouteille, sac, boîte...
  pack_unit: string | null;    // the bigger package: caisse, liasse, palette...
  pack_qty: number | null;     // how many base units in one package
  pack_weight: number | null;  // weight of a full package, kg
  unit_weight: number | null;  // weight of one base unit, kg
  min_qty: number | null;      // below this many base units, it is time to order
  pack_cost: number | null;    // price of a full package
  sku: string | null;          // supplier's product code
}

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown, max: number, dec = 3): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= max ? Math.round(n * 10 ** dec) / 10 ** dec : null;
};

/** What the administrator typed, cleaned; null when nothing is filled in. */
export function cleanInv(raw: unknown): InvSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const spec: InvSpec = {
    family: text(r.family, 60), base_unit: text(r.base_unit, 20), pack_unit: text(r.pack_unit, 20), pack_qty: num(r.pack_qty, 100_000),
    pack_weight: num(r.pack_weight, 100_000), unit_weight: num(r.unit_weight, 100_000), min_qty: num(r.min_qty, 1_000_000), pack_cost: num(r.pack_cost, 1_000_000, 2), sku: text(r.sku, 40),
  };
  if (!spec.pack_qty) spec.pack_unit = spec.pack_unit && null; // a package without a size is not a package
  return Object.values(spec).some((v) => v !== null) ? spec : null;
}

export function parseInv(json: string | null | undefined): InvSpec | null {
  if (!json) return null;
  try { return cleanInv(JSON.parse(json)); } catch { return null; }
}

export interface Part { q: number; u: "pack" | "unit" | "other"; label?: string }

/** The quantities of one count line, cleaned; null when it is not a usable list. */
export function cleanParts(raw: unknown): Part[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 8) return null;
  const out: Part[] = [];
  for (const p of raw as Record<string, unknown>[]) {
    if (!p || typeof p.q !== "number" || !Number.isFinite(p.q) || p.q < 0 || p.q > 1_000_000) return null;
    const u = p.u === "pack" || p.u === "other" ? p.u : "unit";
    const label = text(p.label, 20);
    out.push({ q: Math.round(p.q * 1000) / 1000, u, ...(label ? { label } : {}) });
  }
  return out;
}

/** The count in base units: packages are multiplied by their size; a quantity in another unit ("palette") is kept but not added. */
export function partsTotal(parts: Part[], spec: InvSpec | null): number {
  let t = 0;
  for (const p of parts) {
    if (p.u === "pack") t += p.q * (spec?.pack_qty ?? 1);
    else if (p.u === "unit") t += p.q;
  }
  return Math.round(t * 1000) / 1000;
}

/** Weight of the count in kg, when the weights are known. */
export function partsWeight(parts: Part[], spec: InvSpec | null): number | null {
  if (!spec) return null;
  const perUnit = spec.unit_weight ?? (spec.pack_weight && spec.pack_qty ? spec.pack_weight / spec.pack_qty : null);
  let w = 0, known = false;
  for (const p of parts) {
    if (p.u === "pack" && spec.pack_weight) { w += p.q * spec.pack_weight; known = true; }
    else if (p.u === "pack" && perUnit && spec.pack_qty) { w += p.q * spec.pack_qty * perUnit; known = true; }
    else if (p.u === "unit" && perUnit) { w += p.q * perUnit; known = true; }
  }
  return known ? Math.round(w * 100) / 100 : null;
}
