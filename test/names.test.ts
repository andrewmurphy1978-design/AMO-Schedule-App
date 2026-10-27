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

test("gendered role names", async () => {
  // @ts-ignore plain JS module shared with the browser
  const { genderedRole } = await import("../public/names.js");
  assert.equal(genderedRole("Cuisinier / cuisinière", "M"), "Cuisinier");
  assert.equal(genderedRole("Cuisinier / cuisinière", "F"), "Cuisinière");
  assert.equal(genderedRole("Cuisinier / cuisinière", null), "Cuisinier / cuisinière");
  assert.equal(genderedRole("Waitress / waiter".split(" / ").reverse().join(" / "), "F"), "Waitress");
  assert.equal(genderedRole("Chef", "F"), "Chef");
  assert.equal(genderedRole("Aide-serveur / aide-serveuse", "F"), "Aide-serveuse");
});

test("staff order for the printed schedule", async () => {
  // @ts-ignore plain JS module shared with the browser
  const { orderStaff } = await import("../public/names.js");
  const people = [{ id: 1, name: "Zack", print_order: 2 }, { id: 2, name: "Julien", print_order: null }, { id: 3, name: "Deryck", print_order: 1 }, { id: 4, name: "Andrew", print_order: null }];
  const shifts = [
    ...["26", "27", "28", "29", "30"].map((d) => ({ staff_id: 2, start_at: `2026-10-${d}T06:30` })),            // Julien opens 5 days
    ...["28", "29", "30"].map((d) => ({ staff_id: 3, start_at: `2026-10-${d}T08:00` })),                       // Deryck 08:00 x3
    { staff_id: 3, start_at: "2026-10-30T17:00" },                                                             // (second shift the same day does not count)
    ...["26", "27"].map((d) => ({ staff_id: 1, start_at: `2026-10-${d}T08:00` })),                            // Zack 08:00 x2
    { staff_id: 4, start_at: "2026-10-31T17:00" },
  ];
  assert.deepEqual(orderStaff(people, shifts, "alpha"), [4, 3, 2, 1]);
  assert.deepEqual(orderStaff(people, shifts, "arrival"), [2, 3, 1, 4]);
  assert.deepEqual(orderStaff(people, shifts, "custom"), [3, 1, 4, 2]);
});
