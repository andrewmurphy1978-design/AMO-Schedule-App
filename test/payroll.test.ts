import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCosts, parseRate } from "../src/payroll.ts";

const WEEK = ["2026-10-26", "2026-10-27", "2026-10-28"];
const shift = (a: string, b: string, rate: number | null) => ({ start_at: a, end_at: b, rate_cents: rate });

test("a 6-hour shift at $20/h costs $120 that day and nothing else", () => {
  const r = computeCosts([shift("2026-10-26T08:00", "2026-10-26T14:00", 2000)], WEEK);
  assert.equal(r.days[0].cents, 12000);
  assert.equal(r.days[0].hours, 6);
  assert.equal(r.days[1].cents, 0);
  assert.equal(r.total_cents, 12000);
});

test("cost per clock hour adds up with overlapping staff", () => {
  const r = computeCosts([shift("2026-10-26T08:00", "2026-10-26T12:00", 2000), shift("2026-10-26T10:00", "2026-10-26T14:00", 1500)], WEEK);
  const h = r.days[0].by_hour;
  assert.equal(h[8], 2000);
  assert.equal(h[10], 3500); // both working
  assert.equal(h[13], 1500);
  assert.equal(h[14], 0);
  assert.equal(r.days[0].cents, 4 * 2000 + 4 * 1500);
});

test("half-hour start/end is prorated", () => {
  const r = computeCosts([shift("2026-10-26T06:30", "2026-10-26T07:30", 2000)], WEEK);
  assert.equal(r.days[0].by_hour[6], 1000);
  assert.equal(r.days[0].by_hour[7], 1000);
  assert.equal(r.total_cents, 2000);
});

test("an overnight shift is split across the two days", () => {
  const r = computeCosts([shift("2026-10-26T22:00", "2026-10-27T02:00", 1800)], WEEK);
  assert.equal(r.days[0].cents, 2 * 1800);
  assert.equal(r.days[1].cents, 2 * 1800);
  assert.equal(r.days[0].hours, 2);
  assert.equal(r.days[1].hours, 2);
});

test("shifts without a rate are not priced but their hours are reported", () => {
  const r = computeCosts([shift("2026-10-26T08:00", "2026-10-26T12:00", null), shift("2026-10-26T08:00", "2026-10-26T10:00", 1000)], WEEK);
  assert.equal(r.total_cents, 2000);
  assert.equal(r.unrated_hours, 4);
  assert.equal(r.total_hours, 6);
});

test("shifts outside the requested days are ignored", () => {
  const r = computeCosts([shift("2026-11-05T08:00", "2026-11-05T14:00", 2000)], WEEK);
  assert.equal(r.total_cents, 0);
  assert.equal(r.total_hours, 0);
});

test("parseRate accepts common ways of typing a wage", () => {
  assert.equal(parseRate("16.5"), 1650);
  assert.equal(parseRate("16,50"), 1650);
  assert.equal(parseRate("$ 15.25"), 1525);
  assert.equal(parseRate(18), 1800);
  assert.equal(parseRate(""), null);
  assert.equal(parseRate("abc"), null);
  assert.equal(parseRate("-3"), null);
  assert.equal(parseRate("5000"), null);
});
