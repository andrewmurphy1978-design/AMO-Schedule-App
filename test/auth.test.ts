import { test } from "node:test";
import assert from "node:assert/strict";
import { newCode, newSessionToken, codeHash, safeEqual, readCookie, sessionCookie, looksLikeEmail, loginMessage } from "../src/auth.ts";

test("codes are six digits and tokens are long and unique", () => {
  for (let i = 0; i < 200; i++) assert.match(newCode(), /^\d{6}$/);
  const a = newSessionToken(), b = newSessionToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 42);
});

test("code hash depends on email (case-insensitive), code and pepper", async () => {
  assert.equal(await codeHash("p", "A@b.ca", "123456"), await codeHash("p", "a@b.ca", "123456"));
  assert.notEqual(await codeHash("p", "a@b.ca", "123456"), await codeHash("p", "a@b.ca", "123457"));
  assert.notEqual(await codeHash("p", "a@b.ca", "123456"), await codeHash("q", "a@b.ca", "123456"));
});

test("safeEqual, cookies and email shape", () => {
  assert.ok(safeEqual("abc", "abc")); assert.ok(!safeEqual("abc", "abd")); assert.ok(!safeEqual("abc", "ab"));
  assert.equal(readCookie("a=1; sid=xyz; b=2", "sid"), "xyz");
  assert.equal(readCookie(null, "sid"), null);
  assert.match(sessionCookie("t", true), /HttpOnly.*SameSite=Lax.*Secure/);
  assert.ok(looksLikeEmail("a@b.ca")); assert.ok(!looksLikeEmail("nope")); assert.ok(!looksLikeEmail("a b@c.d"));
  assert.match(loginMessage("fr", "123456").subject, /123456/);
  assert.match(loginMessage("en", "123456").text, /10 minutes/);
});
