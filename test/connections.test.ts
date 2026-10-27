import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConnections, publicConnectionView, pickChannel } from "../src/connections.ts";

const rows = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value }));

test("nothing configured -> both channels off", () => {
  const c = parseConnections([], {});
  assert.equal(c.twilio, null); assert.equal(c.smtp, null);
});

test("Twilio needs all three values; SMTP needs host and from", () => {
  assert.equal(parseConnections(rows({ conn_twilio_sid: "AC1", conn_twilio_token: "t" }), {}).twilio, null);
  assert.deepEqual(parseConnections(rows({ conn_twilio_sid: "AC1", conn_twilio_token: "t", conn_twilio_from: "+15145550000" }), {}).twilio, { sid: "AC1", token: "t", from: "+15145550000", apiBase: undefined });
  assert.equal(parseConnections(rows({ conn_smtp_host: "smtp.gmail.com" }), {}).smtp, null);
  const smtp = parseConnections(rows({ conn_smtp_host: "smtp.gmail.com", conn_smtp_from: "Mikes <a@b.c>", conn_smtp_user: "a@b.c", conn_smtp_pass: "x" }), {}).smtp;
  assert.equal(smtp?.port, 465); assert.equal(smtp?.secure, "implicit");
});

test("environment values win over saved ones, and ports follow the security mode", () => {
  const c = parseConnections(rows({ conn_twilio_sid: "ACdb", conn_twilio_token: "db", conn_twilio_from: "+1", conn_smtp_host: "dbhost", conn_smtp_from: "x@y.z", conn_smtp_secure: "starttls" }), { TWILIO_ACCOUNT_SID: "ACenv" });
  assert.equal(c.twilio?.sid, "ACenv"); assert.equal(c.twilio?.token, "db");
  assert.equal(c.smtp?.port, 587);
});

test("the admin view never contains secrets", () => {
  const c = parseConnections(rows({ conn_twilio_sid: "ACsecret1234", conn_twilio_token: "TOP-SECRET", conn_twilio_from: "+15145550000", conn_smtp_host: "h", conn_smtp_from: "f@g.h", conn_smtp_user: "u", conn_smtp_pass: "PASS-SECRET" }), { APP_URL: "https://x.test/" });
  const text = JSON.stringify(publicConnectionView(c));
  assert.ok(!text.includes("TOP-SECRET") && !text.includes("PASS-SECRET") && !text.includes("ACsecret"));
  assert.ok(text.includes("…1234"));
  assert.equal(c.appUrl, "https://x.test");
});

test("channel choice: preference, fallback, or nothing", () => {
  const both = { sms: true, email: true };
  assert.equal(pickChannel({ phone: "+1", email: "a@b.c", notify_channel: "sms" }, both), "sms");
  assert.equal(pickChannel({ phone: "+1", email: "a@b.c", notify_channel: "email" }, both), "email");
  assert.equal(pickChannel({ phone: null, email: "a@b.c", notify_channel: "sms" }, both), "email");
  assert.equal(pickChannel({ phone: "+1", email: "a@b.c", notify_channel: "email" }, { sms: true, email: false }), "sms");
  assert.equal(pickChannel({ phone: null, email: null, notify_channel: "sms" }, both), null);
  assert.equal(pickChannel({ phone: "+1", email: null, notify_channel: "sms" }, { sms: false, email: true }), null);
});
