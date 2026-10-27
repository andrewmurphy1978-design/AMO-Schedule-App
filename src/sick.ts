// Sick-call replacement flow: report -> notify managers -> offer to everyone eligible at once -> first "yes" wins
// -> otherwise escalate to the managers. All state lives in D1 so a Cloudflare cron can finish what a request started.
import type { Connections, ConnEnv } from "./connections.ts";
import { chooseCandidates, byFewestHours, type Candidate } from "./eligibility.ts";
import { loadConnections, notifyManagers, notifyStaff, type StaffContact } from "./notify.ts";
import { loadSettingsFrom } from "./settings-db.ts";
import { T, formatWhen, type Ctx, type Lang } from "./templates.ts";
import { localNow, mondayOfDate, weekBounds } from "./week.ts";

export interface FlowEnv extends ConnEnv { TIMEZONE?: string }

export class FlowError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}

interface ShiftRow {
  id: number; staff_id: number; restaurant_id: number; role_id: number; start_at: string; end_at: string; until_close: number; status: string;
  department_id: string; name_fr: string; name_en: string; restaurant: string; staff_name: string;
}

const shiftSql = `SELECT sh.id, sh.staff_id, sh.restaurant_id, sh.role_id, sh.start_at, sh.end_at, sh.until_close, sh.status,
  ro.department_id, ro.name_fr, ro.name_en, rs.name AS restaurant, s.name AS staff_name
  FROM shifts sh JOIN roles ro ON ro.id = sh.role_id JOIN restaurants rs ON rs.id = sh.restaurant_id JOIN staff s ON s.id = sh.staff_id`;

const ctxOf = (r: { restaurant: string; name_fr: string; name_en: string; start_at: string; end_at: string; until_close: number }, lang: Lang): Ctx => ({
  restaurant: r.restaurant, role: lang === "fr" ? r.name_fr : r.name_en, when: formatWhen(r.start_at, r.end_at, !!r.until_close, lang),
});

function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------- who can be asked ----------
export async function gatherCandidates(db: D1Database, req: { restaurant_id: number; role_id: number; start_at: string; end_at: string; sick_staff_id: number }, settings: { overtime_hours: number; replacement_allow_overtime: boolean }) {
  const people = (await db.prepare(
    `SELECT s.id, s.name, s.phone, s.email, s.lang, s.notify_channel FROM staff_roles sr JOIN staff s ON s.id = sr.staff_id
     WHERE sr.restaurant_id = ? AND sr.role_id = ? AND s.id != ?`,
  ).bind(req.restaurant_id, req.role_id, req.sick_staff_id).all<StaffContact>()).results;
  if (!people.length) return { contacts: new Map<number, StaffContact>(), eligible: [] as Candidate[], excluded: [] as { staff_id: number; name: string; reason: string }[] };
  const marks = people.map(() => "?").join(",");
  const day = req.start_at.slice(0, 10);
  const bounds = weekBounds(mondayOfDate(day))!;
  const hours = new Map<number, number>();
  for (const r of (await db.prepare(
    `SELECT staff_id, sum((julianday(end_at) - julianday(start_at)) * 24) AS h FROM shifts WHERE status = 'ok' AND staff_id IN (${marks}) AND start_at >= ? AND start_at < ? GROUP BY staff_id`,
  ).bind(...people.map((p) => p.id), bounds.start, bounds.end).all<{ staff_id: number; h: number }>()).results) hours.set(r.staff_id, r.h);
  const near = new Map<number, { start_at: string; end_at: string }[]>();
  const d0 = new Date(`${day}T00:00:00Z`); d0.setUTCDate(d0.getUTCDate() - 1);
  const d1 = new Date(`${day}T00:00:00Z`); d1.setUTCDate(d1.getUTCDate() + 2);
  for (const r of (await db.prepare(
    `SELECT staff_id, start_at, end_at FROM shifts WHERE status = 'ok' AND staff_id IN (${marks}) AND start_at >= ? AND start_at < ?`,
  ).bind(...people.map((p) => p.id), `${d0.toISOString().slice(0, 10)}T00:00`, `${d1.toISOString().slice(0, 10)}T00:00`).all<{ staff_id: number; start_at: string; end_at: string }>()).results)
    near.set(r.staff_id, [...(near.get(r.staff_id) ?? []), { start_at: r.start_at, end_at: r.end_at }]);
  const cands: Candidate[] = people.map((p) => ({ staff_id: p.id, name: p.name, has_phone: !!p.phone, has_email: !!p.email, week_hours: hours.get(p.id) ?? 0, shifts: near.get(p.id) ?? [] }));
  const r = chooseCandidates(req, req.sick_staff_id, cands, { overtime_hours: settings.overtime_hours, allow_overtime: settings.replacement_allow_overtime });
  return { contacts: new Map(people.map((p) => [p.id, p])), eligible: r.eligible.sort(byFewestHours), excluded: r.excluded };
}

