// Delivery vehicles: the tire seasons (Québec) and the texts of the reminders and problem reports. Pure, so it can be tested.
// Québec Highway Safety Code: winter tires are compulsory from December 1 to March 15 (inclusive); studded tires are allowed
// from October 15 to May 1. The dates below are the defaults and can be changed in the settings.
import { formatDate, type Lang, type Msg } from "./templates.ts";

export interface VehicleSettings {
  enabled: boolean;
  fall_deadline: string;      // "MM-DD": winter tires must be on by this day
  spring_start: string;       // "MM-DD": from this day the winter tires may come off
  spring_deadline: string;    // "MM-DD": studded tires must be off by this day
  offsets: number[];          // reminders this many days before a deadline (0 = on the day)
  hour: number;               // hour of the reminders (local time)
  recipients: number[] | null; // staff ids; null = administrators and the delivery managers
  email: boolean;
  sms: boolean;               // neither ticked = each person is told the way their own file says
}
export const DEFAULT_VEHICLES: VehicleSettings = { enabled: true, fall_deadline: "12-01", spring_start: "03-16", spring_deadline: "05-01", offsets: [45, 30, 14, 7, 3, 1, 0], hour: 8, recipients: null, email: true, sms: false };

const MD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const validMd = (s: unknown): s is string => typeof s === "string" && MD.test(s) && !Number.isNaN(Date.parse(`2024-${s}T00:00:00Z`)) && new Date(`2024-${s}T00:00:00Z`).toISOString().slice(5, 10) === s;
const int = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const offsetList = (v: unknown) => (Array.isArray(v) ? [...new Set((v as unknown[]).filter((x): x is number => int(x, 0, 120) !== null))].sort((a, b) => b - a).slice(0, 10) : null);
const idList = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).filter((x): x is number => Number.isInteger(x) && (x as number) > 0) : null);

export function parseVehicleSettings(raw: string | null | undefined): VehicleSettings {
  let o: Record<string, unknown> = {};
  try { const x = JSON.parse(raw ?? ""); if (x && typeof x === "object") o = x as Record<string, unknown>; } catch { /* defaults */ }
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_VEHICLES.enabled,
    fall_deadline: validMd(o.fall_deadline) ? o.fall_deadline : DEFAULT_VEHICLES.fall_deadline, spring_start: validMd(o.spring_start) ? o.spring_start : DEFAULT_VEHICLES.spring_start,
    spring_deadline: validMd(o.spring_deadline) ? o.spring_deadline : DEFAULT_VEHICLES.spring_deadline,
    offsets: offsetList(o.offsets) ?? DEFAULT_VEHICLES.offsets, hour: int(o.hour, 0, 23) ?? DEFAULT_VEHICLES.hour, recipients: idList(o.recipients),
    email: typeof o.email === "boolean" ? o.email : DEFAULT_VEHICLES.email, sms: typeof o.sms === "boolean" ? o.sms : DEFAULT_VEHICLES.sms,
  };
}

export function validateVehicleSettings(b: unknown): { value: VehicleSettings } | { error: string } {
  if (!b || typeof b !== "object") return { error: "invalid" };
  const o = b as Record<string, unknown>;
  if (typeof o.enabled !== "boolean") return { error: "enabled" };
  for (const k of ["fall_deadline", "spring_start", "spring_deadline"]) if (!validMd(o[k])) return { error: k };
  if (!Array.isArray(o.offsets) || o.offsets.length > 10 || o.offsets.some((x) => int(x, 0, 120) === null)) return { error: "offsets" };
  if (int(o.hour, 0, 23) === null) return { error: "hour" };
  if (o.recipients !== null && (!Array.isArray(o.recipients) || o.recipients.length > 100 || o.recipients.some((x) => !Number.isInteger(x) || (x as number) <= 0))) return { error: "recipients" };
  if (typeof o.email !== "boolean" || typeof o.sms !== "boolean") return { error: "channels" };
  if ((o.spring_start as string) > (o.spring_deadline as string)) return { error: "spring_dates" };
  return { value: { enabled: o.enabled, fall_deadline: o.fall_deadline as string, spring_start: o.spring_start as string, spring_deadline: o.spring_deadline as string, offsets: offsetList(o.offsets) ?? [], hour: o.hour as number,
    recipients: o.recipients === null ? null : [...new Set(o.recipients as number[])], email: o.email, sms: o.sms } };
}

