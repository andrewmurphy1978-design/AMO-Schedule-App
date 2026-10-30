import { test } from "node:test";
import assert from "node:assert/strict";
import { b64u, encryptPayload } from "../src/push.ts";

// RFC 8291 appendix A example.
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
const EXPECTED = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

test("push payload encryption matches the RFC 8291 test vector", async () => {
  const pub = b64u.dec(AS_PUBLIC);
  const jwk = { kty: "EC", crv: "P-256", d: AS_PRIVATE, x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)) };
  const ephemeral = { privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]), publicKey: await crypto.subtle.importKey("raw", pub, { name: "ECDH", namedCurve: "P-256" }, true, []) } as CryptoKeyPair;
  const out = await encryptPayload({ p256dh: UA_PUBLIC, auth: AUTH }, new TextEncoder().encode("When I grow up, I want to be a watermelon"), { ephemeral, salt: b64u.dec(SALT) });
  assert.equal(b64u.enc(out), EXPECTED);
});

test("a push is signed with VAPID (ES256), encrypted, and a 410 means the device is gone", async () => {
  const { sendToDevice } = await import("../src/push.ts");
  const server = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const vapid = { publicKey: b64u.enc(await crypto.subtle.exportKey("raw", server.publicKey)), privateJwk: await crypto.subtle.exportKey("jwk", server.privateKey) };
  const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const sub = { id: 1, endpoint: "https://push.example.test/send/abc", p256dh: b64u.enc(await crypto.subtle.exportKey("raw", ua.publicKey)), auth: b64u.enc(crypto.getRandomValues(new Uint8Array(16))) };
  let seen: { url: string; headers: Record<string, string>; len: number } | null = null;
  const ok: typeof fetch = async (url, init) => { seen = { url: String(url), headers: init!.headers as Record<string, string>, len: (init!.body as Uint8Array).length }; return new Response(null, { status: 201 }); };
  assert.equal(await sendToDevice(vapid, "https://app.example.test", sub, { title: "Mikes", body: "Horaire publié" }, true, ok), "ok");
  assert.equal(seen!.url, sub.endpoint);
  assert.equal(seen!.headers["content-encoding"], "aes128gcm");
  assert.equal(seen!.headers.urgency, "high");
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(seen!.headers.authorization)!;
  assert.equal(m[4], vapid.publicKey);
  const claims = JSON.parse(new TextDecoder().decode(b64u.dec(m[2])));
  assert.equal(claims.aud, "https://push.example.test");
  assert.equal(claims.sub, "https://app.example.test");
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, server.publicKey, b64u.dec(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`));
  assert.equal(valid, true);
  assert.ok(seen!.len > 100);
  const gone: typeof fetch = async () => new Response(null, { status: 410 });
  assert.equal(await sendToDevice(vapid, "https://app.example.test", sub, { title: "x", body: "y" }, false, gone), "gone");
});
