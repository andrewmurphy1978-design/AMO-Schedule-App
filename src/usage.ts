// Costs of the paid services: Claude (tokens x price per million) and Twilio (the price Twilio reports for each text and call).
import type { TwilioConfig } from "./twilio.ts";

export interface ClaudeUsage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

/** Dollars per million tokens: [input, output]. Cache reads cost 0.1x the input price, cache writes 1.25x. */
export const CLAUDE_PRICES: Record<string, [number, number]> = {
  "claude-sonnet-5-5": [2, 10], "claude-sonnet-5": [2, 10], "claude-opus-5-5": [4, 20], "claude-opus-5": [5, 25], "claude-haiku-5-5": [0.1, 0.5],
};

/** Cost of one Claude answer in millionths of a dollar (null when the model's price is not known). */
export function claudeCostMicro(model: string, u: ClaudeUsage): number | null {
  const p = CLAUDE_PRICES[model];
  if (!p) return null;
  const input = (u.input_tokens ?? 0) * p[0] + (u.cache_read_input_tokens ?? 0) * p[0] * 0.1 + (u.cache_creation_input_tokens ?? 0) * p[0] * 1.25;
  return Math.round(input + (u.output_tokens ?? 0) * p[1]); // $/M tokens x tokens = micro-dollars
}

export interface UsageRow { client_id: number; kind: "ai_schedule" | "payslip" | "invoice" | "sms" | "call"; provider: "anthropic" | "twilio"; model?: string | null; input_tokens?: number | null; output_tokens?: number | null; units?: number | null; cost_micro?: number | null; currency?: string; ref?: string | null; detail?: string | null; staff_id?: number | null }

/** Records one use. Never throws: a failure to log must not break the feature. */
export async function logUsage(db: D1Database, r: UsageRow): Promise<void> {
  try {
    await db.prepare("INSERT INTO usage_log (client_id, kind, provider, model, input_tokens, output_tokens, units, cost_micro, currency, ref, detail, staff_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(r.client_id, r.kind, r.provider, r.model ?? null, r.input_tokens ?? null, r.output_tokens ?? null, r.units ?? null, r.cost_micro ?? null, r.currency ?? "USD", r.ref ?? null, (r.detail ?? "").slice(0, 200) || null, r.staff_id ?? null, Date.now()).run();
  } catch { /* the feature matters more than its log */ }
}

export const logClaude = (db: D1Database, clientId: number, kind: "ai_schedule" | "payslip" | "invoice", model: string, u: ClaudeUsage, detail: string, staffId?: number) =>
  logUsage(db, { client_id: clientId, kind, provider: "anthropic", model, input_tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output_tokens: u.output_tokens ?? 0, cost_micro: claudeCostMicro(model, u), detail, staff_id: staffId });

/** Twilio's price of a text or call, once known: positive micro-dollars ("-0.00750" USD becomes 7500). */
export async function twilioPrice(cfg: TwilioConfig, kind: "sms" | "call", sid: string): Promise<{ cost_micro: number; currency: string; units: number | null } | null> {
  const base = cfg.apiBase ?? "https://api.twilio.com";
  const path = kind === "sms" ? "Messages" : "Calls";
  try {
    const res = await fetch(`${base}/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}/${path}/${encodeURIComponent(sid)}.json`, { headers: { authorization: `Basic ${btoa(`${cfg.sid}:${cfg.token}`)}` } });
    if (!res.ok) return null;
    const j = (await res.json()) as { price?: string | null; price_unit?: string; num_segments?: string; duration?: string };
    if (j.price === null || j.price === undefined || j.price === "") return null; // not priced yet
    return { cost_micro: Math.round(Math.abs(Number(j.price)) * 1_000_000), currency: (j.price_unit ?? "USD").toUpperCase(), units: kindUnits(kind, j) };
  } catch { return null; }
}
const kindUnits = (kind: "sms" | "call", j: { num_segments?: string; duration?: string }) => { const n = Number(kind === "sms" ? j.num_segments : j.duration); return Number.isFinite(n) ? n : null; };

/** Cron: fill in the price of the texts and calls sent in the last days (Twilio prices them a little after). */
export async function fillTwilioPrices(db: D1Database, twilioFor: (clientId: number) => Promise<TwilioConfig | null>): Promise<number> {
  const rows = (await db.prepare("SELECT id, client_id, kind, ref FROM usage_log WHERE provider = 'twilio' AND cost_micro IS NULL AND ref IS NOT NULL AND created_at < ? AND created_at > ? ORDER BY id LIMIT 25").bind(Date.now() - 3 * 60_000, Date.now() - 4 * 86_400_000).all<{ id: number; client_id: number; kind: "sms" | "call"; ref: string }>()).results;
  let n = 0;
  for (const r of rows) {
    const cfg = await twilioFor(r.client_id); if (!cfg) continue;
    const p = await twilioPrice(cfg, r.kind, r.ref); if (!p) continue;
    await db.prepare("UPDATE usage_log SET cost_micro = ?, currency = ?, units = COALESCE(?, units) WHERE id = ?").bind(p.cost_micro, p.currency, p.units, r.id).run(); n++;
  }
  return n;
}
