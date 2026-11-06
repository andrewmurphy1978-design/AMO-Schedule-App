import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanProduct, usedIn, availability } from "../src/products.ts";

const pizza = { name_fr: " Pizza pepperoni ", category: "Pizzas", formats: [
  { name: "10 po", price: "12,99", ingredients: [{ ingredient: "Fromage", qty: "120", unit: "g" }, { ingredient: "Pepperoni", qty: 40, unit: "g" }, { ingredient: "  " }] },
  { name: "14 po", price: 21.5, ingredients: [{ ingredient: "Fromage", qty: 240, unit: "g" }] }] };
test("a product with formats is cleaned", () => {
  const r = cleanProduct(pizza); assert.ok("product" in r); if (!("product" in r)) return;
  assert.equal(r.product.name_fr, "Pizza pepperoni"); assert.equal(r.product.formats.length, 2);
  assert.equal(r.product.formats[0].price, 12.99); assert.equal(r.product.formats[0].ingredients.length, 2);   // the empty line is dropped
  assert.deepEqual(r.product.formats[0].ingredients[0], { ingredient: "Fromage", qty: 120, unit: "g", note: null, choice: null });
  assert.equal(r.product.active, true); assert.equal(r.product.is_promo, false);
});
test("without a format there is one unnamed format", () => {
  const r = cleanProduct({ name_fr: "Frites" }); assert.ok("product" in r); if ("product" in r) { assert.equal(r.product.formats.length, 1); assert.equal(r.product.formats[0].name, ""); }
});
test("errors", () => {
  assert.deepEqual(cleanProduct({}), { error: "name_required" }); assert.deepEqual(cleanProduct(null), { error: "invalid_product" });
  assert.deepEqual(cleanProduct({ name_fr: "X", formats: [{ name: "A" }, { name: "a" }] }), { error: "duplicate_format" });
  assert.deepEqual(cleanProduct({ name_fr: "X", formats: [{ name: "A", ingredients: [{ ingredient: "Sel" }, { ingredient: "sel" }] }] }), { error: "duplicate_ingredient" });
  assert.deepEqual(cleanProduct({ name_fr: "X", formats: Array.from({ length: 13 }, (_, i) => ({ name: `f${i}` })) }), { error: "too_many_formats" });
});
test("a promotion is sold only during its period", () => {
  const r = cleanProduct({ name_fr: "Combo d'automne", is_promo: true, available_from: "2026-11-01", available_to: "2026-11-30" }); assert.ok("product" in r); if (!("product" in r)) return;
  assert.equal(r.product.is_promo, true); assert.equal(r.product.available_from, "2026-11-01");
  assert.deepEqual(cleanProduct({ name_fr: "X", available_from: "2026-12-01", available_to: "2026-11-01" }), { error: "invalid_period" });
  assert.equal(availability(r.product, "2026-10-31"), "upcoming"); assert.equal(availability(r.product, "2026-11-15"), "current"); assert.equal(availability(r.product, "2026-12-01"), "expired");
  assert.equal(availability({ available_from: null, available_to: null }, "2026-11-15"), "always");
  assert.equal(availability({ available_from: "2026-11-10", available_to: null }, "2026-11-12"), "current");   // open-ended
  const bad = cleanProduct({ name_fr: "X", available_from: "not a date" }); assert.ok("product" in bad); if ("product" in bad) assert.equal(bad.product.available_from, null);
});
test("where an ingredient is used", () => {
  const r = cleanProduct(pizza); if (!("product" in r)) return assert.fail();
  const u = usedIn([r.product]);
  assert.equal(u.get("fromage")?.length, 2); assert.equal(u.get("pepperoni")?.[0].format, "10 po");
});

test("alternatives (OR): a choice needs two options and its lines stay together", () => {
  const r = cleanProduct({ name_fr: "Viande à la carte", formats: [{ name: "", ingredients: [
    { ingredient: "Jambon effiloché", qty: 56, unit: "g", choice: 4 }, { ingredient: "Sel" }, { ingredient: "Saucisses", qty: 2, unit: "unité", choice: 4 }, { ingredient: "Bacon", qty: 2, unit: "tranche", choice: 4 }, { ingredient: "Poivre", choice: 9 }] }] });
  assert.ok("product" in r); if (!("product" in r)) return;
  const l = r.product.formats[0].ingredients;
  assert.deepEqual(l.map((x) => [x.ingredient, x.choice]), [["Jambon effiloché", 1], ["Saucisses", 1], ["Bacon", 1], ["Sel", null], ["Poivre", null]]);   // 4 -> 1, together; a lone choice is a plain ingredient
  assert.equal(l[0].qty, 56);
});
