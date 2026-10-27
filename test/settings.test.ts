import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSettings, validateSettingsPatch, DEFAULT_SETTINGS } from "../src/settings.ts";

test("missing settings fall back to the defaults", () => {
  assert.deepEqual(parseSettings([]), DEFAULT_SETTINGS);
});

test("stored values are read back with the right types", () => {
  const s = parseSettings([{ key: "overtime_hours", value: "44" }, { key: "sick_timeout_minutes", value: "15" }, { key: "replacement_allow_overtime", value: "true" }]);
  assert.deepEqual(s, { overtime_hours: 44, sick_timeout_minutes: 15, replacement_allow_overtime: true });
});

test("garbage or out-of-range stored values do not break things", () => {
  const s = parseSettings([{ key: "overtime_hours", value: "abc" }, { key: "sick_timeout_minutes", value: "-5" }, { key: "replacement_allow_overtime", value: "yes" }]);
  assert.deepEqual(s, DEFAULT_SETTINGS);
});

test("patch validation accepts good values and rejects everything else", () => {
  assert.deepEqual(validateSettingsPatch({ overtime_hours: 40, replacement_allow_overtime: true }), { overtime_hours: "40", replacement_allow_overtime: "true" });
  assert.equal(validateSettingsPatch({ overtime_hours: 0 }), null);
  assert.equal(validateSettingsPatch({ overtime_hours: "40" }), null);
  assert.equal(validateSettingsPatch({ sick_timeout_minutes: 5000 }), null);
  assert.equal(validateSettingsPatch({ replacement_allow_overtime: "true" }), null);
  assert.equal(validateSettingsPatch({ hacker: 1 }), null);
  assert.equal(validateSettingsPatch(null), null);
});
