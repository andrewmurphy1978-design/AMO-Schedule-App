import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrand, validateBrandPatch, senderAddress, darken, DEFAULT_BRAND } from "../src/brand.ts";

test("defaults when nothing is stored; stored values override", () => {
  assert.deepEqual(parseBrand([]), DEFAULT_BRAND);
  const b = parseBrand([{ key: "brand_name", value: "Pizzeria Roma" }, { key: "brand_color", value: "#00AA00" }, { key: "brand_logo_type", value: "image/png" }, { key: "brand_logo_v", value: "5" }, { key: "brand_title_fr", value: "Bienvenue" }]);
  assert.equal(b.name, "Pizzeria Roma"); assert.equal(b.color, "#00aa00"); assert.ok(b.logo); assert.equal(b.logo_v, 5); assert.equal(b.title_fr, "Bienvenue");
});

test("patch validation", () => {
  assert.deepEqual(validateBrandPatch({ name: "  Roma ", color: "#ABCDEF" }), { values: { brand_name: "Roma", brand_color: "#abcdef" } });
  assert.deepEqual(validateBrandPatch({ name: "" }), { error: "name_required" });
  assert.deepEqual(validateBrandPatch({ color: "red" }), { error: "invalid_color" });
  assert.deepEqual(validateBrandPatch({ sender_name: "a\nb" }), { error: "invalid:sender_name" });
  assert.deepEqual(validateBrandPatch({ intro_fr: "x".repeat(301) }), { error: "too_long:intro_fr" });
});

test("sender address and colour darkening", () => {
  assert.equal(senderAddress("no-reply@x.com", "Horaires Roma"), "Horaires Roma <no-reply@x.com>");
  assert.equal(senderAddress("no-reply@x.com", ""), "no-reply@x.com");
  assert.equal(senderAddress("Me <a@b.c>", "Other"), "Me <a@b.c>");
  assert.equal(senderAddress("a@b.c", 'Ev"il<>'), "Evil <a@b.c>");
  assert.equal(darken("#ffffff", 0.5), "#808080");
});
