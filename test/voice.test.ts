import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSpeech, sayAndListen, listenOnly, hangUp, xmlEscape, VOICE_MAX_CHARS } from "../src/voice.ts";

test("cleanSpeech removes control characters, squeezes spaces and caps the length", () => {
  assert.equal(cleanSpeech("  Bonjour\n\n  toi\t! "), "Bonjour toi !");
  assert.equal(cleanSpeech(null), "");
  assert.equal(cleanSpeech("x".repeat(VOICE_MAX_CHARS + 50)).length, VOICE_MAX_CHARS);
});

test("typed text cannot break the TwiML", () => {
  const xml = sayAndListen(`</Say><Hangup/> "quote" & <b>`, "fr", "https://a.test/heard?x=1&y=2", "https://a.test/talk");
  assert.ok(!xml.includes("<Hangup/>"));
  assert.ok(xml.includes("&lt;/Say&gt;&lt;Hangup/&gt;"));
  assert.ok(xml.includes('action="https://a.test/heard?x=1&amp;y=2"'));
  assert.equal(xmlEscape(`<&>"'`), "&lt;&amp;&gt;&quot;&apos;");
});

test("the voice and listening language follow the call language", () => {
  assert.ok(sayAndListen("Hello", "en", "u", "t").includes('language="en-CA"'));
  assert.ok(listenOnly("fr", "u", "t").includes('language="fr-CA"'));
  assert.ok(listenOnly("fr", "u", "t").includes("<Redirect"));
  assert.equal(hangUp("fr"), '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
});
