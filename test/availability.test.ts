import { test } from "node:test";
import assert from "node:assert/strict";
import { overlapsTimeOff, findUnavailable, dowOf } from "../src/availability.ts";

test("whole-day time off blocks any shift on those days", () => {
  const off = { start_date: "2026-10-30", end_date: "2026-10-31" };
  assert.equal(overlapsTimeOff(off, "2026-10-30T06:30", "2026-10-30T14:00"), true);
  assert.equal(overlapsTimeOff(off, "2026-10-31T17:00", "2026-11-01T01:00"), true);
  assert.equal(overlapsTimeOff(off, "2026-10-29T17:00", "2026-10-30T00:00"), false);
  assert.equal(overlapsTimeOff(off, "2026-11-01T09:00", "2026-11-01T15:00"), false);
});

test("part-day time off only blocks overlapping hours", () => {
  const off = { start_date: "2026-10-30", end_date: "2026-10-30", start_time: "14:00", end_time: "21:00" };
  assert.equal(overlapsTimeOff(off, "2026-10-30T06:30", "2026-10-30T14:00"), false); // ends exactly when the leave starts
  assert.equal(overlapsTimeOff(off, "2026-10-30T09:00", "2026-10-30T15:00"), true);
  assert.equal(overlapsTimeOff(off, "2026-10-30T21:00", "2026-10-30T23:00"), false);
  assert.equal(overlapsTimeOff(off, "2026-10-30T17:00", "2026-10-30T20:00"), true);
});

test("weekly unavailability (school) respects weekday and date range", () => {
  assert.equal(dowOf("2026-10-26"), 0);
  const school = [{ dow: 0, start_time: "08:00", end_time: "15:30", valid_from: "2026-08-25", valid_to: "2026-12-18" }];
  assert.ok(findUnavailable(school, "2026-10-26T14:00", "2026-10-26T18:00")); // Monday during school
  assert.equal(findUnavailable(school, "2026-10-26T16:00", "2026-10-26T20:00"), null); // after school
  assert.equal(findUnavailable(school, "2026-10-27T10:00", "2026-10-27T14:00"), null); // Tuesday
  assert.equal(findUnavailable(school, "2027-01-04T10:00", "2027-01-04T14:00"), null); // next semester
});
