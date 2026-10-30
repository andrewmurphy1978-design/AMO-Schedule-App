// Web Push (RFC 8030 + VAPID RFC 8292 + message encryption RFC 8291, aes128gcm) with nothing but WebCrypto, so it runs in a Worker.
// The server's VAPID key pair is created the first time it is needed and kept in the settings table.
import { getSetting } from "./tenant.ts";

export interface PushPayload { title: string; body: string; url?: string; tag?: string }
export interface Sub { id: number; endpoint: string; p256dh: string; auth: string }

export const b64u = {
  enc: (buf: ArrayBuffer | Uint8Array) => {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = ""; for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec: (s: string) => {
    const p = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
    return Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
  },
};
const utf8 = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

export interface Vapid { publicKey: string; privateJwk: JsonWebKey }
export async function getVapid(db: D1Database): Promise<Vapid> {
  const existing = await getSetting(db, 1, "vapid_keys");
  if (existing) return JSON.parse(existing);
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const v: Vapid = { publicKey: b64u.enc(await crypto.subtle.exportKey("raw", kp.publicKey)), privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
  await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid_keys', ?)").bind(JSON.stringify(v)).run();
  return JSON.parse((await getSetting(db, 1, "vapid_keys"))!); // another request may have won the race
}

async function vapidHeader(vapid: Vapid, endpoint: string, subject: string) {
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u.enc(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u.enc(utf8(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${b64u.enc(sig)}, k=${vapid.publicKey}`;
}

/** RFC 8291 aes128gcm body for one subscription. */
export async function encryptPayload(sub: { p256dh: string; auth: string }, plaintext: Uint8Array, fixed?: { ephemeral?: CryptoKeyPair; salt?: Uint8Array }): Promise<Uint8Array> {
  const uaPublic = b64u.dec(sub.p256dh), authSecret = b64u.dec(sub.auth);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = fixed?.ephemeral ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256);
  const hkdf = async (ikm: ArrayBuffer | Uint8Array, salt: Uint8Array, info: Uint8Array, bits: number) => {
    const k = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, k, bits));
  };
  const ikm = await hkdf(shared, authSecret, concat(utf8("WebPush: info\0"), uaPublic, asPublic), 256);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, utf8("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(ikm, salt, utf8("Content-Encoding: nonce\0"), 96);
  const aes = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, aes, concat(plaintext, new Uint8Array([2])) as BufferSource)); // 0x02 = last record
  const header = new Uint8Array(21); header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096); header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

/** Sends one notification to one device. Returns "gone" when the device unsubscribed (the row should be removed). */
export async function sendToDevice(vapid: Vapid, subject: string, sub: Sub, payload: PushPayload, urgent = false, fetcher: typeof fetch = fetch): Promise<"ok" | "gone" | "failed"> {
  try {
    const body = await encryptPayload(sub, utf8(JSON.stringify(payload)));
    const res = await fetcher(sub.endpoint, {
      method: "POST", body: body as unknown as BodyInit,
      headers: { authorization: await vapidHeader(vapid, sub.endpoint, subject), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: urgent ? "high" : "normal" },
    });
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "ok" : "failed";
  } catch { return "failed"; }
}

/** Notifies every device of one employee. Returns how many devices accepted it. */
export async function pushToStaff(db: D1Database, staffId: number, payload: PushPayload, opts: { urgent?: boolean; appUrl?: string } = {}): Promise<number> {
  const subs = (await db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE staff_id = ?").bind(staffId).all<Sub>()).results;
  if (!subs.length) return 0;
  const vapid = await getVapid(db);
  const subject = opts.appUrl && /^https:/.test(opts.appUrl) ? opts.appUrl : "mailto:admin@example.com";
  const full = { ...payload, url: payload.url ?? "/" };
  let ok = 0;
  for (const s of subs) {
    const r = await sendToDevice(vapid, subject, s, full, opts.urgent);
    if (r === "ok") ok++;
    else if (r === "gone") await db.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(s.id).run();
  }
  return ok;
}
