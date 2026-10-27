import { test } from "node:test";
import assert from "node:assert/strict";
import { overlaps, findOverlaps } from "../src/conflicts.ts";
import { weekBounds, isMonday } from "../src/week.ts";

const s = (a: string, b: string) => ({ start_at: a, end_at: b });

test("overlapping shifts clash", () => {
  assert.equal(overlaps(s("2026-11-02T11:00", "2026-11-02T17:00"), s("2026-11-02T15:00", "2026-11-02T19:00")), true);
});

test("back-to-back shifts do not clash", () => {
  assert.equal(overlaps(s("2026-11-02T11:00", "2026-11-02T17:00"), s("2026-11-02T17:00", "2026-11-02T22:00")), false);
});

test("findOverlaps filters", () => {
  const existing = [s("2026-11-02T08:00", "2026-11-02T10:00"), s("2026-11-02T16:00", "2026-11-02T20:00")];
  assert.equal(findOverlaps(s("2026-11-02T15:00", "2026-11-02T18:00"), existing).length, 1);
});

test("weeks start on Monday", () => {
  assert.equal(isMonday("2026-11-02"), true);
  assert.equal(isMonday("2026-11-03"), false);
  assert.equal(isMonday("2026-02-30"), false);
  assert.deepEqual(weekBounds("2026-11-02"), { start: "2026-11-02T00:00", end: "2026-11-09T00:00" });
  assert.equal(weekBounds("2026-11-03"), null);
});
