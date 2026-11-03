import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DM, parseDm, validateDm, canStartGroup } from "../src/messaging.ts";

test("by default one writes to the people of one's own restaurant and department; groups are off (up to 20 once allowed)", () => {
  assert.deepEqual(parseDm(null), DEFAULT_DM);
  assert.equal(DEFAULT_DM.scope, "department"); assert.equal(DEFAULT_DM.groups, "off"); assert.equal(DEFAULT_DM.max_group, 20);
  assert.deepEqual(parseDm('{"scope":"all","groups":"managers","max_group":8}'), { scope: "all", groups: "managers", max_group: 8 });
  assert.deepEqual(parseDm('{"scope":"everybody","groups":3,"max_group":2}'), DEFAULT_DM);
  assert.deepEqual(parseDm("not json"), DEFAULT_DM);
});

test("a settings form is checked", () => {
  assert.deepEqual(validateDm({ scope: "restaurant", groups: "off", max_group: 5 }), { value: { scope: "restaurant", groups: "off", max_group: 5 } });
  assert.deepEqual(validateDm({ scope: "x", groups: "off", max_group: 5 }), { error: "scope" });
  assert.deepEqual(validateDm({ scope: "all", groups: "some", max_group: 5 }), { error: "groups" });
  assert.deepEqual(validateDm({ scope: "all", groups: "all", max_group: 2 }), { error: "max_group" });
  assert.deepEqual(validateDm({ scope: "all", groups: "all", max_group: 51 }), { error: "max_group" });
  assert.deepEqual(validateDm(null), { error: "invalid" });
});

test("who may start a group", () => {
  const emp = { is_admin: false }, admin = { is_admin: true };
  assert.equal(canStartGroup({ ...DEFAULT_DM, groups: "all" }, emp, false), true);
  assert.equal(canStartGroup({ ...DEFAULT_DM, groups: "managers" }, emp, false), false);
  assert.equal(canStartGroup({ ...DEFAULT_DM, groups: "managers" }, emp, true), true);
  assert.equal(canStartGroup({ ...DEFAULT_DM, groups: "managers" }, admin, false), true);
  assert.equal(canStartGroup({ ...DEFAULT_DM, groups: "off" }, admin, true), false);
});
