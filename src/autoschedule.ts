// Automatic creation of next week's schedules: the settings, the timing rules and the text of the notice. Pure, so it can be tested.
import { formatDate, type Lang, type Msg } from "./templates.ts";

/** Departments that get a schedule of their own (the administration has none). */
export const AUTO_DEPTS = ["floor", "kitchen", "prep", "delivery"] as const;

export interface AutoSettings {
  enabled: boolean;
  dow: number;            // day of the week the schedules are created, 0 = Sunday … 6 = Saturday (4 = Thursday: the night of Wednesday to Thursday)
  hour: number;           // from this hour (0-23, local time) on that day
  notify_hour: number;    // the notice goes out at this hour: the same day when later than `hour`, else the next day
  email: boolean;
  sms: boolean;           // neither ticked = each person is told the way their own file says
  recipients: number[] | null; // staff ids; null = every active administrator
  scope: string[] | null;      // "restaurantId:department"; null = everything
  extra: string;          // extra instructions for the AI
  // reminders while the schedules are still not published
  reminders: boolean;
  reminder_days: number[];           // days after the creation (1 = the day after); one reminder for each, until the week starts
  reminder_hour: number;             // hour of the day (local time)
  reminder_recipients: number[] | null; // null = the same people as the notice
  r_email: boolean;
  r_sms: boolean;                    // neither ticked = each person is reminded the way their own file says
}

export const DEFAULT_AUTO: AutoSettings = { enabled: true, dow: 4, hour: 2, notify_hour: 8, email: true, sms: false, recipients: null, scope: null, extra: "", reminders: true, reminder_days: [1, 2, 3], reminder_hour: 8, reminder_recipients: null, r_email: true, r_sms: false };

const int = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const idList = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).filter((x): x is number => Number.isInteger(x) && (x as number) > 0) : null);
const dayList = (v: unknown) => (Array.isArray(v) ? [...new Set((v as unknown[]).filter((x): x is number => int(x, 1, 14) !== null))].sort((a, b) => a - b).slice(0, 8) : null);

/** The stored JSON, completed with the defaults; anything unreadable falls back to the default. */
export function parseAuto(raw: string | null | undefined): AutoSettings {
  let o: Record<string, unknown> = {};
  try { const x = JSON.parse(raw ?? ""); if (x && typeof x === "object") o = x as Record<string, unknown>; } catch { /* defaults */ }
  const ids = idList(o.recipients);
  const scope = Array.isArray(o.scope) ? (o.scope as unknown[]).filter((x): x is string => typeof x === "string" && /^\d+:[a-z]+$/.test(x)) : null;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_AUTO.enabled,
    dow: int(o.dow, 0, 6) ?? DEFAULT_AUTO.dow, hour: int(o.hour, 0, 23) ?? DEFAULT_AUTO.hour, notify_hour: int(o.notify_hour, 0, 23) ?? DEFAULT_AUTO.notify_hour,
    email: typeof o.email === "boolean" ? o.email : DEFAULT_AUTO.email, sms: typeof o.sms === "boolean" ? o.sms : DEFAULT_AUTO.sms,
    recipients: ids, scope, extra: typeof o.extra === "string" ? o.extra.slice(0, 2000) : "",
    reminders: typeof o.reminders === "boolean" ? o.reminders : DEFAULT_AUTO.reminders, reminder_days: dayList(o.reminder_days) ?? DEFAULT_AUTO.reminder_days,
    reminder_hour: int(o.reminder_hour, 0, 23) ?? DEFAULT_AUTO.reminder_hour, reminder_recipients: idList(o.reminder_recipients),
    r_email: typeof o.r_email === "boolean" ? o.r_email : DEFAULT_AUTO.r_email, r_sms: typeof o.r_sms === "boolean" ? o.r_sms : DEFAULT_AUTO.r_sms,
  };
}

