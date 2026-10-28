import { test } from "node:test";
import assert from "node:assert/strict";
import { signBody, validateUrl, validateEvents, retryDelay, wants, newSecret, EVENTS } from "../src/webhooks.ts";

test("signature is HMAC-SHA256 of '<t>.<body>' and changes with secret, body and time", async () => {
  const a = await signBody("whsec_x", '{"a":1}', 1700000000);
  assert.match(a, /^t=1700000000,v1=[0-9a-f]{64}$/);
  assert.equal(a, await signBody("whsec_x", '{"a":1}', 1700000000));
  assert.notEqual(a, await signBody("whsec_y", '{"a":1}', 1700000000));
  assert.notEqual(a, await signBody("whsec_x", '{"a":2}', 1700000000));
  assert.notEqual(a, await signBody("whsec_x", '{"a":1}', 1700000001));
  // known vector (computed independently with openssl): echo -n '1700000000.{"a":1}' | openssl dgst -sha256 -hmac whsec_x
  const { createHmac } = await import("node:crypto");
  assert.equal(a.split("v1=")[1], createHmac("sha256", "whsec_x").update('1700000000.{"a":1}').digest("hex"));
});

test("url validation: https only, no IPs or local names; local allowed in development", () => {
  assert.equal(validateUrl("https://crm.example.com/hooks/ams"), null);
  assert.equal(validateUrl("http://crm.example.com/x"), "https_required");
  assert.equal(validateUrl("https://127.0.0.1/x"), "ip_not_allowed");
  assert.equal(validateUrl("https://10.0.0.5/x"), "ip_not_allowed");
  assert.equal(validateUrl("https://[::1]/x"), "ip_not_allowed");
  assert.equal(validateUrl("https://localhost/x"), "host_not_allowed");
  assert.equal(validateUrl("https://intranet/x"), "host_not_allowed");
  assert.equal(validateUrl("https://printer.local/x"), "host_not_allowed");
  assert.equal(validateUrl("https://u:p@crm.example.com/x"), "invalid_url");
  assert.equal(validateUrl("nonsense"), "invalid_url");
  assert.equal(validateUrl("http://localhost:9000/x", true), null);
  assert.equal(validateUrl("http://crm.example.com/x", true), "https_required");
});

test("events, retries and secrets", () => {
  assert.deepEqual(validateEvents(["shift.created", "shift.created"]), ["shift.created"]);
  assert.deepEqual(validateEvents(["*", "shift.created"]), ["*"]);
  assert.equal(validateEvents(["nope"]), null);
  assert.equal(validateEvents([]), null);
  assert.ok(wants(["*"], "staff.created") && wants(["staff.created"], "staff.created") && !wants(["staff.created"], "shift.created"));
  assert.equal(retryDelay(1), 5 * 60_000);
  assert.equal(retryDelay(5), 24 * 3600_000);
  assert.equal(retryDelay(6), null);
  assert.ok(newSecret().startsWith("whsec_") && newSecret().length > 40);
  assert.ok(EVENTS.includes("coverage.opened"));
});
