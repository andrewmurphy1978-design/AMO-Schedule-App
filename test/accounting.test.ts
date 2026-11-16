import { test } from "node:test";
import assert from "node:assert/strict";
import { toCents, cleanEntity, cleanEntry, naturalBalance, trialTotals, type AccountLite } from "../src/accounting.ts";
import { chartFor } from "../src/accounting-charts.ts";

const acc = (id: number, entity_id = 1, subtype = "OTHER", archived = 0): [number, AccountLite] => [id, { id, entity_id, type: "ASSET", subtype, archived }];
const accounts = new Map<number, AccountLite>([acc(1), acc(2), acc(3, 2), acc(4, 1, "GROUP"), acc(5, 1, "OTHER", 1)]);

test("amounts become whole cents", () => {
  assert.equal(toCents("12,50"), 1250); assert.equal(toCents(12.5), 1250); assert.equal(toCents("1 234.56"), 123456); assert.equal(toCents("0.1"), 10);
  assert.equal(toCents("12.345"), null); assert.equal(toCents("-1"), null); assert.equal(toCents("abc"), null); assert.equal(toCents(""), 0);
});
test("an entity gets the defaults of its kind", () => {
  const r = cleanEntity({ name: " Mikes ", kind: "LLC" }); assert.ok("entity" in r); if (!("entity" in r)) return;
  assert.equal(r.entity.name, "Mikes"); assert.equal(r.entity.country, "US"); assert.equal(r.entity.currency, "USD");
  const c = cleanEntity({ name: "Inc.", kind: "CORPORATION", province: "qc" }); assert.ok("entity" in c); if ("entity" in c) { assert.equal(c.entity.basis, "ACCRUAL"); assert.equal(c.entity.province, "QC"); assert.equal(c.entity.currency, "CAD"); }
  assert.deepEqual(cleanEntity({ kind: "PERSONAL" }), { error: "name_required" }); assert.deepEqual(cleanEntity({ name: "x", kind: "NOPE" }), { error: "invalid_kind" });
  assert.deepEqual(cleanEntity({ name: "x", kind: "PERSONAL", fiscal_year_end_month: 13 }), { error: "invalid_month" }); assert.deepEqual(cleanEntity(null), { error: "invalid_entity" });
});
test("an entry must balance", () => {
  const ok = cleanEntry({ date: "2026-11-16", memo: " Dépôt ", lines: [{ account_id: 1, debit: "100,00" }, { account_id: 2, credit: 100 }, { account_id: 1, debit: "", credit: "" }] }, 1, accounts);
  assert.ok("entry" in ok); if ("entry" in ok) { assert.equal(ok.entry.lines.length, 2); assert.equal(ok.entry.lines[0].debit, 10000); assert.equal(ok.entry.memo, "Dépôt"); assert.equal(ok.entry.source, "MANUAL"); }
  assert.deepEqual(cleanEntry({ date: "2026-11-16", lines: [{ account_id: 1, debit: 100 }, { account_id: 2, credit: 99.99 }] }, 1, accounts), { error: "unbalanced" });
  assert.deepEqual(cleanEntry({ date: "2026-11-16", lines: [{ account_id: 1, debit: 100 }] }, 1, accounts), { error: "two_lines_needed" });
  assert.deepEqual(cleanEntry({ lines: [] }, 1, accounts), { error: "date_required" });
  assert.deepEqual(cleanEntry({ date: "2026-11-16", lines: [{ account_id: 1, debit: 5, credit: 5 }, { account_id: 2, credit: 5 }] }, 1, accounts), { error: "debit_and_credit" });
  assert.deepEqual(cleanEntry({ date: "2026-11-16", lines: [{ account_id: 1, debit: 5 }, { account_id: 3, credit: 5 }] }, 1, accounts), { error: "unknown_account" }); // another entity's account
  assert.deepEqual(cleanEntry({ date: "2026-11-16", lines: [{ account_id: 1, debit: 5 }, { account_id: 5, credit: 5 }] }, 1, accounts), { error: "unknown_account" }); // archived
  assert.deepEqual(cleanEntry({ date: "2026-11-16", lines: [{ account_id: 1, debit: 5 }, { account_id: 4, credit: 5 }] }, 1, accounts), { error: "group_account" });
  assert.deepEqual(cleanEntry({ date: "2026-11-16", lines: [{ account_id: 1, debit: "x" }, { account_id: 2, credit: 5 }] }, 1, accounts), { error: "invalid_amount" });
  const o = cleanEntry({ date: "2026-01-01", source: "OPENING", lines: [{ account_id: 1, debit: 1 }, { account_id: 2, credit: 1 }] }, 1, accounts); assert.ok("entry" in o && o.entry.source === "OPENING");
});
test("balances follow the nature of the account", () => {
  assert.equal(naturalBalance("ASSET", 500, 200), 300); assert.equal(naturalBalance("EXPENSE", 100, 0), 100); assert.equal(naturalBalance("INCOME", 0, 700), 700); assert.equal(naturalBalance("LIABILITY", 50, 80), 30);
  assert.deepEqual(trialTotals([{ debit: 5, credit: 0 }, { debit: 0, credit: 5 }]), { debit: 5, credit: 5, balanced: true });
  assert.equal(trialTotals([{ debit: 5, credit: 0 }]).balanced, false);
});
test("every kind of entity has a chart with unique codes and valid parents", () => {
  for (const [kind, country] of [["PERSONAL", "CA"], ["SOLE_PROPRIETORSHIP", "CA"], ["CORPORATION", "CA"], ["LLC", "US"]] as const) {
    const chart = chartFor(kind, country), codes = chart.map((a) => a.code);
    assert.ok(chart.length > 10, kind); assert.equal(new Set(codes).size, codes.length, `${kind} duplicate codes`);
    for (const a of chart) if (a.parent) assert.ok(codes.includes(a.parent), `${kind}: ${a.code} parent`);
  }
});
test("the restaurant chart adds the card, online and cash accounts to a business chart", () => {
  for (const [kind, country] of [["CORPORATION", "CA"], ["SOLE_PROPRIETORSHIP", "CA"]] as const) {
    const chart = chartFor(kind, country, "RESTAURANT"), codes = chart.map((a) => a.code), byName = (n: string) => chart.find((a) => a.fr === n);
    assert.equal(new Set(codes).size, codes.length, `${kind} duplicate codes`);
    for (const n of ["Visa à recevoir", "MasterCard à recevoir", "Débit à recevoir", "En ligne à recevoir"]) assert.ok(byName(n) && byName(n)!.type === "ASSET" && byName(n)!.subtype === "RECEIVABLE", n);
    assert.ok(byName("Comptant (caisse)") && byName("Comptant (caisse)")!.subtype === "BANK");
    assert.ok(codes.includes("2300") && codes.includes("4000")); // the base chart is still there (sales taxes...)
  }
  assert.equal(chartFor("PERSONAL", "CA", "RESTAURANT").length, chartFor("PERSONAL", "CA").length); // a person is never a restaurant
  assert.equal(chartFor("CORPORATION", "CA").length, chartFor("CORPORATION", "CA", null).length);
});
test("only a business can use the restaurant template", () => {
  const ok = (raw: object) => { const r = cleanEntity(raw); return "entity" in r ? r.entity.template : "error"; };
  assert.equal(ok({ name: "Mikes", kind: "CORPORATION", template: "RESTAURANT" }), "RESTAURANT"); assert.equal(ok({ name: "Moi", kind: "PERSONAL", template: "RESTAURANT" }), null); assert.equal(ok({ name: "X", kind: "CORPORATION" }), null);
});
