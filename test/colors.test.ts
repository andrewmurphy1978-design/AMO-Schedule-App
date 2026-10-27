import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore plain JS module shared with the browser
import { defaultColor, staffColor, textOn, contrast } from "../public/colors.js";

test("automatic colours are valid hex, stable, and distinct for the first 60 employees", () => {
  const seen = new Set<string>();
  for (let id = 1; id <= 60; id++) {
    const c = defaultColor(id);
    assert.match(c, /^#[0-9a-f]{6}$/);
    assert.equal(c, defaultColor(id));
    seen.add(c);
  }
  assert.equal(seen.size, 60);
});

test("neighbouring ids get clearly different hues", () => {
  const hue = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    const h = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  for (let id = 1; id < 40; id++) {
    const diff = Math.abs(hue(defaultColor(id)) - hue(defaultColor(id + 1)));
    assert.ok(Math.min(diff, 360 - diff) > 40, `ids ${id} and ${id + 1} too similar`);
  }
});

test("text colour is always readable (contrast >= 4.5) on automatic and swatch colours", () => {
  for (let id = 1; id <= 60; id++) {
    const bg = defaultColor(id);
    assert.ok(contrast(bg, textOn(bg)) >= 4.5, `${bg}: ${contrast(bg, textOn(bg)).toFixed(2)}`);
  }
  assert.equal(textOn("#ffffff"), "#1f1f23");
  assert.equal(textOn("#000000"), "#ffffff");
});

test("a chosen colour overrides the automatic one", () => {
  assert.equal(staffColor(7, "#123456"), "#123456");
  assert.equal(staffColor(7, null), defaultColor(7));
});
