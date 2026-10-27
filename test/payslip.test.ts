import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSin, hashSin, chooseMatch, isPdf, extractPayslip } from "../src/payslip.ts";

test("SIN: 9 digits with a valid Luhn check, spaces and dashes ignored", () => {
  assert.equal(normalizeSin("046 454 286"), "046454286");
  assert.equal(normalizeSin("046-454-286"), "046454286");
  assert.equal(normalizeSin("046454287"), null);
  assert.equal(normalizeSin("12345"), null);
  assert.equal(normalizeSin(null), null);
});

test("SIN hash depends on the key and is stable", async () => {
  assert.equal(await hashSin("k1", "046454286"), await hashSin("k1", "046454286"));
  assert.notEqual(await hashSin("k1", "046454286"), await hashSin("k2", "046454286"));
});

test("matching: SIN wins, then a unique name, otherwise nothing", async () => {
  const key = "k";
  const people = [
    { id: 1, name: "Marie Tremblay", sin_hash: await hashSin(key, "046454286") },
    { id: 2, name: "Marie-Ève Gagné", sin_hash: null },
    { id: 3, name: "Jean Roy", sin_hash: null },
    { id: 4, name: "Jean Roy", sin_hash: null },
  ];
  assert.deepEqual(await chooseMatch({ employee_name: "Someone Else", sin: "046 454 286", period: null, pay_date: null }, people, key), { staff_id: 1, kind: "sin" });
  assert.deepEqual(await chooseMatch({ employee_name: "Gagne, Marie-Eve", sin: null, period: null, pay_date: null }, people, key), { staff_id: 2, kind: "name" });
  assert.deepEqual(await chooseMatch({ employee_name: "Jean Roy", sin: null, period: null, pay_date: null }, people, key), { staff_id: null, kind: "none" }); // two Jean Roy
  assert.deepEqual(await chooseMatch({ employee_name: null, sin: "000000000", period: null, pay_date: null }, people, key), { staff_id: null, kind: "none" });
});

test("PDF magic check", () => {
  assert.equal(isPdf(new TextEncoder().encode("%PDF-1.7 ....")), true);
  assert.equal(isPdf(new TextEncoder().encode("<html>......")), false);
});

test("extractPayslip parses the model's JSON and survives errors", async () => {
  const ok = async () => new Response(JSON.stringify({ content: [{ type: "text", text: 'Here: {"employee_name":"Marie Tremblay","sin":"046454286","period":"x","pay_date":"2026-10-30"}' }] }));
  assert.deepEqual(await extractPayslip("key", "AAAA", ok as unknown as typeof fetch), { employee_name: "Marie Tremblay", sin: "046454286", period: "x", pay_date: "2026-10-30" });
  assert.equal(await extractPayslip("key", "AAAA", (async () => new Response("no", { status: 500 })) as unknown as typeof fetch), null);
  assert.equal(await extractPayslip("key", "AAAA", (async () => new Response(JSON.stringify({ content: [{ type: "text", text: "no json" }] }))) as unknown as typeof fetch), null);
});
