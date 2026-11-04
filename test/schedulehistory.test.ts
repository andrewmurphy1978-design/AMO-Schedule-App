import { test } from "node:test";
import assert from "node:assert/strict";
import { diffShifts, changesForAi, hasChanges, type SnapShift, type NowShift } from "../src/schedulehistory.ts";

const S = (staff_id: number, start: string, end: string, role_id = 1): SnapShift => ({ staff_id, role_id, start_at: `2026-11-09T${start}`, end_at: `2026-11-09T${end}` });
const N = (id: number, s: SnapShift): NowShift => ({ id, ...s });

test("nothing changed", () => { const b = [S(1, "09:00", "17:00")]; const d = diffShifts(b, [N(10, b[0])]); assert.equal(hasChanges(d), false); });
test("hours changed for the same person and day", () => {
  const d = diffShifts([S(1, "09:00", "17:00")], [N(10, S(1, "10:00", "18:00"))]);
  assert.equal(d.changed.length, 1); assert.equal(d.changed[0].before.start_at.slice(11), "09:00"); assert.equal(d.changed[0].after.id, 10);
});
test("someone else takes the slot: a replacement", () => {
  const d = diffShifts([S(1, "09:00", "17:00")], [N(10, S(2, "09:00", "17:00"))]);
  assert.equal(d.replaced.length, 1); assert.equal(d.replaced[0].from.staff_id, 1); assert.equal(d.replaced[0].to.staff_id, 2); assert.equal(d.added.length + d.removed.length, 0);
});
test("a replacement needs the same role and overlapping hours; otherwise one is removed and one added", () => {
  const d = diffShifts([S(1, "09:00", "12:00")], [N(10, S(2, "13:00", "17:00")), N(11, S(3, "09:00", "12:00", 2))]);
  assert.equal(d.replaced.length, 0); assert.equal(d.removed.length, 1); assert.equal(d.added.length, 2);
});
test("added and removed shifts, with the AI form", () => {
  const d = diffShifts([S(1, "09:00", "17:00"), S(4, "09:00", "12:00")], [N(10, S(1, "09:00", "17:00")), N(11, S(5, "18:00", "22:00"))]);
  assert.deepEqual(changesForAi(d).map((c) => [c.kind, c.staff_id]), [["added", 5], ["removed", 4]]);
});
test("two shifts the same day for one person are matched one by one", () => {
  const b = [S(1, "08:00", "11:00"), S(1, "17:00", "21:00")];
  const d = diffShifts(b, [N(10, b[0]), N(11, S(1, "17:00", "20:00"))]);
  assert.equal(d.changed.length, 1); assert.equal(d.changed[0].after.end_at.slice(11), "20:00");
});