/** Checks a settings form; returns the value to store, or the name of the field that is wrong. */
export function validateAuto(b: unknown): { value: AutoSettings } | { error: string } {
  if (!b || typeof b !== "object") return { error: "invalid" };
  const o = b as Record<string, unknown>;
  if (typeof o.enabled !== "boolean") return { error: "enabled" };
  for (const [k, hi] of [["dow", 6], ["hour", 23], ["notify_hour", 23]] as const) if (int(o[k], 0, hi) === null) return { error: k };
  if (typeof o.email !== "boolean" || typeof o.sms !== "boolean") return { error: "channels" };
  if (o.recipients !== null && (!Array.isArray(o.recipients) || o.recipients.length > 100 || o.recipients.some((x) => !Number.isInteger(x) || (x as number) <= 0))) return { error: "recipients" };
  if (o.scope !== null && (!Array.isArray(o.scope) || o.scope.length > 200 || o.scope.some((x) => typeof x !== "string" || !/^\d+:[a-z]+$/.test(x)))) return { error: "scope" };
  if (typeof o.extra !== "string" || o.extra.length > 2000) return { error: "extra" };
  if (typeof o.reminders !== "boolean") return { error: "reminders" };
  if (!Array.isArray(o.reminder_days) || o.reminder_days.length > 8 || o.reminder_days.some((x) => int(x, 1, 14) === null)) return { error: "reminder_days" };
  if (int(o.reminder_hour, 0, 23) === null) return { error: "reminder_hour" };
  if (o.reminder_recipients !== null && (!Array.isArray(o.reminder_recipients) || o.reminder_recipients.length > 100 || o.reminder_recipients.some((x) => !Number.isInteger(x) || (x as number) <= 0))) return { error: "reminder_recipients" };
  if (typeof o.r_email !== "boolean" || typeof o.r_sms !== "boolean") return { error: "reminder_channels" };
  return { value: { enabled: o.enabled, dow: o.dow as number, hour: o.hour as number, notify_hour: o.notify_hour as number, email: o.email, sms: o.sms,
    recipients: o.recipients === null ? null : [...new Set(o.recipients as number[])], scope: o.scope === null ? null : [...new Set(o.scope as string[])], extra: o.extra.trim(),
    reminders: o.reminders, reminder_days: dayList(o.reminder_days) ?? [], reminder_hour: o.reminder_hour as number,
    reminder_recipients: o.reminder_recipients === null ? null : [...new Set(o.reminder_recipients as number[])], r_email: o.r_email, r_sms: o.r_sms } };
}

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dowOf = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

/** The Monday strictly after this date. */
export const nextMonday = (ymd: string) => addDays(ymd, ((8 - dowOf(ymd)) % 7) || 7);

