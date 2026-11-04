// Supplier invoices: reading one with Claude (photo or PDF), matching its lines to the ingredients the supplier delivers,
// comparing them with what was ordered, and finding the price changes.

export interface InvoiceLine { code: string | null; description: string; qty: number | null; unit: string | null; unit_price: number | null; line_total: number | null }
export interface Invoice { invoice_number: string | null; invoice_date: string | null; total: number | null; lines: InvoiceLine[] }

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const money = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.replace(/[^\d.,-]/g, "").replace(",", ".")) : v;
  return typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 10_000_000 ? Math.round(n * 10000) / 10000 : null;
};

/** What Claude answered (a JSON object somewhere in the text), cleaned; null when it is not an invoice. */
export function parseInvoice(text: string): Invoice | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: Record<string, unknown>;
  try { j = JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
  if (!Array.isArray(j.lines)) return null;
  const lines: InvoiceLine[] = [];
  for (const r of j.lines.slice(0, 300) as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const description = str(r.description, 160);
    if (!description) continue;
    lines.push({ code: str(typeof r.code === "number" ? String(r.code) : r.code, 40), description, qty: money(r.qty), unit: str(r.unit, 20), unit_price: money(r.unit_price), line_total: money(r.line_total) });
  }
  const date = str(j.invoice_date, 20);
  return { invoice_number: str(typeof j.invoice_number === "number" ? String(j.invoice_number) : j.invoice_number, 40), invoice_date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null, total: money(j.total), lines };
}

const PROMPT = `This is a supplier invoice for a restaurant (it may be in French or English). Read every product line. Answer with ONLY one JSON object:
{"invoice_number": string|null, "invoice_date": "YYYY-MM-DD"|null, "total": number|null (the invoice total before or after tax, as printed), "lines": [{"code": the supplier's product number as printed|null, "description": string, "qty": number|null (the quantity delivered), "unit": string|null (case, kg, unit...), "unit_price": number|null (price of ONE unit, as printed), "line_total": number|null}]}
Skip taxes, delivery fees, deposits and totals as lines. Use null for anything you cannot read; never guess.`;

export const INVOICE_MODEL = "claude-sonnet-5-5";
export const INVOICE_MIMES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
export const MAX_INVOICE_BYTES = 1_400_000;

export async function extractInvoice(apiKey: string, base64: string, mime: string, fetcher: typeof fetch = fetch, apiBase = "https://api.anthropic.com", onUsage?: (usage: Record<string, number>, model: string) => void): Promise<Invoice | null> {
  const block = mime === "application/pdf" ? { type: "document", source: { type: "base64", media_type: mime, data: base64 } } : { type: "image", source: { type: "base64", media_type: mime, data: base64 } };
  const res = await fetcher(`${apiBase}/v1/messages`, {
    method: "POST", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: INVOICE_MODEL, max_tokens: 6000, messages: [{ role: "user", content: [block, { type: "text", text: PROMPT }] }] }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: Record<string, number>; model?: string };
  if (body.usage) onUsage?.(body.usage, body.model ?? INVOICE_MODEL);
  return parseInvoice(body.content?.find((c) => c.type === "text")?.text ?? "");
}

// ---------- matching and comparing ----------
export interface CatalogItem { name: string; p: string | null; alt: string[]; price: number | null; unit: string | null }
export interface OrderedItem { name: string; note: string | null }
export type RowStatus = "ok" | "substitute" | "extra" | "unknown";
export interface ComparedRow { line: InvoiceLine; status: RowStatus; ingredient: string | null; via: "code" | "alt" | "name" | null }
export interface PriceChange { ingredient: string; old: number | null; new: number; unit: string | null }
export interface Comparison { rows: ComparedRow[]; missing: OrderedItem[]; price_changes: PriceChange[]; had_order: boolean }

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tokens = (s: string) => new Set(norm(s).split(" ").filter((t) => t.length > 1));
/** 0..1: how much of the shorter name's words are in the other. */
export function similarity(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const t of A) if (B.has(t)) common++;
  return common / Math.min(A.size, B.size) * (common / Math.max(A.size, B.size) + 1) / 2;
}
const sameCode = (a: string | null, b: string | null) => !!a && !!b && a.replace(/[\s-]/g, "").toLowerCase() === b.replace(/[\s-]/g, "").toLowerCase();

export function compareInvoice(lines: InvoiceLine[], catalog: CatalogItem[], ordered: OrderedItem[] | null): Comparison {
  const orderedKeys = new Set((ordered ?? []).map((o) => norm(o.name)));
  const matchedKeys = new Set<string>();
  const rows: ComparedRow[] = [], changes: PriceChange[] = [];
  for (const line of lines) {
    let hit: CatalogItem | undefined, via: ComparedRow["via"] = null;
    hit = catalog.find((c) => sameCode(c.p, line.code)); if (hit) via = "code";
    if (!hit) { hit = catalog.find((c) => c.alt.some((a) => sameCode(a, line.code))); if (hit) via = "alt"; }
    if (!hit) {
      let best = 0;
      for (const c of catalog) { const s = Math.max(similarity(c.name, line.description), ...c.name.split("/").map((x) => similarity(x, line.description))); if (s > best) { best = s; hit = c; } }
      if (hit && best >= 0.6) via = "name"; else hit = undefined;
    }
    if (!hit) { rows.push({ line, status: "unknown", ingredient: null, via: null }); continue; }
    matchedKeys.add(norm(hit.name));
    const wasOrdered = ordered === null || orderedKeys.has(norm(hit.name));
    rows.push({ line, status: via === "alt" ? "substitute" : wasOrdered ? "ok" : "extra", ingredient: hit.name, via });
    if (line.unit_price && line.unit_price > 0 && (hit.price === null || Math.abs(hit.price - line.unit_price) > 0.004) && !changes.some((c) => norm(c.ingredient) === norm(hit!.name))) changes.push({ ingredient: hit.name, old: hit.price, new: line.unit_price, unit: line.unit ?? hit.unit });
  }
  const missing = (ordered ?? []).filter((o) => !matchedKeys.has(norm(o.name)));
  return { rows, missing, price_changes: changes, had_order: ordered !== null };
}
