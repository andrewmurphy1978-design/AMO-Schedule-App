import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanMethods, cleanSettings, deliveryFor, nextWindow, isoDow } from "../src/supplierorders.ts";

test("methods: only the known ones, in a fixed order, no duplicates", () => {
  assert.deepEqual(cleanMethods(["email", "call", "fax", "email", "website"]), ["call", "email", "website"]);
  assert.deepEqual(cleanMethods("call"), []);
});
const s = cleanSettings({ order_days: [4, 1, 1, 9], cutoff: "14:00", delivery_mode: "offset", delivery_offset: 1 })!;
test("settings are cleaned", () => {
  assert.deepEqual(s.order_days, [1, 4]); assert.equal(s.cutoff, "14:00");
  assert.equal(cleanSettings({ cutoff: "25:00" }), null); assert.equal(cleanSettings(null), null);
  assert.equal(cleanSettings({ order_days: [2], delivery_offset: 99 })!.delivery_offset, 1);
});
test("isoDow: Monday is 1, Sunday is 7", () => { assert.equal(isoDow("2026-11-02"), 1); assert.equal(isoDow("2026-11-08"), 7); });
test("delivery the next day, or on the next delivery weekday", () => {
  assert.equal(deliveryFor(s, "2026-11-05"), "2026-11-06");
  const w = cleanSettings({ order_days: [1], delivery_mode: "days", delivery_days: [3, 5] })!;
  assert.equal(deliveryFor(w, "2026-11-02"), "2026-11-04");   // Monday order → Wednesday
  assert.equal(deliveryFor(w, "2026-11-04"), "2026-11-06");   // a Wednesday order does not arrive the same day
  assert.equal(deliveryFor(cleanSettings({ order_days: [1], delivery_mode: "days" })!, "2026-11-02"), null);
});
test("next window: today before the cut-off, else the next order day", () => {
  const thu = nextWindow(s, "2026-11-05T09:30")!;           // Thursday 09:30
  assert.deepEqual([thu.order_date, thu.today, thu.missed_today, thu.delivery_date], ["2026-11-05", true, false, "2026-11-06"]);
  const late = nextWindow(s, "2026-11-05T15:00")!;          // Thursday after 14:00 → Monday
  assert.deepEqual([late.order_date, late.today, late.missed_today], ["2026-11-09", false, true]);
  assert.equal(nextWindow(s, "2026-11-06T10:00")!.order_date, "2026-11-09");
  assert.equal(nextWindow(null, "2026-11-05T10:00"), null);
  assert.equal(nextWindow(cleanSettings({ cutoff: "10:00" }), "2026-11-05T10:00"), null);
});
