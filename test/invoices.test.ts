import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInvoice, compareInvoice, similarity, type CatalogItem, type InvoiceLine } from "../src/invoices.ts";

test("parseInvoice reads the JSON inside the answer and cleans it", () => {
  const inv = parseInvoice('Voici : {"invoice_number": 4521, "invoice_date": "2026-11-03", "total": "1 234,50", "lines": [{"code": 100, "description": " Tomates ", "qty": "2", "unit": "caisse", "unit_price": "31,50", "line_total": 63}, {"description": ""}, {"description": "Fromage"}]}')!;
  assert.equal(inv.invoice_number, "4521"); assert.equal(inv.invoice_date, "2026-11-03"); assert.equal(inv.lines.length, 2);
  assert.deepEqual(inv.lines[0], { code: "100", description: "Tomates", qty: 2, unit: "caisse", unit_price: 31.5, line_total: 63 });
  assert.equal(parseInvoice("no json"), null); assert.equal(parseInvoice('{"lines": 3}'), null);
});
test("similarity: accents, case and word order do not matter", () => {
  assert.ok(similarity("Sauce tomate", "SAUCE TOMATE 2.5L") >= 0.6);
  assert.ok(similarity("Tomates", "Fromage mozzarella") < 0.3);
});
const cat: CatalogItem[] = [
  { name: "Tomates", p: "T-100", alt: ["T-101"], price: 30, unit: "caisse" },
  { name: "Fromage", p: "F-1", alt: [], price: 50, unit: "kg" },
  { name: "Pepperoni", p: "P-9", alt: [], price: null, unit: null },
];
const L = (o: Partial<InvoiceLine>): InvoiceLine => ({ code: null, description: "x", qty: 1, unit: null, unit_price: null, line_total: null, ...o });
test("compare: received, missing, substitute, extra, unknown and price changes", () => {
  const c = compareInvoice([
    L({ code: "T-101", description: "Tomates rondes", unit_price: 32, unit: "caisse" }),   // a replacement number, new price
    L({ code: "f1", description: "Fromage mozza", unit_price: 50 }),                       // the preferred one (case / dashes ignored), same price
    L({ description: "Sauce tomate 2L" }),                                                  // not in the catalog
    L({ code: "P-9", description: "Pepperoni tranché", unit_price: 12.5, unit: "kg" }),    // not ordered, price was unknown
  ], cat, [{ name: "Tomates", note: null }, { name: "Fromage", note: null }, { name: "Basilic", note: null }]);
  assert.deepEqual(c.rows.map((r) => r.status), ["substitute", "ok", "unknown", "extra"]);
  assert.deepEqual(c.rows.map((r) => r.via), ["alt", "code", null, "code"]);
  assert.deepEqual(c.missing.map((m) => m.name), ["Basilic"]);
  assert.deepEqual(c.price_changes, [{ ingredient: "Tomates", old: 30, new: 32, unit: "caisse" }, { ingredient: "Pepperoni", old: null, new: 12.5, unit: "kg" }]);
});
test("without an order nothing is extra or missing", () => {
  const c = compareInvoice([L({ code: "P-9" })], cat, null);
  assert.equal(c.rows[0].status, "ok"); assert.equal(c.had_order, false); assert.equal(c.missing.length, 0);
});
