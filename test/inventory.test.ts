import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanInv, parseInv, cleanParts, partsTotal, partsWeight } from "../src/inventory.ts";

const boxes = cleanInv({ base_unit: "boîte", pack_unit: "liasse", pack_qty: "10", family: " Boîtes à pizza " });
test("cleanInv keeps what is filled in and drops the rest", () => {
  assert.deepEqual(boxes, { family: "Boîtes à pizza", base_unit: "boîte", pack_unit: "liasse", pack_qty: 10, pack_weight: null, unit_weight: null, min_qty: null, pack_cost: null, sku: null });
  assert.equal(cleanInv({}), null); assert.equal(cleanInv(null), null); assert.equal(cleanInv({ pack_qty: -2, base_unit: "  " }), null);
  assert.equal(parseInv("not json"), null);
});
test("a package without a size is dropped", () => assert.equal(cleanInv({ pack_unit: "caisse", base_unit: "sac" })?.pack_unit, null));
test("3 bundles of 10 + 40 boxes = 70 boxes", () => assert.equal(partsTotal([{ q: 3, u: "pack" }, { q: 40, u: "unit" }], boxes), 70));
test("1 case of 24 bottles + 6 bottles = 30; 1 case of Linguine (12 bags) + 12 bags = 24", () => {
  const beer = cleanInv({ base_unit: "bouteille", pack_unit: "caisse", pack_qty: 24 }), pasta = cleanInv({ base_unit: "sac", pack_unit: "caisse", pack_qty: 12 });
  assert.equal(partsTotal([{ q: 1, u: "pack" }, { q: 6, u: "unit" }], beer), 30);
  assert.equal(partsTotal([{ q: 1, u: "pack" }, { q: 12, u: "unit" }], pasta), 24);
});
test("another unit is kept but not added; without a spec a package counts as one", () => {
  assert.equal(partsTotal([{ q: 2, u: "other", label: "palette" }, { q: 5, u: "unit" }], boxes), 5);
  assert.equal(partsTotal([{ q: 2, u: "pack" }], null), 2);
});
test("cleanParts refuses bad lists and rounds", () => {
  assert.equal(cleanParts([]), null); assert.equal(cleanParts("x"), null); assert.equal(cleanParts([{ q: -1, u: "unit" }]), null); assert.equal(cleanParts(Array(9).fill({ q: 1, u: "unit" })), null);
  assert.deepEqual(cleanParts([{ q: 1.23456, u: "weird" }, { q: 2, u: "other", label: " palette " }]), [{ q: 1.235, u: "unit" }, { q: 2, u: "other", label: "palette" }]);
});
test("weight comes from the package weight or the unit weight", () => {
  const flour = cleanInv({ base_unit: "sac", pack_unit: "caisse", pack_qty: 4, pack_weight: 40 });
  assert.equal(partsWeight([{ q: 2, u: "pack" }, { q: 3, u: "unit" }], flour), 110);
  assert.equal(partsWeight([{ q: 1, u: "unit" }], boxes), null);
  assert.equal(partsWeight([{ q: 2, u: "unit" }], cleanInv({ base_unit: "sac", unit_weight: 2.5 })), 5);
});