// ---------- report a sick call ----------
export async function startSickCall(env: FlowEnv, db: D1Database, shiftId: number, actorId: number | null) {
  const shift = await db.prepare(`${shiftSql} WHERE sh.id = ?`).bind(shiftId).first<ShiftRow>();
  if (!shift) throw new FlowError("not_found", 404);
  if (shift.status !== "ok") throw new FlowError("already_sick", 409);
  if (shift.end_at <= localNow(env.TIMEZONE)) throw new FlowError("shift_over", 422);

  const claim = await db.prepare("UPDATE shifts SET status = 'sick_open' WHERE id = ? AND status = 'ok'").bind(shiftId).run();
  if (!claim.meta.changes) throw new FlowError("already_sick", 409);
  const created = await db.prepare(
    "INSERT INTO coverage_requests (shift_id, restaurant_id, role_id, sick_staff_id, start_at, end_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(shift.id, shift.restaurant_id, shift.role_id, shift.staff_id, shift.start_at, shift.end_at, actorId, Date.now()).run();
  const requestId = created.meta.last_row_id as number;

  const conn = await loadConnections(env, db);
  const settings = await loadSettingsFrom(db);
  const found = await gatherCandidates(db, { restaurant_id: shift.restaurant_id, role_id: shift.role_id, start_at: shift.start_at, end_at: shift.end_at, sick_staff_id: shift.staff_id }, settings);

  // Offer to everyone eligible, all at once.
  let offersSent = 0;
  for (const cand of found.eligible.slice(0, 40)) {
    const person = found.contacts.get(cand.staff_id)!;
    const token = newToken();
    const url = conn.appUrl ? `${conn.appUrl}/r/${token}` : "";
    const outcome = await notifyStaff(db, conn, person, (lang, channel) => T.offer(lang, { ...ctxOf(shift, lang), url, sms: channel === "sms" }), "offer");
    if (outcome === "sent") {
      await db.prepare("INSERT INTO coverage_offers (request_id, staff_id, token, channel, sent_at) VALUES (?, ?, ?, ?, ?)")
        .bind(requestId, person.id, token, person.notify_channel === "email" ? "email" : "sms", Date.now()).run();
      offersSent++;
    }
  }
  // Managers hear about it immediately (information only).
  await notifyManagers(db, conn, shift.restaurant_id, shift.department_id, (lang) => T.sickNotice(lang, { ...ctxOf(shift, lang), sick: shift.staff_name, offers: offersSent }), "sick_notice");
  // Nobody could even be asked: tell the managers to act right away.
  let escalated = false;
  if (offersSent === 0) escalated = await escalate(env, db, conn, requestId);
  return { request_id: requestId, offers_sent: offersSent, excluded: found.excluded, escalated };
}

// ---------- someone answers an offer ----------
export async function answerOffer(env: FlowEnv, db: D1Database, offer: { id: number; request_id: number; staff_id: number; status: string }, accept: boolean): Promise<"accepted" | "declined" | "filled" | "closed" | "conflict"> {
  if (offer.status !== "sent") return offer.status === "accepted" ? "accepted" : offer.status === "declined" ? "declined" : "closed";
  const conn = await loadConnections(env, db);
  const req = await db.prepare("SELECT * FROM coverage_requests WHERE id = ?").bind(offer.request_id).first<{ id: number; shift_id: number; status: string; sick_staff_id: number }>();
  if (!req || req.status !== "open") {
    await db.prepare("UPDATE coverage_offers SET status = 'closed', responded_at = ? WHERE id = ? AND status = 'sent'").bind(Date.now(), offer.id).run();
    return "filled";
  }
  if (!accept) {
    await db.prepare("UPDATE coverage_offers SET status = 'declined', responded_at = ? WHERE id = ? AND status = 'sent'").bind(Date.now(), offer.id).run();
    const left = await db.prepare("SELECT count(*) AS n FROM coverage_offers WHERE request_id = ? AND status = 'sent'").bind(req.id).first<{ n: number }>();
    if (!left?.n) await escalate(env, db, conn, req.id); // everybody said no
    return "declined";
  }
  const result = await fillRequest(env, db, conn, req.id, offer.staff_id, "offer");
  return result === "filled_by_other" ? "filled" : result === "conflict" ? "conflict" : "accepted";
}

/** Gives the shift to `staffId` if the request is still open. Exactly one caller can win. */
export async function fillRequest(env: FlowEnv, db: D1Database, conn: Connections, requestId: number, staffId: number, via: "offer" | "manager"): Promise<"ok" | "filled_by_other" | "conflict"> {
  const req = await db.prepare("SELECT * FROM coverage_requests WHERE id = ?").bind(requestId).first<{ id: number; shift_id: number; sick_staff_id: number; start_at: string; end_at: string; status: string }>();
  if (!req) throw new FlowError("not_found", 404);
  if (req.status !== "open") return "filled_by_other";
  const clash = await db.prepare("SELECT 1 FROM shifts WHERE staff_id = ? AND status = 'ok' AND start_at < ? AND end_at > ? LIMIT 1").bind(staffId, req.end_at, req.start_at).first();
  if (clash) return "conflict";
  const claim = await db.prepare("UPDATE coverage_requests SET status = 'filled', filled_by = ?, filled_at = ? WHERE id = ? AND status = 'open'").bind(staffId, Date.now(), requestId).run();
  if (!claim.meta.changes) return "filled_by_other"; // somebody else got there first
  await db.batch([
    db.prepare("UPDATE shifts SET staff_id = ?, status = 'ok', replaced_staff_id = ? WHERE id = ?").bind(staffId, req.sick_staff_id, req.shift_id),
    db.prepare("UPDATE coverage_offers SET status = CASE WHEN staff_id = ? THEN 'accepted' ELSE 'closed' END, responded_at = ? WHERE request_id = ? AND status = 'sent'").bind(staffId, Date.now(), requestId),
  ]);
  const shift = await db.prepare(`${shiftSql} WHERE sh.id = ?`).bind(req.shift_id).first<ShiftRow>();
  if (!shift) return "ok";
  const winner = await db.prepare("SELECT id, name, phone, email, lang, notify_channel FROM staff WHERE id = ?").bind(staffId).first<StaffContact>();
  const sick = await db.prepare("SELECT name FROM staff WHERE id = ?").bind(req.sick_staff_id).first<{ name: string }>();
  if (winner) await notifyStaff(db, conn, winner, (lang) => T.accepted(lang, ctxOf(shift, lang)), "filled");
  // Everyone else who was asked: "already filled".
  const losers = (await db.prepare(
    `SELECT s.id, s.name, s.phone, s.email, s.lang, s.notify_channel FROM coverage_offers o JOIN staff s ON s.id = o.staff_id WHERE o.request_id = ? AND o.staff_id != ?`,
  ).bind(requestId, staffId).all<StaffContact>()).results;
  for (const p of losers) await notifyStaff(db, conn, p, (lang) => T.alreadyFilled(lang, ctxOf(shift, lang)), "closed");
  await notifyManagers(db, conn, shift.restaurant_id, shift.department_id, (lang) => T.managerFilled(lang, { ...ctxOf(shift, lang), sick: sick?.name ?? "", by: winner?.name ?? "" }), "filled");
  return "ok";
}

// ---------- nobody accepted ----------
export async function escalate(env: FlowEnv, db: D1Database, conn: Connections, requestId: number): Promise<boolean> {
  const claim = await db.prepare("UPDATE coverage_requests SET escalated_at = ? WHERE id = ? AND status = 'open' AND escalated_at IS NULL").bind(Date.now(), requestId).run();
  if (!claim.meta.changes) return false;
  const shift = await db.prepare(
    `${shiftSql} JOIN coverage_requests cr ON cr.shift_id = sh.id WHERE cr.id = ?`,
  ).bind(requestId).first<ShiftRow>();
  if (!shift) return false;
  const settings = await loadSettingsFrom(db);
  await notifyManagers(db, conn, shift.restaurant_id, shift.department_id, (lang) => T.escalation(lang, { ...ctxOf(shift, lang), sick: shift.staff_name, minutes: settings.sick_timeout_minutes }), "escalation");
  return true;
}

/** Cron: send the "take action" message for every open request that has waited too long. Returns how many. */
export async function escalateDue(env: FlowEnv, db: D1Database): Promise<number> {
  const settings = await loadSettingsFrom(db);
  const cutoff = Date.now() - settings.sick_timeout_minutes * 60_000;
  const due = (await db.prepare("SELECT id FROM coverage_requests WHERE status = 'open' AND escalated_at IS NULL AND created_at <= ?").bind(cutoff).all<{ id: number }>()).results;
  if (!due.length) return 0;
  const conn = await loadConnections(env, db);
  let n = 0;
  for (const r of due) if (await escalate(env, db, conn, r.id)) n++;
  return n;
}

export async function cancelRequest(db: D1Database, requestId: number) {
  const req = await db.prepare("SELECT shift_id, status FROM coverage_requests WHERE id = ?").bind(requestId).first<{ shift_id: number; status: string }>();
  if (!req) throw new FlowError("not_found", 404);
  if (req.status !== "open") throw new FlowError("not_open", 409);
  await db.batch([
    db.prepare("UPDATE coverage_requests SET status = 'cancelled' WHERE id = ?").bind(requestId),
    db.prepare("UPDATE shifts SET status = 'ok' WHERE id = ?").bind(req.shift_id),
    db.prepare("UPDATE coverage_offers SET status = 'closed', responded_at = ? WHERE request_id = ? AND status = 'sent'").bind(Date.now(), requestId),
  ]);
}
