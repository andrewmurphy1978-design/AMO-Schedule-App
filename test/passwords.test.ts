import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, passwordProblem } from "../src/passwords.ts";

test("a password verifies only against its own hash, and each hash has its own salt", async () => {
  const a = await hashPassword("correct horse battery");
  const b = await hashPassword("correct horse battery");
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  assert.equal(await verifyPassword("correct horse battery", a), true);
  assert.equal(await verifyPassword("correct horse batterY", a), false);
  assert.equal(await verifyPassword("", a), false);
});

test("accents are compared in their normalised form", async () => {
  const a = await hashPassword("Mot de passe é1234");
  assert.equal(await verifyPassword("Mot de passe é" + "1234", a), true);
});

test("weak passwords are refused with a reason", () => {
  assert.equal(passwordProblem("court"), "too_short");
  assert.equal(passwordProblem("a".repeat(201)), "too_long");
  assert.equal(passwordProblem("aaaaaaaaaaaa"), "too_common");
  assert.equal(passwordProblem("1234567890abc"), "too_common");
  assert.equal(passwordProblem("andrewmurphy-2026!", "andrewmurphy1978@gmail.com"), "too_common");
  assert.equal(passwordProblem("Une phrase de passe solide 42"), null);
  assert.equal(passwordProblem(12345678901234), "invalid");
});
