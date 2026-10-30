// "Your shift starts soon" reminders. Run by the 5-minute cron: for every reminder an employee set up, find their published shifts
// that start `minutes_before` from now (give or take the cron period) and send one message each, once.
import type { ConnEnv } from "./connections.ts";
import { deliver, loadConnections, notifyStaff } from "./notify.ts";
import { pushToStaff } from "./push.ts";
import { T } from "./templates.ts";
import { localNow, mondayOfDate } from "./week.ts";
import { progress as checklistProgress } from "./checklists.ts";

export const REMINDER_CHANNELS = ["push", "sms", "email"] as const;
export const MAX_REMINDERS = 5;
// a reminder that is more than this late (cron outage, shift added at the last minute) is dropped instead of sent
const GRACE_MIN = 20;

const asMs = (local: string) => Date.parse(`${local}:00Z`);
const toLocal = (ms: number) => new Date(ms).toISOString().slice(0, 16);

interface Env extends ConnEnv { TIMEZONE?: string }

export async function sendShiftReminders(env: Env, db: D1Database, nowLocalStr = localNow(env.TIMEZONE)): Promise<number> {
  const reminders = (await db.prepare(
    `SELECT r.id, r.staff_id, r.minutes_before, r.channel, r.anchor, s.name, s.phone, s.email, s.lang, s.notify_channel, s.client_id
     FROM shift_reminders r JOIN staff s ON s.id = r.staff_id WHERE s.active = 1`,
  ).all<{ id: number; staff_id: number; minutes_before: number; channel: string; anchor: string; name: string; phone: string | null; email: string | null; lang: string; notify_channel: string; client_id: number }>()).results;
  if (!reminders.length) return 0;
  const now = asMs(nowLocalStr);
  const horizon = toLocal(now + Math.max(...reminders.map((r) => r.minutes_before)) * 60_000);
  const staffIds = [...new Set(reminders.map((r) => r.staff_id))];
  const shifts = (await db.prepare(
    `SELECT sh.id, sh.staff_id, sh.role_id, sh.start_at, sh.end_at, sh.until_close, sh.restaurant_id, ro.department_id, ro.name_fr, ro.name_en, rs.name AS restaurant
     FROM shifts sh JOIN roles ro ON ro.id = sh.role_id JOIN restaurants rs ON rs.id = sh.restaurant_id
     WHERE sh.status = 'ok' AND sh.end_at > ? AND sh.start_at <= ? AND sh.staff_id IN (${staffIds.map(() => "?").join(",")})`,
  ).bind(nowLocalStr, horizon, ...staffIds).all<{ id: number; staff_id: number; role_id: number; start_at: string; end_at: string; until_close: number; restaurant_id: number; department_id: string; name_fr: string; name_en: string; restaurant: string }>()).results;
  if (!shifts.length) return 0;
  // only shifts of a published schedule (a draft is not visible to the employee)
  const weeks = [...new Set(shifts.map((x) => mondayOfDate(x.start_at.slice(0, 10))))];
  const pubs = new Set((await db.prepare(`SELECT restaurant_id, department_id, week_start FROM schedule_publications WHERE week_start IN (${weeks.map(() => "?").join(",")})`).bind(...weeks).all<{ restaurant_id: number; department_id: string; week_start: string }>()).results
    .map((p) => `${p.restaurant_id}|${p.department_id}|${p.week_start}`));
  const conns = new Map<number, Awaited<ReturnType<typeof loadConnections>>>();
  let sent = 0;
  for (const r of reminders) {
    for (const sh of shifts.filter((x) => x.staff_id === r.staff_id)) {
      if (!pubs.has(`${sh.restaurant_id}|${sh.department_id}|${mondayOfDate(sh.start_at.slice(0, 10))}`)) continue;
      const atEnd = r.anchor === "end";
      const ref = asMs(atEnd ? sh.end_at : sh.start_at);
      const due = ref - r.minutes_before * 60_000;
      if (ref <= now || due > now || now - due > GRACE_MIN * 60_000) continue;
      // "shift ends soon": only for people who still have a checklist to do
      if (atEnd) {
        const p = await checklistProgress(db, { id: sh.id, staff_id: sh.staff_id, restaurant_id: sh.restaurant_id, role_id: sh.role_id, start_at: sh.start_at, end_at: sh.end_at }, r.client_id);
        const kitchen = sh.department_id === "kitchen";
        if ((!p.total && !kitchen) || (p.total && p.done === p.total)) continue;
      }
      const claim = await db.prepare("INSERT OR IGNORE INTO shift_reminder_log (reminder_id, shift_id, sent_at) VALUES (?, ?, ?)").bind(r.id, sh.id, Date.now()).run();
      if (!claim.meta.changes) continue; // already sent
      let conn = conns.get(r.client_id);
      if (!conn) { conn = await loadConnections(env, db, r.client_id); conns.set(r.client_id, conn); }
      const lang = r.lang === "en" ? "en" : "fr";
      const build = (channelIsSms: boolean) => atEnd ? T.shiftEndReminder(lang, { minutes: r.minutes_before, restaurant: sh.restaurant, url: `${conn!.appUrl.replace(/\/$/, "")}/?view=checklist`, sms: channelIsSms }) : T.shiftReminder(lang, { minutes: r.minutes_before, restaurant: sh.restaurant, role: lang === "fr" ? sh.name_fr : sh.name_en, start: sh.start_at.slice(11, 16), end: sh.end_at.slice(11, 16), untilClose: !!sh.until_close, url: conn!.appUrl, sms: channelIsSms });
      const person = { id: r.staff_id, name: r.name, phone: r.phone, email: r.email, lang: r.lang, notify_channel: r.notify_channel };
      let done = false;
      if (r.channel === "push") {
        const m = build(false);
        done = (await pushToStaff(db, r.staff_id, { title: m.subject, body: m.short, url: atEnd ? "/?view=checklist" : "/?view=mine", tag: `shift-${sh.id}-${atEnd ? "end" : "start"}` }, { urgent: true, appUrl: conn.appUrl }).catch(() => 0)) > 0;
        if (done) await db.prepare("INSERT INTO notifications (created_at, staff_id, channel, to_addr, subject, body, kind, status) VALUES (?, ?, 'push', NULL, ?, ?, 'shift_reminder', 'sent')").bind(Date.now(), r.staff_id, m.subject, m.text).run();
      } else if (r.channel === "sms" && conn.twilio && r.phone) {
        done = (await deliver(db, conn, "sms", r.phone, build(true), "shift_reminder", r.staff_id)).ok;
      } else if (r.channel === "email" && conn.smtp && r.email) {
        done = (await deliver(db, conn, "email", r.email, build(false), "shift_reminder", r.staff_id)).ok;
      }
      // chosen way not available (no device, no phone…): the person's usual channel
      if (!done) done = (await notifyStaff(db, conn, person, (_l, ch) => build(ch === "sms"), "shift_reminder_fallback")) === "sent";
      if (done) sent++;
    }
  }
  // keep the log small
  await db.prepare("DELETE FROM shift_reminder_log WHERE sent_at < ?").bind(Date.now() - 14 * 86_400_000).run();
  return sent;
}
