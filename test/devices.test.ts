import { test } from "node:test";
import assert from "node:assert/strict";
import { describeDevice } from "../src/devices.ts";

test("devices and browsers are named from the User-Agent", () => {
  const d = (ua: string) => describeDevice(ua);
  assert.deepEqual(d("Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"), { device: "Samsung Galaxy S2x (Android)", browser: "Chrome" });
  assert.deepEqual(d("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"), { device: "Android", browser: "Chrome" });
  assert.deepEqual(d("Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36"), { device: "Samsung Galaxy A (Android)", browser: "Samsung Internet" });
  assert.equal(d("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36").device, "Google Pixel 8 (Android)");
  assert.deepEqual(d("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0"), { device: "Windows", browser: "Edge" });
  assert.deepEqual(d("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"), { device: "iPhone", browser: "Safari" });
  assert.deepEqual(d("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"), { device: "Mac", browser: "Safari" });
  assert.equal(d("Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0").browser, "Firefox");
  assert.deepEqual(d(""), { device: "", browser: "" });
  assert.deepEqual(describeDevice(null), { device: "", browser: "" });
});
