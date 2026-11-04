import { test } from "node:test";
import assert from "node:assert/strict";
import { offerCost, compareOffers } from "../public/pricing.js";

test("a price per package becomes a price per kg and per usable kg", () => {
  const c = offerCost({ price: 30, pack_qty: 12, pack_weight: 6, yield_pct: 80 })!;
  assert.equal(c.perUnit, 2.5); assert.equal(c.perKg, 5); assert.equal(c.usableKg, 4.8); assert.equal(c.totalPerUsableKg, 6.25);
  assert.equal(offerCost({ price: 0 }), null); assert.equal(offerCost({}), null);
});
test("preparing at the restaurant adds the labour to the price", () => {
  const c = offerCost({ price: 20, pack_weight: 5, prep_min: 30 }, 24)!;     // 30 min at $24/h = $12
  assert.equal(c.prepCost, 12); assert.equal(c.total, 32); assert.equal(c.totalPerUsableKg, 6.4);
  assert.equal(offerCost({ price: 20, pack_weight: 5, prep_min: 30 }, null)!.prepCost, 0);
});
test("romaine: ready cut at Duval vs whole at Bourassa (cheaper per case, but trimmed and to be cut)", () => {
  const r = compareOffers([
    { id: 1, name: "Duval", price: 36, pack_weight: 4, yield_pct: 100, prep: null },                 // cut, ready to use
    { id: 2, name: "Bourassa", price: 28, pack_weight: 6, yield_pct: 65, prep_min: 25, prep: "Couper" }, // whole heads
  ], 24);
  assert.equal(r.basis, "kg");
  assert.deepEqual(r.rows.map((x) => x.value), [9, 9.74]);    // Duval 36/4 ; Bourassa (28 + 10) / (6 x 0.65) = 9.74
  assert.deepEqual(r.rows.map((x) => x.best), [true, false]);
  // without counting the labour the whole heads look cheaper
  assert.deepEqual(compareOffers([{ id: 1, name: "D", price: 36, pack_weight: 4 }, { id: 2, name: "B", price: 28, pack_weight: 6, yield_pct: 65 }], 0).rows.map((x) => x.best), [false, true]);
});
test("basis falls back to the unit, then to the package price", () => {
  assert.equal(compareOffers([{ id: 1, name: "A", price: 10, pack_qty: 4 }, { id: 2, name: "B", price: 9, pack_qty: 3 }]).basis, "unit");
  const p = compareOffers([{ id: 1, name: "A", price: 10 }, { id: 2, name: "B", price: 9 }]);
  assert.equal(p.basis, "pack"); assert.deepEqual(p.rows.map((x) => x.best), [false, true]);
  assert.equal(compareOffers([{ id: 1, name: "A", price: 10 }]).rows[0].best, false);   // a single offer is not "the best"
});
