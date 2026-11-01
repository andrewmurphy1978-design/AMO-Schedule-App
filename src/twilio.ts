// Twilio helpers: request signature (inbound SMS webhooks) and the outbound message request. No I/O except fetch in sendTwilioSms.

const enc = new TextEncoder();

/** Twilio's X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted "key"+"value" pairs)). */
export async function twilioSignature(authToken: string, url: string, params: Record<string, string>): Promise<string> {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", enc.encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, header: string | null | undefined): Promise<boolean> {
  if (!header) return false;
  const expected = await twilioSignature(authToken, url, params);
  if (expected.length !== header.length) return false;
  let diff = 0; // constant-time comparison
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

export interface TwilioConfig { sid: string; token: string; from: string; apiBase?: string }

export async function sendTwilioSms(cfg: TwilioConfig, to: string, body: string): Promise<{ ok: boolean; error?: string; sid?: string; segments?: number }> {
  const base = cfg.apiBase ?? "https://api.twilio.com";
  const res = await fetch(`${base}/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${cfg.sid}:${cfg.token}`)}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: cfg.from, Body: body }).toString(),
  });
  const text = await res.text().catch(() => "");
  if (res.ok) { try { const j = JSON.parse(text); const n = Number(j.num_segments); return { ok: true, sid: typeof j.sid === "string" ? j.sid : undefined, segments: Number.isFinite(n) && n > 0 ? n : undefined }; } catch { return { ok: true }; } }
  let message = `HTTP ${res.status}`;
  try { const j = JSON.parse(text); message = j.message ? `${j.message}${j.code ? ` (code ${j.code})` : ""}` : message; } catch { /* keep status */ }
  return { ok: false, error: message.slice(0, 300) };
}

/** Starts a phone call; Twilio then asks `url` what to say. */
export async function startTwilioCall(cfg: TwilioConfig, to: string, url: string, statusUrl: string, timeLimit: number): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const base = cfg.apiBase ?? "https://api.twilio.com";
  const body = new URLSearchParams({ To: to, From: cfg.from, Url: url, Method: "POST", StatusCallback: statusUrl, StatusCallbackMethod: "POST", TimeLimit: String(timeLimit) });
  for (const ev of ["completed"]) body.append("StatusCallbackEvent", ev);
  const res = await fetch(`${base}/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}/Calls.json`, {
    method: "POST", headers: { authorization: `Basic ${btoa(`${cfg.sid}:${cfg.token}`)}`, "content-type": "application/x-www-form-urlencoded" }, body: body.toString(),
  });
  const text = await res.text().catch(() => "");
  if (res.ok) { try { return { ok: true, sid: JSON.parse(text).sid }; } catch { return { ok: true }; } }
  let message = `HTTP ${res.status}`;
  try { const j = JSON.parse(text); message = j.message ? `${j.message}${j.code ? ` (code ${j.code})` : ""}` : message; } catch { /* keep status */ }
  return { ok: false, error: message.slice(0, 300) };
}

/** Ends a call in progress. */
export async function hangupTwilioCall(cfg: TwilioConfig, callSid: string): Promise<void> {
  const base = cfg.apiBase ?? "https://api.twilio.com";
  await fetch(`${base}/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}/Calls/${encodeURIComponent(callSid)}.json`, {
    method: "POST", headers: { authorization: `Basic ${btoa(`${cfg.sid}:${cfg.token}`)}`, "content-type": "application/x-www-form-urlencoded" }, body: "Status=completed",
  }).catch(() => {});
}
