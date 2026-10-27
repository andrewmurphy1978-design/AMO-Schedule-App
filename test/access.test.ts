import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyAccessJwt } from "../src/access.ts";

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

async function makeToken(claims: Record<string, unknown>, tamper = false) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as { n: string; e: string; kty: string };
  const head = enc({ alg: "RS256", kid: "k1" });
  const body = enc(claims);
  const sig = Buffer.from(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`)),
  ).toString("base64url");
  const token = tamper ? `${head}.${enc({ ...claims, email: "evil@x.dev" })}.${sig}` : `${head}.${body}.${sig}`;
  return { token, keys: [{ kid: "k1", kty: jwk.kty, n: jwk.n, e: jwk.e }] };
}

const base = { aud: ["AUD1"], iss: "https://team.cloudflareaccess.com", email: "Andrew@Test.dev", exp: 2000000000 };
const opts = (keys: any, extra = {}) => ({ keys, aud: "AUD1", issuer: "https://team.cloudflareaccess.com", now: 1900000000, ...extra });

test("valid token returns lower-cased email", async () => {
  const { token, keys } = await makeToken(base);
  assert.equal(await verifyAccessJwt(token, opts(keys)), "andrew@test.dev");
});

test("tampered payload is rejected", async () => {
  const { token, keys } = await makeToken(base, true);
  assert.equal(await verifyAccessJwt(token, opts(keys)), null);
});

test("expired, wrong audience and wrong issuer are rejected", async () => {
  const { token, keys } = await makeToken(base);
  assert.equal(await verifyAccessJwt(token, opts(keys, { now: 2000000001 })), null);
  assert.equal(await verifyAccessJwt(token, opts(keys, { aud: "OTHER" })), null);
  assert.equal(await verifyAccessJwt(token, opts(keys, { issuer: "https://evil.example" })), null);
});

test("garbage is rejected", async () => {
  assert.equal(await verifyAccessJwt("not.a.jwt", opts([])), null);
  assert.equal(await verifyAccessJwt("x", opts([])), null);
});
