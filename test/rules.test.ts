import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore plain JS modules shared with the browser
import { easterSunday, nthWeekday, ruleMatches, resolveForDate, SPECIAL_PRESETS, SEASON_PRESETS } from "../public/rules.js";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const preset = (id: string) => SPECIAL_PRESETS.find((p: any) => p.id === id).rule;

test("Easter Sunday for known years", () => {
  assert.equal(iso(easterSunday(2026)), "2026-04-05");
  assert.equal(iso(easterSunday(2027)), "2027-03-28");
  assert.equal(iso(easterSunday(2024)), "2024-03-31");
  assert.equal(iso(easterSunday(2025)), "2025-04-20");
});

test("Mother's Day = 2nd Sunday of May, Father's Day = 3rd Sunday of June", () => {
  assert.equal(iso(nthWeekday(2026, 5, 6, 2)), "2026-05-10");
  assert.equal(iso(nthWeekday(2026, 6, 6, 3)), "2026-06-21");
  assert.equal(iso(nthWeekday(2027, 5, 6, 2)), "2027-05-09");
  assert.equal(iso(nthWeekday(2026, 9, 0, 1)), "2026-09-07"); // Labour Day
  assert.equal(iso(nthWeekday(2026, 5, 0, -1)), "2026-05-25"); // last Monday of May
});

test("special day rules match exactly their days", () => {
  assert.ok(ruleMatches(preset("mothers"), "2026-05-10"));
  assert.ok(!ruleMatches(preset("mothers"), "2026-05-17"));
  assert.ok(ruleMatches(preset("xmas"), "2026-12-25") && !ruleMatches(preset("xmas"), "2026-12-26"));
  // Easter weekend 2026 = Fri 3 Apr .. Mon 6 Apr
  for (const d of ["2026-04-03", "2026-04-04", "2026-04-05", "2026-04-06"]) assert.ok(ruleMatches(preset("easter"), d), d);
  for (const d of ["2026-04-02", "2026-04-07"]) assert.ok(!ruleMatches(preset("easter"), d), d);
  assert.ok(ruleMatches({ type: "date", date: "2026-12-24" }, "2026-12-24"));
  // multi-day span crossing the new year
  const nye2 = { type: "fixed", md: "12-31", days: 2 };
  assert.ok(ruleMatches(nye2, "2027-01-01") && ruleMatches(nye2, "2026-12-31") && !ruleMatches(nye2, "2027-01-02"));
});

test("seasons repeat yearly and can wrap the new year", () => {
  const holidays = SEASON_PRESETS.find((p: any) => p.id === "holidays").rule;
  for (const d of ["2026-12-20", "2026-12-31", "2027-01-01", "2027-01-05"]) assert.ok(ruleMatches(holidays, d), d);
  for (const d of ["2026-12-19", "2027-01-06"]) assert.ok(!ruleMatches(holidays, d), d);
  const summer = SEASON_PRESETS.find((p: any) => p.id === "summer").rule;
  assert.ok(ruleMatches(summer, "2026-07-15") && ruleMatches(summer, "2031-07-15") && !ruleMatches(summer, "2026-10-15"));
});

test("most specific layer wins, slot by slot", () => {
  const rows = [
    { set_id: 0, dow: -1, slot: "11:00", count: 4 }, { set_id: 0, dow: -1, slot: "17:00", count: 4 }, { set_id: 0, dow: 6, slot: "17:00", count: 5 },
    { set_id: 1, dow: -1, slot: "11:00", count: 6 },                 // summer: busier lunch
    { set_id: 2, dow: -1, slot: "17:00", count: 9 },                 // Mother's Day: big supper
  ];
  const sets = [
    { id: 1, name: "Été", kind: "season", rule: { type: "range", from: "06-21", to: "09-22" } },
    { id: 2, name: "Fête des Mères", kind: "special", rule: preset("mothers") },
  ];
  // ordinary Tuesday in October: base only
  assert.deepEqual(resolveForDate(rows, sets, "2026-10-13"), { targets: { "11:00": 4, "17:00": 4 }, labels: [] });
  // ordinary Sunday in October: base weekday override for 17:00
  assert.equal(resolveForDate(rows, sets, "2026-10-11").targets["17:00"], 5);
  // Tuesday in July: summer overrides lunch only
  assert.deepEqual(resolveForDate(rows, sets, "2026-07-14"), { targets: { "11:00": 6, "17:00": 4 }, labels: ["Été"] });
  // Mother's Day (a Sunday in May, spring): special overrides supper, base keeps lunch
  assert.deepEqual(resolveForDate(rows, sets, "2026-05-10"), { targets: { "11:00": 4, "17:00": 9 }, labels: ["Fête des Mères"] });
  // a special day inside a season: both apply, special wins
  const both = [...sets, { id: 3, name: "Fête du Canada", kind: "special", rule: preset("canada") }];
  const r = resolveForDate([...rows, { set_id: 3, dow: -1, slot: "11:00", count: 8 }], both, "2026-07-01");
  assert.deepEqual(r, { targets: { "11:00": 8, "17:00": 4 }, labels: ["Été", "Fête du Canada"] });
});
