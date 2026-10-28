import { test } from "node:test";
import assert from "node:assert/strict";
import { settingKey } from "../src/tenant.ts";

test("client 1 keeps plain setting keys, others are prefixed", () => {
  assert.equal(settingKey(1, "brand_name"), "brand_name");
  assert.equal(settingKey(2, "brand_name"), "c2:brand_name");
  assert.equal(settingKey(12, "conn_smtp_host"), "c12:conn_smtp_host");
});
