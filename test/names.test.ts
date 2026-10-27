import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore plain JS module shared with the browser
import { splitName, joinName, shortNames } from "../public/names.js";

test("split and join names", () => {
  assert.deepEqual(splitName("Marie-Ève  Tremblay"), { first: "Marie-Ève", last: "Tremblay" });
  assert.deepEqual(splitName("Thierry (SA)"), { first: "Thierry", last: "(SA)" });
  assert.deepEqual(splitName("Madonna"), { first: "Madonna", last: "" });
  assert.equal(joinName(" Jean ", " Roy "), "Jean Roy");
  assert.equal(joinName("Jean", ""), "Jean");
});

test("short names: first name, plus the last-name initial only when the first name is shared", () => {
  const m = shortNames([
    { id: 1, first_name: "Marie", last_name: "Tremblay" }, { id: 2, first_name: "marie", last_name: "Gagnon" },
    { id: 3, first_name: "Édouard", last_name: "Roy" }, { id: 4, first_name: "Eric", last_name: "Roy" },
    { id: 5, first_name: "Sam", last_name: "" }, { id: 6, first_name: "Sam", last_name: "" },
  ]);
  assert.equal(m.get(1), "Marie T."); assert.equal(m.get(2), "marie G.");
  assert.equal(m.get(3), "Édouard"); assert.equal(m.get(4), "Eric");
  assert.equal(m.get(5), "Sam"); // no last name to use
});
