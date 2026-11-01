import { test } from "node:test";
import assert from "node:assert/strict";
import { pickInTurn } from "../src/closing.ts";

test("the closing task goes to whoever had it least recently, then least often", () => {
  assert.equal(pickInTurn([], []), null);
  assert.equal(pickInTurn([7], [{ staff_id: 7, last: "2026-10-30", n: 9 }]), 7); // only one person closes: it is theirs again
  // never done = first, whatever the others did
  assert.equal(pickInTurn([1, 2, 3], [{ staff_id: 1, last: "2026-10-29", n: 3 }, { staff_id: 2, last: "2026-10-30", n: 1 }]), 3);
  // oldest date first
  assert.equal(pickInTurn([1, 2], [{ staff_id: 1, last: "2026-10-30", n: 1 }, { staff_id: 2, last: "2026-10-25", n: 5 }]), 2);
  // same last date: the one who did it less often, then the lowest id
  assert.equal(pickInTurn([4, 5], [{ staff_id: 4, last: "2026-10-25", n: 3 }, { staff_id: 5, last: "2026-10-25", n: 2 }]), 5);
  assert.equal(pickInTurn([6, 5], []), 5);
});

test("a rotation over several days never gives it to the same person twice in a row when others close", () => {
  const history: { staff_id: number; last: string; n: number }[] = [];
  const crew = [10, 11, 12];
  let prev = -1; const got: number[] = [];
  for (let day = 1; day <= 9; day++) {
    const pick = pickInTurn(crew, history)!;
    assert.notEqual(pick, prev);
    got.push(pick); prev = pick;
    const h = history.find((x) => x.staff_id === pick);
    if (h) { h.last = `2026-11-${String(day).padStart(2, "0")}`; h.n++; } else history.push({ staff_id: pick, last: `2026-11-${String(day).padStart(2, "0")}`, n: 1 });
  }
  assert.deepEqual(got, [10, 11, 12, 10, 11, 12, 10, 11, 12]);
});
