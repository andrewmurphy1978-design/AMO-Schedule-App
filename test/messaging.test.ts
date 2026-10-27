import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { normalizePhone } from "../src/phone.ts";
import { twilioSignature, verifyTwilioSignature } from "../src/twilio.ts";
import { sendMail, buildMessage, type SmtpChannel } from "../src/smtp.ts";

test("phone numbers are normalised to E.164", () => {
  assert.equal(normalizePhone("819-555-1234"), "+18195551234");
  assert.equal(normalizePhone("(819) 555 1234"), "+18195551234");
  assert.equal(normalizePhone("1 819 555 1234"), "+18195551234");
  assert.equal(normalizePhone("+33 6 12 34 56 78"), "+33612345678");
  assert.equal(normalizePhone("555-1234"), null);
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone("abc"), null);
});

test("Twilio signature matches an independent HMAC-SHA1 computation", async () => {
  const token = "12345", url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { Digits: "1234", To: "+18005551212", From: "+14158675310", Caller: "+14158675310", CallSid: "CA1234567890ABCDE" };
  const data = url + Object.keys(params).sort().map((k) => k + (params as Record<string, string>)[k]).join("");
  const expected = createHmac("sha1", token).update(data).digest("base64");
  assert.equal(await twilioSignature(token, url, params), expected);
  assert.equal(await verifyTwilioSignature(token, url, params, expected), true);
  assert.equal(await verifyTwilioSignature(token, url, params, "AAAA"), false);
  assert.equal(await verifyTwilioSignature(token, url, { ...params, Digits: "9999" }, expected), false);
  assert.equal(await verifyTwilioSignature(token, url, params, null), false);
});

function scripted(replies: string[], sent: string[]): SmtpChannel {
  const lines = replies.flatMap((r) => r.split("\r\n"));
  return { write: async (d) => { sent.push(d); }, readLine: async () => { const l = lines.shift(); if (l === undefined) throw new Error("no more server lines"); return l; } };
}

test("SMTP: full conversation with AUTH PLAIN, multi-line EHLO and an accented subject", async () => {
  const sent: string[] = [];
  const ch = scripted(["220 smtp.test ready", "250-smtp.test\r\n250-AUTH PLAIN\r\n250 8BITMIME", "235 ok", "250 sender ok", "250 rcpt ok", "354 go", "250 queued"], sent);
  await sendMail(ch, { from: "Mikes <no-reply@mikes.test>", to: "marc@example.com", subject: "Remplacement demandé", text: "Bonjour é\nligne 2" }, { user: "u", pass: "p" });
  const all = sent.join("");
  assert.match(all, /^EHLO amo-schedule\r\n/);
  assert.ok(all.includes(`AUTH PLAIN ${btoa("\0u\0p")}`));
  assert.ok(all.includes("MAIL FROM:<no-reply@mikes.test>"));
  assert.ok(all.includes("RCPT TO:<marc@example.com>"));
  assert.ok(all.includes("Subject: =?UTF-8?B?"), "non-ASCII subject is MIME-encoded");
  assert.ok(all.includes("\r\n.\r\n"), "message ends with a lone dot");
  assert.ok(all.trimEnd().endsWith("QUIT"));
});

test("SMTP: server rejection surfaces as an error", async () => {
  const sent: string[] = [];
  const ch = scripted(["220 hi", "250 ok", "535 5.7.8 Authentication failed"], sent);
  await assert.rejects(() => sendMail(ch, { from: "a@b.c", to: "d@e.f", subject: "s", text: "t" }, { user: "u", pass: "bad" }), /AUTH.*535/);
});

test("SMTP: STARTTLS upgrades and repeats EHLO", async () => {
  const sent: string[] = []; let upgraded = false;
  const ch = scripted(["220 hi", "250 ok", "220 ready for tls", "250 ok", "250 s", "250 r", "354 d", "250 q"], sent);
  ch.startTls = async () => { upgraded = true; };
  await sendMail(ch, { from: "a@b.c", to: "d@e.f", subject: "s", text: "t" }, { starttls: true });
  assert.ok(upgraded);
  assert.equal(sent.filter((x) => x.startsWith("EHLO")).length, 2);
});

test("message body is base64 and wrapped", () => {
  const msg = buildMessage({ from: "a@b.c", to: "d@e.f", subject: "Hi", text: "x".repeat(300) });
  const body = msg.split("\r\n\r\n")[1];
  assert.ok(body.split("\r\n").every((l) => l.length <= 76));
  assert.equal(atob(body.replace(/\r\n/g, "").trim()), "x".repeat(300));
});
