// Outgoing webhooks. Events are written to a queue table (webhook_deliveries) and sent right away in the background;
// failures are retried by the cron with growing delays. Every delivery is signed with the endpoint's secret.

export const EVENTS = [
  "staff.created", "staff.updated", "staff.active_changed",
  "shift.created", "shift.updated", "shift.deleted", "schedule.applied",
  "time_off.requested", "time_off.decided", "time_off.cancelled",
  "coverage.opened", "coverage.filled",
] as const;
export type EventName = (typeof EVENTS)[number];

export const MAX_ENDPOINTS = 10;
export const MAX_ATTEMPTS = 6;
export const DISABLE_AFTER_FAILURES = 30;
const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 3600_000, 24 * 3600_000]; // after attempt 1..5
export const retryDelay = (attemptsSoFar: number): number | null => (attemptsSoFar >= MAX_ATTEMPTS ? null : RETRY_DELAYS_MS[attemptsSoFar - 1] ?? null);

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** HMAC-SHA256 over "<unix seconds>.<body>"; sent as `X-AMS-Signature: t=<seconds>,v1=<hex>`. */
export async function signBody(secret: string, body: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `t=${t},v1=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)))}`;
}

export const newSecret = () => "whsec_" + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** https only, no credentials, no IP literals, no local names. (Local development may use http://localhost.) */
export function validateUrl(raw: string, allowLocal = false): string | null {
  if (typeof raw !== "string" || raw.length > 500) return "invalid_url";
  let u: URL;
  try { u = new URL(raw); } catch { return "invalid_url"; }
  if (u.username || u.password) return "invalid_url";
  const host = u.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1";
  if (allowLocal && local && (u.protocol === "http:" || u.protocol === "https:")) return null;
  if (u.protocol !== "https:") return "https_required";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":") || host.startsWith("[")) return "ip_not_allowed";
  if (local || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) return "host_not_allowed";
  return null;
}

export function validateEvents(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.length || v.length > EVENTS.length) return null;
  if (v.includes("*")) return ["*"];
  return v.every((e) => (EVENTS as readonly string[]).includes(e)) ? [...new Set(v as string[])] : null;
}

export const wants = (events: string[], event: string) => events.includes("*") || events.includes(event);

/** Queues one event for every active endpoint of the client that asked for it. Returns the number queued. */
export async function queueEvent(db: D1Database, clientId: number, event: EventName | "ping", data: unknown, onlyEndpoint?: number): Promise<number> {
  const eps = (await db.prepare("SELECT id, events FROM webhook_endpoints WHERE client_id = ? AND active = 1" + (onlyEndpoint ? " AND id = ?" : "")).bind(...(onlyEndpoint ? [clientId, onlyEndpoint] : [clientId])).all<{ id: number; events: string }>()).results;
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const ep of eps) {
    let evs: string[] = []; try { evs = JSON.parse(ep.events); } catch { /* none */ }
    if (event !== "ping" && !wants(evs, event)) continue;
    const id = crypto.randomUUID();
    const payload = JSON.stringify({ id, event, created_at: new Date(now).toISOString(), client_id: clientId, data });
    stmts.push(db.prepare("INSERT INTO webhook_deliveries (endpoint_id, event, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)").bind(ep.id, event, payload, now, now));
  }
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

/** Sends every due delivery (claiming each first so two runs never send the same one twice). */
export async function flushDeliveries(db: D1Database, fetcher: typeof fetch = fetch, limit = 40): Promise<{ sent: number; failed: number }> {
  const now = Date.now();
  const due = (await db.prepare(
    `SELECT d.id, d.payload, d.event, d.attempts, e.id AS endpoint_id, e.url, e.secret, e.active
     FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= ? ORDER BY d.id LIMIT ?`,
  ).bind(now, limit).all<{ id: number; payload: string; event: string; attempts: number; endpoint_id: number; url: string; secret: string; active: number }>()).results;
  let sent = 0, failed = 0;
  for (const d of due) {
    // lease: nobody else sends it for the next 2 minutes
    const claim = await db.prepare("UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?").bind(now + 120_000, d.id, now).run();
    if (!claim.meta.changes) continue;
    if (!d.active) { await db.prepare("UPDATE webhook_deliveries SET status = 'failed', error = 'endpoint_disabled' WHERE id = ?").bind(d.id).run(); continue; }
    let code: number | null = null, error: string | null = null;
    try {
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetcher(d.url, {
        method: "POST", redirect: "manual", signal: ctrl.signal,
        headers: { "content-type": "application/json", "user-agent": "AMO-Schedule-Webhooks/1", "X-AMS-Event": d.event, "X-AMS-Delivery": String(d.id), "X-AMS-Signature": await signBody(d.secret, d.payload) },
        body: d.payload,
      });
      clearTimeout(timer);
      code = res.status;
      if (!(res.status >= 200 && res.status < 300)) error = `HTTP ${res.status}`;
    } catch (e) { error = String((e as Error)?.name === "AbortError" ? "timeout" : (e as Error)?.message ?? e).slice(0, 200); }
    const attempts = d.attempts + 1, now2 = Date.now();
    if (!error) {
      sent++;
      await db.batch([
        db.prepare("UPDATE webhook_deliveries SET status = 'sent', attempts = ?, response_code = ?, error = NULL, sent_at = ? WHERE id = ?").bind(attempts, code, now2, d.id),
        db.prepare("UPDATE webhook_endpoints SET failures = 0 WHERE id = ?").bind(d.endpoint_id),
      ]);
    } else {
      failed++;
      const delay = retryDelay(attempts);
      await db.batch([
        delay === null
          ? db.prepare("UPDATE webhook_deliveries SET status = 'failed', attempts = ?, response_code = ?, error = ? WHERE id = ?").bind(attempts, code, error, d.id)
          : db.prepare("UPDATE webhook_deliveries SET attempts = ?, response_code = ?, error = ?, next_attempt_at = ? WHERE id = ?").bind(attempts, code, error, now2 + delay, d.id),
        db.prepare("UPDATE webhook_endpoints SET failures = failures + 1, active = CASE WHEN failures + 1 >= ? THEN 0 ELSE active END WHERE id = ?").bind(DISABLE_AFTER_FAILURES, d.endpoint_id),
      ]);
    }
  }
  // housekeeping: keep two weeks of history
  if (due.length === 0 && Math.random() < 0.05) await db.prepare("DELETE FROM webhook_deliveries WHERE status != 'pending' AND created_at < ?").bind(now - 14 * 86_400_000).run();
  return { sent, failed };
}

// ---------- payloads (never wages, SIN, pay slips or incidents) ----------
export async function staffData(db: D1Database, id: number) {
  return { staff: await db.prepare("SELECT id, name, first_name, last_name, email, phone, sex, lang, is_admin, active FROM staff WHERE id = ?").bind(id).first() };
}
export async function shiftData(db: D1Database, id: number) {
  return { shift: await db.prepare("SELECT id, staff_id, restaurant_id, role_id, start_at, end_at, until_close, notes, status FROM shifts WHERE id = ?").bind(id).first() };
}
export async function timeOffData(db: D1Database, id: number) {
  return { time_off: await db.prepare("SELECT id, staff_id, start_date, end_date, start_time, end_time, status, note, decision_note FROM time_off_requests WHERE id = ?").bind(id).first() };
}
export async function coverageData(db: D1Database, id: number) {
  return { request: await db.prepare("SELECT id, shift_id, restaurant_id, role_id, sick_staff_id, start_at, end_at, status, filled_by FROM coverage_requests WHERE id = ?").bind(id).first() };
}
