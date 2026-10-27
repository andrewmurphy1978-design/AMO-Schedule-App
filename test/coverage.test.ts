import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore plain JS module shared with the browser
import { DEFAULT_BOUNDARIES, periodWindows, remapPeriods, validBoundaries, resolveTargets, targetWindows, targetAt, coverage, shortages, surpluses, shiftSpan, toMin } from "../public/coverage.js";

const sh = (a: string, b: string) => ({ start_at: a, end_at: b });
const DAY = "2026-10-27";

test("override wins slot by slot, default fills the rest", () => {
  const rows = [
    { dow: -1, slot: "06:30", count: 2 }, { dow: -1, slot: "11:00", count: 4 },
    { dow: 1, slot: "11:00", count: 6 },
  ];
  assert.deepEqual(resolveTargets(rows, 1), { "06:30": 2, "11:00": 6 });
  assert.deepEqual(resolveTargets(rows, 3), { "06:30": 2, "11:00": 4 });
});

test("periods run from opening to the first boundary, boundary to boundary, and the last one to closing", () => {
  const t = { open: 2, "08:00": 3, "09:00": 3, "11:00": 5, "12:00": 6, "14:00": 3, "17:00": 4, "20:00": 2 };
  const wins = targetWindows(t, toMin("06:30"), toMin("22:00"));
  assert.equal(targetAt(wins, toMin("06:29")), undefined);
  assert.equal(targetAt(wins, toMin("06:30")), 2);
  assert.equal(targetAt(wins, toMin("07:59")), 2);
  assert.equal(targetAt(wins, toMin("11:30")), 5);
  assert.equal(targetAt(wins, toMin("12:00")), 6);
  assert.equal(targetAt(wins, toMin("16:59")), 3);
  assert.equal(targetAt(wins, toMin("19:59")), 4);
  assert.equal(targetAt(wins, toMin("21:59")), 2);
  assert.equal(targetAt(wins, toMin("22:00")), undefined);
});

test("periods are clipped to the opening hours of the day", () => {
  // opens at 11:00: the open period starts at 11:00 and the earlier periods disappear
  const w = periodWindows(DEFAULT_BOUNDARIES, toMin("11:00"), toMin("21:00"));
  assert.deepEqual(w.map((x: any) => [x.key, x.from / 60, x.to / 60]), [["11:00", 11, 12], ["12:00", 12, 14], ["14:00", 14, 17], ["17:00", 17, 20], ["20:00", 20, 21]]);
  // opens at 11:00 and the first period "open" lasts until 11:00 -> dropped; closes before the last boundary
  assert.deepEqual(periodWindows(DEFAULT_BOUNDARIES, toMin("07:00"), toMin("19:00")).map((x: any) => x.key), ["open", "08:00", "09:00", "11:00", "12:00", "14:00", "17:00"]);
});

test("changing boundaries keeps the values of the old period that covered each new period's start", () => {
  const old = { open: 1, "08:00": 2, "09:00": 3, "11:00": 4, "12:00": 4, "14:00": 2, "17:00": 5, "20:00": 3 };
  assert.deepEqual(remapPeriods(DEFAULT_BOUNDARIES, ["10:00", "15:00", "20:00"], old), { open: 1, "10:00": 3, "15:00": 2, "20:00": 3 });
  assert.deepEqual(remapPeriods(["09:00"], DEFAULT_BOUNDARIES, { open: 1, "09:00": 5 }).open, 1);
});

test("boundary lists must be 1-10 increasing times", () => {
  assert.equal(validBoundaries(["08:00", "09:00"]), true);
  assert.equal(validBoundaries([]), false);
  assert.equal(validBoundaries(["09:00", "08:00"]), false);
  assert.equal(validBoundaries(["8:00"]), false);
});

test("coverage counts people working at each half hour (end exclusive)", () => {
  const shifts = [sh(`${DAY}T08:00`, `${DAY}T14:00`), sh(`${DAY}T11:00`, `${DAY}T19:00`)];
  const b = coverage(shifts, DAY, toMin("07:30"), toMin("19:30"));
  const at = (hhmm: string) => b.find((x: any) => x.t === toMin(hhmm)).count;
  assert.equal(at("07:30"), 0);
  assert.equal(at("08:00"), 1);
  assert.equal(at("11:00"), 2);
  assert.equal(at("14:00"), 1);
  assert.equal(at("19:00"), 0);
});

test("overnight shift counts after midnight and on the following day", () => {
  const s = sh("2026-10-26T17:00", "2026-10-27T01:00");
  assert.deepEqual(shiftSpan(s, "2026-10-26"), { s: 1020, e: 1500 });
  assert.deepEqual(shiftSpan(s, "2026-10-27"), { s: -420, e: 60 });
});

test("shortages report contiguous gaps with the worst shortfall", () => {
  const wins = targetWindows({ "11:00": 3, "14:00": 2 }, toMin("06:30"), toMin("22:00"), ["11:00", "14:00"]);
  const shifts = [sh(`${DAY}T11:00`, `${DAY}T13:00`), sh(`${DAY}T11:00`, `${DAY}T16:00`)];
  const runs = shortages(coverage(shifts, DAY, toMin("11:00"), toMin("17:00")), wins);
  // 11:00-13:00 short by 1, 13:00-14:00 short by 2, 14:00-16:00 short by 1, 16:00-17:00 short by 2 (nobody left): one continuous run, worst gap 2
  assert.deepEqual(runs, [{ from: toMin("11:00"), to: toMin("17:00"), missing: 2 }]);
});

test("shifts on other days never count toward this day", () => {
  const friday = sh("2026-10-30T08:00", "2026-10-30T14:00");
  const wed = "2026-10-28";
  const span = shiftSpan(friday, wed);
  assert.ok(span.s >= 1440, "starts after the day ends");
  assert.equal(coverage([friday], wed, toMin("06:00"), toMin("22:00")).reduce((n: number, b: any) => n + b.count, 0), 0);
  const prev = sh("2026-10-27T08:00", "2026-10-27T14:00");
  assert.ok(shiftSpan(prev, wed).e <= 0, "ended before the day started");
});

test("surpluses are reported like shortages, with the worst excess", () => {
  const wins = targetWindows({ "11:00": 1, "14:00": 2 }, toMin("06:30"), toMin("22:00"), ["11:00", "14:00"]);
  const shifts = [sh(`${DAY}T11:00`, `${DAY}T15:00`), sh(`${DAY}T12:00`, `${DAY}T13:00`), sh(`${DAY}T12:00`, `${DAY}T13:30`), sh(`${DAY}T14:00`, `${DAY}T15:00`)];
  const buckets = coverage(shifts, DAY, toMin("11:00"), toMin("16:00"));
  // 12:00-13:00 has 3 people for a target of 1 (+2); 13:00-13:30 has 2 for 1 (+1): one run, worst excess 2
  assert.deepEqual(surpluses(buckets, wins), [{ from: toMin("12:00"), to: toMin("13:30"), missing: 2 }]);
  // 14:00-15:00 has 2 for a target of 2 (met) and 15:00-16:00 has 0 (short by 2)
  assert.deepEqual(shortages(buckets, wins), [{ from: toMin("15:00"), to: toMin("16:00"), missing: 2 }]);
});

test("no target means neither a shortage nor a surplus", () => {
  const buckets = coverage([sh(`${DAY}T11:00`, `${DAY}T15:00`)], DAY, toMin("11:00"), toMin("15:00"));
  assert.deepEqual(surpluses(buckets, []), []);
  assert.deepEqual(shortages(buckets, []), []);
});
