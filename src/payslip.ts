// Pay slips: SIN handling, matching a slip to an employee, and reading a PDF with Claude. Pure parts are unit-tested.

/** Digits only; valid when 9 digits and the Luhn check passes. */
export function normalizeSin(input: unknown): string | null {
  const d = String(input ?? "").replace(/\D/g, "");
  if (d.length !== 9) return null;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(d[i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0 ? d : null;
}

/** Keyed hash (HMAC-SHA-256, hex) so the number itself is never stored. */
export async function hashSin(key: string, sin: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(sin)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z\s-]/g, " ").replace(/\s+/g, " ").trim();
/** Name as words in any order, so "Tremblay, Marie" equals "Marie Tremblay". */
const nameKey = (s: string) => fold(s).split(/[\s-]+/).filter(Boolean).sort().join(" ");

export interface Extracted { employee_name: string | null; sin: string | null; period: string | null; pay_date: string | null }
export interface Candidate { id: number; name: string; sin_hash: string | null }
export interface Match { staff_id: number | null; kind: "sin" | "name" | "none" }

/** SIN match first (reliable); otherwise a name match only when exactly one employee fits; otherwise none. */
export async function chooseMatch(ex: Extracted, people: Candidate[], key: string): Promise<Match> {
  const sin = normalizeSin(ex.sin);
  if (sin) {
    const h = await hashSin(key, sin);
    const hit = people.filter((p) => p.sin_hash === h);
    if (hit.length === 1) return { staff_id: hit[0].id, kind: "sin" };
  }
  if (ex.employee_name) {
    const k = nameKey(ex.employee_name);
    const hit = people.filter((p) => nameKey(p.name) === k);
    if (hit.length === 1) return { staff_id: hit[0].id, kind: "name" };
  }
  return { staff_id: null, kind: "none" };
}

export const isPdf = (bytes: Uint8Array) => bytes.length > 8 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
export const MAX_PDF_BYTES = 1_400_000;

const PROMPT = `This PDF is one employee's pay slip (Canada). Extract: the employee's full name, their Social Insurance Number (SIN, 9 digits, if printed), the pay period (for example "2026-10-19 to 2026-10-25"), and the pay date (YYYY-MM-DD). Reply with ONLY a JSON object: {"employee_name": string|null, "sin": string|null, "period": string|null, "pay_date": string|null}. Use null for anything not printed. Do not guess.`;

/** Asks Claude to read the PDF. Returns nulls when it cannot be read; never throws on a bad answer. */
export async function extractPayslip(apiKey: string, pdfBase64: string, fetcher: typeof fetch = fetch, apiBase = "https://api.anthropic.com"): Promise<Extracted | null> {
  const res = await fetcher(`${apiBase}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5-5", max_tokens: 400,
      messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } }, { type: "text", text: PROMPT }] }],
    }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = body.content?.find((c) => c.type === "text")?.text ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);
    const date = str(j.pay_date);
    return { employee_name: str(j.employee_name), sin: str(j.sin), period: str(j.period), pay_date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null };
  } catch { return null; }
}

export const bytesToBase64 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
