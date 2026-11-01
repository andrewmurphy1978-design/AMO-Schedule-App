import { test } from "node:test";
import assert from "node:assert/strict";
import { transcribe, WHISPER_MODEL, MAX_TRANSCRIBE_BYTES, type AiBinding } from "../src/transcribe.ts";

const bytes = new Uint8Array([1, 2, 3, 4]);

test("the audio goes to Whisper (base64) with the language, and the text comes back cleaned", async () => {
  let seen: { model: string; input: Record<string, unknown> } | null = null;
  const ai: AiBinding = { run: async (model, input) => { seen = { model, input }; return { text: "  Bonjour  tout\nle monde " }; } };
  assert.equal(await transcribe(ai, bytes, "fr"), "Bonjour tout le monde");
  assert.equal(seen!.model, WHISPER_MODEL);
  assert.equal(seen!.input.audio, btoa(String.fromCharCode(1, 2, 3, 4)));
  assert.equal(seen!.input.language, "fr");
});

test("no AI binding, an empty result, an error or a huge file: no transcript, never an exception", async () => {
  assert.equal(await transcribe(undefined, bytes, "fr"), null);
  assert.equal(await transcribe({ run: async () => ({ text: "   " }) }, bytes, "fr"), null);
  assert.equal(await transcribe({ run: async () => { throw new Error("boom"); } }, bytes, "en"), null);
  assert.equal(await transcribe({ run: async () => ({ text: "x" }) }, new Uint8Array(MAX_TRANSCRIBE_BYTES + 1), "fr"), null);
});
