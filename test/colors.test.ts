import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore plain JS module shared with the browser
import { defaultColor, staffColor, textOn, contrast, PALETTE } from "../public/colors.js";

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

test("every pair of palette colours is clearly different (Lab distance)", () => {
  const lab = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    const x = (0.4124 * c[0] + 0.3576 * c[1] + 0.1805 * c[2]) / 0.95047, y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], z = (0.0193 * c[0] + 0.1192 * c[1] + 0.9505 * c[2]) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  for (let i = 0; i < PALETTE.length; i++) for (let j = i + 1; j < PALETTE.length; j++) {
    const a = lab(PALETTE[i]), b = lab(PALETTE[j]);
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) >= 25, `${PALETTE[i]} vs ${PALETTE[j]}`);
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

test("palette colours are clearly different from each other and follow employee rank", async () => {
  // @ts-ignore plain JS module shared with the browser
  const { setStaffOrder } = await import("../public/colors.js");
  assert.equal(new Set(PALETTE).size, PALETTE.length);
  setStaffOrder([40, 10, 25]);
  assert.equal(defaultColor(10), PALETTE[0]);
  assert.equal(defaultColor(25), PALETTE[1]);
  assert.equal(defaultColor(40), PALETTE[2]);
  setStaffOrder([]);
});