const days = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

export type Season = "fall" | "spring";
export interface SeasonNow { season: Season; key: string; deadline: string; opens: string | null; days_left: number; target: "winter" | "summer" }

/** The tire change that matters today: the next deadline (this year's spring, this year's fall, or next spring) and the season it belongs to. */
export function currentSeason(today: string, s: VehicleSettings): SeasonNow {
  const y = Number(today.slice(0, 4));
  const spring = (yr: number) => ({ season: "spring" as const, deadline: `${yr}-${s.spring_deadline}`, opens: `${yr}-${s.spring_start}` as string | null, target: "summer" as const });
  const fall = (yr: number) => ({ season: "fall" as const, deadline: `${yr}-${s.fall_deadline}`, opens: null as string | null, target: "winter" as const });
  const pick = [spring(y), fall(y), spring(y + 1), fall(y + 1)].sort((a, b) => (a.deadline < b.deadline ? -1 : 1)).find((c) => c.deadline >= today)!;
  return { season: pick.season, key: `${pick.season}-${pick.deadline.slice(0, 4)}`, deadline: pick.deadline, opens: pick.opens, days_left: days(pick.deadline, today), target: pick.target };
}

/** The reminder to send now, if any: the latest "days before" mark that has come and was not sent yet (all that came are marked). */
export function tireReminderDue(today: string, hour: number, s: VehicleSettings, sent: number[]): { season: SeasonNow; offset: number; mark: number[] } | null {
  if (!s.enabled || hour < s.hour) return null;
  const now = currentSeason(today, s);
  if (now.opens && today < now.opens) return null;                       // spring: nothing before the change opens
  const marks: number[] = [];
  if (now.opens && today >= now.opens) marks.push(999);                  // "the change is open": once
  marks.push(...s.offsets.filter((o) => o >= now.days_left));
  const fresh = marks.filter((m) => !sent.includes(m));
  if (!fresh.length) return null;
  const offset = fresh.includes(999) && fresh.length === 1 ? 999 : Math.min(...fresh.filter((m) => m !== 999));
  return { season: now, offset: Number.isFinite(offset) ? offset : 999, mark: [...new Set([...sent, ...marks])] };
}

export const VEHICLE_CATEGORIES = ["tires", "brakes", "engine", "lights", "body", "cleanliness", "other"] as const;
const CAT: Record<string, [string, string]> = { tires: ["Pneus", "Tires"], brakes: ["Freins", "Brakes"], engine: ["Moteur ou témoin allumé", "Engine or warning light"], lights: ["Éclairage", "Lights"], body: ["Carrosserie ou dommage", "Body or damage"], cleanliness: ["Propreté", "Cleanliness"], other: ["Autre", "Other"] };
export const categoryName = (c: string, l: Lang) => CAT[c]?.[l === "en" ? 1 : 0] ?? c;

const dateText = (ymd: string, l: Lang) => formatDate(ymd, l);

