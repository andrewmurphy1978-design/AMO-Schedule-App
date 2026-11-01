import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCostMicro, twilioPrice } from "../src/usage.ts";

test("a Claude answer costs tokens x the price per million (millionths of a dollar)", () => {
  assert.equal(claudeCostMicro("claude-sonnet-5-5", { input_tokens: 12_000, output_tokens: 8_000 }), 104_000); // $0.104
  assert.equal(claudeCostMicro("claude-sonnet-5-5", { input_tokens: 1_000_000 }), 2_000_000);
  assert.equal(claudeCostMicro("claude-haiku-5-5", { input_tokens: 10_000, output_tokens: 1_000 }), 1_500);
  // cached input is cheaper, cache writes dearer
  assert.equal(claudeCostMicro("claude-sonnet-5-5", { input_tokens: 0, cache_read_input_tokens: 100_000 }), 20_000);
  assert.equal(claudeCostMicro("claude-sonnet-5-5", { cache_creation_input_tokens: 100_000 }), 250_000);
  assert.equal(claudeCostMicro("some-new-model", { input_tokens: 5 }), null);
});

test("Twilio's price comes back negative and as text; unpriced messages stay unknown", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ price: "-0.00790", price_unit: "USD", num_segments: "2" }))) as typeof fetch;
    assert.deepEqual(await twilioPrice({ sid: "AC1", token: "t", from: "+1" }, "sms", "SM1"), { cost_micro: 7900, currency: "USD", units: 2 });
    globalThis.fetch = (async () => new Response(JSON.stringify({ price: "-0.0085", price_unit: "USD", duration: "120" }))) as typeof fetch;
    assert.deepEqual(await twilioPrice({ sid: "AC1", token: "t", from: "+1" }, "call", "CA1"), { cost_micro: 8500, currency: "USD", units: 120 });
    globalThis.fetch = (async () => new Response(JSON.stringify({ price: null, price_unit: null }))) as typeof fetch;
    assert.equal(await twilioPrice({ sid: "AC1", token: "t", from: "+1" }, "sms", "SM1"), null);
    globalThis.fetch = (async () => new Response("no", { status: 404 })) as typeof fetch;
    assert.equal(await twilioPrice({ sid: "AC1", token: "t", from: "+1" }, "sms", "SM1"), null);
  } finally { globalThis.fetch = real; }
});