/** What is due at this local time ('YYYY-MM-DDTHH:MM'): the week to plan and when to tell people, or null. */
export function autoDue(now: string, s: AutoSettings): { week: string; notifyAt: string } | null {
  const date = now.slice(0, 10), hour = Number(now.slice(11, 13));
  if (!s.enabled || dowOf(date) !== s.dow || hour < s.hour) return null;
  const hh = String(s.notify_hour).padStart(2, "0");
  return { week: nextMonday(date), notifyAt: `${s.notify_hour > s.hour ? date : addDays(date, 1)}T${hh}:00` };
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

/** The reminder to send now, if any: the latest of the chosen days that has come and was not sent yet. Never once the week has started. */
export function reminderDue(today: string, hour: number, runDate: string, week: string, sent: number[], s: AutoSettings): { day: number; sent: number[] } | null {
  if (!s.reminders || today >= week || hour < s.reminder_hour) return null;
  const since = daysBetween(today, runDate);
  const came = s.reminder_days.filter((d) => d <= since);
  if (!came.length || came.every((d) => sent.includes(d))) return null;
  return { day: Math.max(...came), sent: [...new Set([...sent, ...came])].sort((a, b) => a - b) }; // days that were missed are not sent one after the other
}

export const inAutoScope = (s: AutoSettings, restaurantId: number, dept: string) => s.scope === null || s.scope.includes(`${restaurantId}:${dept}`);

export interface AutoResult { restaurant_id: number; restaurant: string; department: string; status: "created" | "has_shifts" | "published" | "no_staff" | "failed"; shifts?: number; skipped?: number; warnings?: number; error?: string }

const DEPT_NAMES: Record<string, [string, string]> = { floor: ["Salle", "Floor"], kitchen: ["Cuisine", "Kitchen"], prep: ["Plonge / Préparation", "Dish / Prep"], delivery: ["Livraison", "Delivery"] };
export const deptName = (d: string, l: Lang) => DEPT_NAMES[d]?.[l === "en" ? 1 : 0] ?? d;

/** The notice sent to the people who check and publish the schedules. `sms` gives the short version. */
export function autoNotice(l: Lang, c: { week: string; url: string; brand: string; results: AutoResult[]; error?: string | null; sms: boolean }): Msg {
  const week = formatDate(c.week, l);
  const created = c.results.filter((r) => r.status === "created" && (r.shifts ?? 0) > 0);
  const total = created.reduce((n, r) => n + (r.shifts ?? 0), 0);
  const failed = c.results.filter((r) => r.status === "failed");
  const fr = l === "fr";
  if (!created.length) {
    const why = c.error === "no_ai_key" ? (fr ? "la clé de l’IA n’est pas configurée" : "the AI key is not set up") : c.error ? (fr ? "erreur" : "error") : failed.length ? (fr ? "des erreurs sont survenues" : "errors occurred") : (fr ? "rien à planifier (horaires déjà faits ou personne à planifier)" : "nothing to plan (schedules already made, or nobody to schedule)");
    return fr
      ? { subject: `Horaires de la semaine du ${week} : rien n’a été créé`, text: c.sms ? `${c.brand}: aucun horaire créé automatiquement pour la semaine du ${week} (${why}). ${c.url}` : `La création automatique des horaires de la semaine du ${week} n’a rien produit : ${why}.\n\nOuvre l’application pour les faire à la main : ${c.url}` }
      : { subject: `Schedules for the week of ${week}: nothing was created`, text: c.sms ? `${c.brand}: no schedule was created automatically for the week of ${week} (${why}). ${c.url}` : `The automatic creation of the schedules for the week of ${week} produced nothing: ${why}.\n\nOpen the app to do them by hand: ${c.url}` };
  }
  const line = (r: AutoResult) => `• ${r.restaurant} · ${deptName(r.department, l)} : ${r.status === "created" ? (fr ? `${r.shifts} quarts` : `${r.shifts} shifts`) : r.status === "failed" ? (fr ? "échec" : "failed") : r.status === "published" ? (fr ? "déjà publié, non touché" : "already published, untouched") : (fr ? "déjà planifié, non touché" : "already planned, untouched")}`;
  const lines = c.results.filter((r) => r.status !== "no_staff").map(line).join("\n");
  const warn = failed.length ? (fr ? `\n\nAttention : ${failed.length} horaire(s) n’ont pas pu être créés.` : `\n\nNote: ${failed.length} schedule(s) could not be created.`) : "";
  return fr
    ? { subject: `Horaires de la semaine du ${week} prêts à vérifier`, text: c.sms ? `${c.brand}: les horaires de la semaine du ${week} sont créés (${total} quarts, en brouillon). Vérifie-les et publie-les : ${c.url}` : `Les horaires de la semaine du ${week} ont été créés automatiquement cette nuit. Ils sont en brouillon : personne ne les voit tant qu’ils ne sont pas publiés.\n\n${lines}${warn}\n\nVérifie-les, corrige au besoin, puis publie-les : ${c.url}` }
    : { subject: `Schedules for the week of ${week} are ready to check`, text: c.sms ? `${c.brand}: the schedules for the week of ${week} were created (${total} shifts, as drafts). Check and publish them: ${c.url}` : `The schedules for the week of ${week} were created automatically overnight. They are drafts: nobody sees them until they are published.\n\n${lines}${warn}\n\nCheck them, fix what is needed, then publish them: ${c.url}` };
}

/** The reminder: these schedules are still drafts. `pending` = the schedules not published yet; `days` = days since they were created. */
export function autoReminder(l: Lang, c: { week: string; url: string; brand: string; pending: { restaurant: string; department: string }[]; days: number; daysLeft: number; sms: boolean }): Msg {
  const week = formatDate(c.week, l);
  const fr = l === "fr";
  const list = c.pending.map((p) => `• ${p.restaurant} · ${deptName(p.department, l)}`).join("\n");
  const left = fr ? (c.daysLeft <= 1 ? "la semaine commence demain" : `la semaine commence dans ${c.daysLeft} jours`) : (c.daysLeft <= 1 ? "the week starts tomorrow" : `the week starts in ${c.daysLeft} days`);
  return fr
    ? { subject: `Rappel : horaires de la semaine du ${week} pas encore publiés`, text: c.sms ? `${c.brand}: rappel, les horaires de la semaine du ${week} ne sont pas publiés (${left}). Vérifie-les et publie-les : ${c.url}` : `Rappel : les horaires de la semaine du ${week} créés automatiquement il y a ${c.days} jour${c.days > 1 ? "s" : ""} ne sont pas encore publiés (${left}). Les employés ne les voient pas.\n\n${list}\n\nVérifie-les et publie-les : ${c.url}` }
    : { subject: `Reminder: schedules for the week of ${week} not published yet`, text: c.sms ? `${c.brand}: reminder, the schedules for the week of ${week} are not published (${left}). Check and publish them: ${c.url}` : `Reminder: the schedules for the week of ${week}, created automatically ${c.days} day${c.days > 1 ? "s" : ""} ago, are not published yet (${left}). Employees cannot see them.\n\n${list}\n\nCheck and publish them: ${c.url}` };
}