/** The tire reminder. `pending` = the vehicles that still have the wrong tires. */
export function tireNotice(l: Lang, c: { season: SeasonNow; pending: string[]; url: string; brand: string; offset: number; sms: boolean }): Msg {
  const fr = l === "fr", winter = c.season.target === "winter";
  const d = dateText(c.season.deadline, l);
  const left = c.season.days_left <= 0 ? (fr ? "c’est aujourd’hui la date limite" : "today is the deadline") : fr ? `il reste ${c.season.days_left} jour${c.season.days_left > 1 ? "s" : ""}` : `${c.season.days_left} day${c.season.days_left > 1 ? "s" : ""} left`;
  const list = c.pending.map((v) => `• ${v}`).join("\n");
  const open = c.offset === 999;
  const subject = winter
    ? (fr ? `Pneus d’hiver : ${c.pending.length} véhicule${c.pending.length > 1 ? "s" : ""} à changer avant le ${d}` : `Winter tires: ${c.pending.length} vehicle${c.pending.length > 1 ? "s" : ""} to change before ${d}`)
    : (open ? (fr ? `Pneus : les pneus d’hiver peuvent être retirés (${c.pending.length} véhicule${c.pending.length > 1 ? "s" : ""})` : `Tires: winter tires may come off (${c.pending.length} vehicle${c.pending.length > 1 ? "s" : ""})`)
      : (fr ? `Pneus à clous : ${c.pending.length} véhicule${c.pending.length > 1 ? "s" : ""} à changer avant le ${d}` : `Studded tires: ${c.pending.length} vehicle${c.pending.length > 1 ? "s" : ""} to change before ${d}`));
  if (c.sms) return { subject, text: fr ? `${c.brand}: ${subject} (${left}). ${c.url}` : `${c.brand}: ${subject} (${left}). ${c.url}` };
  const law = winter
    ? (fr ? "Au Québec, les pneus d’hiver sont obligatoires du 1er décembre au 15 mars." : "In Québec, winter tires are compulsory from December 1 to March 15.")
    : (fr ? "Au Québec, les pneus à clous doivent être retirés avant le 1er mai (ils sont permis du 15 octobre au 1er mai)." : "In Québec, studded tires must come off before May 1 (they are allowed from October 15 to May 1).");
  return fr
    ? { subject, text: `${law}\n\nDate limite : ${d} (${left}).\n\nVéhicules à changer :\n${list}\n\nQuand c’est fait, ouvre Listes → Véhicules et touche « Pneus changés » : ${c.url}` }
    : { subject, text: `${law}\n\nDeadline: ${d} (${left}).\n\nVehicles to change:\n${list}\n\nWhen it is done, open Lists → Vehicles and tap “Tires changed”: ${c.url}` };
}

/** A problem reported by a driver, for the people who look after the vehicles. */
export function issueNotice(l: Lang, c: { vehicle: string; restaurant: string; by: string; severity: "urgent" | "normal"; category: string; description: string; url: string; brand: string; sms: boolean }): Msg {
  const fr = l === "fr", urgent = c.severity === "urgent";
  const cat = categoryName(c.category, l);
  const subject = fr ? `${urgent ? "🚨 URGENT · " : ""}Problème de véhicule : ${c.vehicle} (${cat})` : `${urgent ? "🚨 URGENT · " : ""}Vehicle problem: ${c.vehicle} (${cat})`;
  if (c.sms) return { subject, text: `${c.brand}: ${urgent ? (fr ? "URGENT, ne plus utiliser. " : "URGENT, do not use. ") : ""}${c.vehicle} · ${cat} : ${c.description.slice(0, 100)} (${c.by}) ${c.url}` };
  return fr
    ? { subject, text: `${c.by} signale un problème avec ${c.vehicle} (${c.restaurant}).\n\nType : ${cat}\nGravité : ${urgent ? "URGENT : ne plus utiliser le véhicule" : "à régler bientôt"}\n\n${c.description}\n\nOuvre Listes → Véhicules pour suivre et régler le problème : ${c.url}` }
    : { subject, text: `${c.by} reports a problem with ${c.vehicle} (${c.restaurant}).\n\nType: ${cat}\nSeverity: ${urgent ? "URGENT: stop using the vehicle" : "to fix soon"}\n\n${c.description}\n\nOpen Lists → Vehicles to follow and fix the problem: ${c.url}` };
}
