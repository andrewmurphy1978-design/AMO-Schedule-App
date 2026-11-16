// Accounting: double-entry books for several entities. Amounts are whole cents. Only the platform owner uses it.
import { chartFor, entityDefaults, suggestGifi, usesGifi, type EntityKind } from "./accounting-charts.ts";

export const KINDS = ["PERSONAL", "SOLE_PROPRIETORSHIP", "CORPORATION", "LLC"] as const;
export const TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] as const;
export type AccType = (typeof TYPES)[number];

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const day = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);

/** "12,50" / 12.5 / "12.5" -> 1250 cents; null when it is not a positive amount (or has more than two decimals). */
export function toCents(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v.replace(/\s/g, "").replace(",", ".")) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1e12) return null;
  const c = Math.round(n * 100);
  return Math.abs(n * 100 - c) < 1e-6 ? c : null;
}

export interface EntityInput { name: string; kind: EntityKind; country: string; province: string | null; currency: string; fiscal_year_end_month: number; basis: "CASH" | "ACCRUAL"; sales_tax_registered: boolean; tax_number: string | null }

/** An entity as typed in the form, cleaned, with the defaults of its kind. */
export function cleanEntity(raw: unknown): { entity: EntityInput } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "invalid_entity" };
  const r = raw as Record<string, unknown>;
  const name = text(r.name, 80); if (!name) return { error: "name_required" };
  if (!KINDS.includes(r.kind as never)) return { error: "invalid_kind" };
  const kind = r.kind as EntityKind, d = entityDefaults(kind);
  const country = r.country === "US" || r.country === "CA" ? r.country : d.country;
  const currency = typeof r.currency === "string" && /^[A-Za-z]{3}$/.test(r.currency) ? r.currency.toUpperCase() : d.currency;
  const month = Number(r.fiscal_year_end_month ?? 12);
  if (!Number.isInteger(month) || month < 1 || month > 12) return { error: "invalid_month" };
  const basis = r.basis === "ACCRUAL" || r.basis === "CASH" ? r.basis : (d.basis as "CASH" | "ACCRUAL");
  return { entity: { name, kind, country, province: text(r.province, 3)?.toUpperCase() ?? null, currency, fiscal_year_end_month: month, basis, sales_tax_registered: r.sales_tax_registered === true || r.sales_tax_registered === 1, tax_number: text(r.tax_number, 40) } };
}

export interface Line { account_id: number; debit: number; credit: number; memo: string | null } // cents
export interface AccountLite { id: number; entity_id: number; type: AccType; subtype: string; archived: number }

/** A journal entry as typed: a date, a memo and at least two lines that balance. Each line has a debit or a credit, in accounts of that entity. */
export function cleanEntry(raw: unknown, entityId: number, accounts: Map<number, AccountLite>): { entry: { date: string; memo: string; source: "MANUAL" | "OPENING"; lines: Line[] } } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "invalid_entry" };
  const r = raw as Record<string, unknown>;
  const date = day(r.date); if (!date) return { error: "date_required" };
  const rawLines = Array.isArray(r.lines) ? r.lines : [];
  if (rawLines.length > 100) return { error: "too_many_lines" };
  const lines: Line[] = [];
  for (const l of rawLines as Record<string, unknown>[]) {
    if (!l || typeof l !== "object") return { error: "invalid_line" };
    const debit = l.debit === undefined || l.debit === "" || l.debit === null ? 0 : toCents(l.debit);
    const credit = l.credit === undefined || l.credit === "" || l.credit === null ? 0 : toCents(l.credit);
    if (debit === null || credit === null) return { error: "invalid_amount" };
    if (debit === 0 && credit === 0) continue;               // an empty line is dropped
    if (debit > 0 && credit > 0) return { error: "debit_and_credit" };
    const a = accounts.get(Number(l.account_id));
    if (!a || a.entity_id !== entityId || a.archived === 1) return { error: "unknown_account" };
    if (a.subtype === "GROUP") return { error: "group_account" };
    lines.push({ account_id: a.id, debit, credit, memo: text(l.memo, 120) });
  }
  if (lines.length < 2) return { error: "two_lines_needed" };
  const d = lines.reduce((s, l) => s + l.debit, 0), c = lines.reduce((s, l) => s + l.credit, 0);
  if (d !== c) return { error: "unbalanced" };
  return { entry: { date, memo: text(r.memo, 200) ?? "", source: r.source === "OPENING" ? "OPENING" : "MANUAL", lines } };
}

/** The balance of an account as it is normally shown: debit-natured accounts (assets, expenses) grow with debits, the others with credits. */
export const naturalBalance = (type: AccType, debit: number, credit: number): number => (type === "ASSET" || type === "EXPENSE" ? debit - credit : credit - debit);

export interface TrialRow { id: number; code: string; name: string; type: AccType; debit: number; credit: number; balance: number }
/** Trial balance: totals of debits and credits must be equal. */
export function trialTotals(rows: { debit: number; credit: number }[]): { debit: number; credit: number; balanced: boolean } {
  const debit = rows.reduce((s, r) => s + r.debit, 0), credit = rows.reduce((s, r) => s + r.credit, 0);
  return { debit, credit, balanced: debit === credit };
}

/** Creates the chart of accounts of an entity from the template of its kind (accounts already there are kept). */
export async function ensureChart(db: D1Database, entityId: number): Promise<void> {
  const e = await db.prepare("SELECT kind, country FROM acc_entities WHERE id = ?").bind(entityId).first<{ kind: EntityKind; country: string }>();
  if (!e) return;
  const have = new Map((await db.prepare("SELECT id, code, template_code FROM acc_accounts WHERE entity_id = ?").bind(entityId).all<{ id: number; code: string; template_code: string | null }>()).results.map((a) => [a.template_code ?? a.code, a.id]));
  const chart = chartFor(e.kind, e.country);
  const missing = chart.filter((a) => !have.has(a.code));
  const stmts = missing.map((a, i) => db.prepare("INSERT INTO acc_accounts (entity_id, code, template_code, name, name_fr, type, subtype, tax_line, gifi, deductible_pct, is_system, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(entityId, a.code, a.code, a.en, a.fr, a.type, a.subtype, a.taxLine ?? null, usesGifi(e.kind, e.country) ? suggestGifi(e.kind, { code: a.code, name: a.en, type: a.type, subtype: a.subtype }) : null, a.deductiblePct ?? 100, a.system ? 1 : 0, i));
  for (let k = 0; k < stmts.length; k += 50) await db.batch(stmts.slice(k, k + 50));
  // second level: link the accounts that sit under another one
  const ids = new Map((await db.prepare("SELECT id, code, template_code FROM acc_accounts WHERE entity_id = ?").bind(entityId).all<{ id: number; code: string; template_code: string | null }>()).results.map((a) => [a.template_code ?? a.code, a.id]));
  const links = chart.filter((a) => a.parent && ids.has(a.code) && ids.has(a.parent)).map((a) => db.prepare("UPDATE acc_accounts SET parent_id = ? WHERE id = ? AND parent_id IS NULL").bind(ids.get(a.parent!)!, ids.get(a.code)!));
  for (let k = 0; k < links.length; k += 50) await db.batch(links.slice(k, k + 50));
}
