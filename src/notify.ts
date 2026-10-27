// Sending SMS / email to employees and logging every attempt. Talks to D1, Twilio and an SMTP server.
import { parseConnections, pickChannel, type Channel, type ConnEnv, type Connections } from "./connections.ts";
import { sendTwilioSms } from "./twilio.ts";
import { sendMailOverSocket } from "./smtp-socket.ts";
import type { Lang, Msg } from "./templates.ts";

export interface StaffContact { id: number; name: string; phone: string | null; email: string | null; lang: string; notify_channel: string }

export async function loadConnections(env: ConnEnv, db: D1Database): Promise<Connections> {
  const rows = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'conn\\_%' ESCAPE '\\'").all<{ key: string; value: string }>();
  return parseConnections(rows.results, env);
}

async function log(db: D1Database, e: { staff_id: number | null; channel: Channel; to: string | null; subject: string | null; body: string; kind: string; status: "sent" | "failed" | "skipped"; error?: string }) {
  await db.prepare("INSERT INTO notifications (created_at, staff_id, channel, to_addr, subject, body, kind, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(Date.now(), e.staff_id, e.channel, e.to, e.subject, e.body, e.kind, e.status, e.error ?? null).run();
}

/** Sends one message on one channel and logs the outcome. Never throws. */
export async function deliver(db: D1Database, conn: Connections, channel: Channel, to: string, msg: Msg, kind: string, staffId: number | null): Promise<{ ok: boolean; error?: string }> {
  let result: { ok: boolean; error?: string };
  try {
    if (channel === "sms") {
      result = conn.twilio ? await sendTwilioSms(conn.twilio, to, msg.text) : { ok: false, error: "SMS not configured" };
    } else if (conn.smtp) {
      await sendMailOverSocket({ host: conn.smtp.host, port: conn.smtp.port, secure: conn.smtp.secure, user: conn.smtp.user, pass: conn.smtp.pass }, { from: conn.smtp.from, to, subject: msg.subject, text: msg.text });
      result = { ok: true };
    } else result = { ok: false, error: "Email not configured" };
  } catch (e) {
    result = { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  await log(db, { staff_id: staffId, channel, to, subject: msg.subject, body: msg.text, kind, status: result.ok ? "sent" : "failed", error: result.error });
  return result;
}

/** Messages one employee on their preferred working channel, in their language. */
export async function notifyStaff(db: D1Database, conn: Connections, person: StaffContact, build: (lang: Lang, channel: Channel) => Msg, kind: string): Promise<"sent" | "failed" | "skipped" | "no_channel"> {
  const lang: Lang = person.lang === "en" ? "en" : "fr";
  const channel = pickChannel(person, { sms: !!conn.twilio, email: !!conn.smtp });
  if (!channel) {
    const msg = build(lang, "sms");
    await log(db, { staff_id: person.id, channel: person.notify_channel === "email" ? "email" : "sms", to: null, subject: msg.subject, body: msg.text, kind, status: "skipped", error: "no usable channel (missing contact or messaging not set up)" });
    return "no_channel";
  }
  const r = await deliver(db, conn, channel, channel === "sms" ? person.phone! : person.email!, build(lang, channel), kind, person.id);
  return r.ok ? "sent" : "failed";
}

/** Managers of a department at a restaurant, plus every admin (deduplicated). */
export async function managersOf(db: D1Database, restaurantId: number, departmentId: string): Promise<StaffContact[]> {
  const r = await db.prepare(
    `SELECT DISTINCT s.id, s.name, s.phone, s.email, s.lang, s.notify_channel FROM staff s
     WHERE s.active = 1 AND (s.is_admin = 1 OR s.id IN (SELECT staff_id FROM managers WHERE restaurant_id = ? AND department_id = ?))`,
  ).bind(restaurantId, departmentId).all<StaffContact>();
  return r.results;
}

export async function notifyManagers(db: D1Database, conn: Connections, restaurantId: number, departmentId: string, build: (lang: Lang, channel: Channel) => Msg, kind: string) {
  const people = await managersOf(db, restaurantId, departmentId);
  for (const p of people) await notifyStaff(db, conn, p, build, kind);
  return people.length;
}
