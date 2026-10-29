// AI-generated schedule proposal: the prompt sent to Claude, reading its answer, and checking the proposal. Pure (no I/O) except callClaude.
// Names are limited to first names; wages, SIN, phones and emails are never sent.
// @ts-ignore plain JS modules shared with the browser
import { periodWindows, targetWindows, coverage, toMin } from "../public/coverage.js";
import { overlapsTimeOff, findUnavailable, type TimeOff, type Unavailable } from "./availability.ts";

export interface AiEmployee {
  id: number; first_name: string; is_new: boolean; promised_hours: number | null; max_weekly_hours: number | null; notes: string | null;
  roles: { id: number; name: string; department: string }[];
  fixed_days_off: number[]; days_off_replacement_ok: number[];
  unavailable: (Unavailable & { note?: string | null })[];
  time_off: (TimeOff & { status: string })[];
  kitchen_posts: string[];
}
export interface AiContext {
  lang: "fr" | "en";
  restaurant: { id: number; name: string; open_by_dow: string[]; close_by_dow: string[]; breakfast_by_dow: ({ start: string; end: string } | null)[] };
  week: { start: string; days: string[] };
  departments: string[];
  overtime_hours: number;
  period_boundaries: string[];
  targets: Record<string, Record<string, Record<string, number>>>; // date -> department -> period -> headcount
  pre_open_minutes: Record<string, number>;                          // role name -> minutes before opening
  employees: AiEmployee[];
  current_week_shifts: { staff_id: number; role_ids: number[]; date: string; start: string; end: string }[];
  already_planned_elsewhere: { staff_id: number; start_at: string; end_at: string }[]; // next week, other restaurants/departments
  existing_next_week: { staff_id: number; role_id: number; start_at: string; end_at: string }[];
}
export interface ProposedShift { staff_id: number; role_id: number; start_at: string; end_at: string; extra_role_ids?: number[]; until_close?: boolean; notes?: string }
export interface Proposal { shifts: ProposedShift[]; summary: string; concerns: string[] }

export const SYSTEM_PROMPT = `You are a scheduling assistant for a restaurant (Mikes, Québec). You build the staff schedule of ONE week.
Reply with ONE JSON object only (no markdown, no commentary) of this exact shape:
{"shifts":[{"staff_id":number,"role_id":number,"date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM","until_close":boolean,"notes":string}],"summary":string,"concerns":[string]}
Rules, in order of importance:
1. Only use employees and roles from "employees"; an employee can only work a role listed for them.
2. Never schedule someone during their time off (requested or approved), their unavailability, or on a fixed day off.
3. Never exceed "max_weekly_hours" of an employee, and keep everyone at or under "overtime_hours" per week. No two shifts of the same person may overlap, nor overlap "already_planned_elsewhere".
4. Meet the staffing "targets" (headcount per period for each date and department) as closely as possible, counting each shift once for its role's department. Targets are given per 30-minute interval, keyed by its start time, within opening hours.
5. Aim for each employee's "promised_hours" for the week (if any) without going over their maximum. Employees marked "is_new" have no history: give them a fair, reasonable first week.
6. Use "current_week_shifts" as the starting point: keep the same people at the same hours on the same weekdays unless a rule above forces a change.
7. Roles listed in "pre_open_minutes" start that many minutes before the restaurant opens. Shifts that run to closing use until_close=true and the closing time as "end".
8. Kitchen: with 4 or more cooks present each principal post (subs, starters, pasta, pizza) needs its own competent person ("kitchen_posts"); with breakfast hours the breakfast posts (bf_eggs, bf_back) must be covered then.
9. Respect the planner's extra instructions unless they break rules 1-3.
Times are local, 24-hour. A shift never crosses midnight. In "summary" describe in 2-4 sentences what you did; in "concerns" list anything you could not satisfy (empty list if none). Write summary and concerns in the language given by "language".`;

export function buildUserPrompt(ctx: AiContext, extra: string): string {
  const e = extra.trim();
  return JSON.stringify({ language: ctx.lang === "fr" ? "French" : "English", ...ctx, lang: undefined, planner_extra_instructions: e || null });
}

/** Extracts the JSON object from the model's answer and normalises it; throws on an unusable answer. */
export function parseProposal(text: string): Proposal {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no_json");
  let j: any;
  try { j = JSON.parse(m[0]); } catch { throw new Error("bad_json"); }
  if (!Array.isArray(j.shifts)) throw new Error("no_shifts");
  const shifts: ProposedShift[] = [];
  for (const s of j.shifts) {
    const staff_id = Number(s.staff_id), role_id = Number(s.role_id);
    if (!Number.isInteger(staff_id) || !Number.isInteger(role_id) || !/^\d{4}-\d{2}-\d{2}$/.test(s.date ?? "") || !/^\d{2}:\d{2}$/.test(s.start ?? "") || !/^\d{2}:\d{2}$/.test(s.end ?? "")) continue;
    const start_at = `${s.date}T${s.start}`;
    const endDate = s.end <= s.start ? nextDay(s.date) : s.date; // an "end" before the start means after midnight
    shifts.push({ staff_id, role_id, start_at, end_at: `${endDate}T${s.end}`, until_close: !!s.until_close, notes: typeof s.notes === "string" && s.notes ? s.notes.slice(0, 200) : undefined });
  }
  return { shifts, summary: typeof j.summary === "string" ? j.summary.slice(0, 1500) : "", concerns: Array.isArray(j.concerns) ? j.concerns.filter((x: unknown) => typeof x === "string").map((x: string) => x.slice(0, 300)).slice(0, 30) : [] };
}
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export interface Warning { staff_id?: number; date?: string; kind: string; text: string }

/** Checks a proposal against the facts the AI was given. Returns hard errors (shift dropped) and warnings (shown to the admin). */
export function checkProposal(ctx: AiContext, p: Proposal): { shifts: ProposedShift[]; warnings: Warning[]; dropped: { shift: ProposedShift; reason: string }[] } {
  const byId = new Map(ctx.employees.map((x) => [x.id, x]));
  const weekDays = new Set(ctx.week.days);
  const kept: ProposedShift[] = [], dropped: { shift: ProposedShift; reason: string }[] = [], warnings: Warning[] = [];
  for (const s of p.shifts) {
    const emp = byId.get(s.staff_id);
    if (!emp) { dropped.push({ shift: s, reason: "unknown_employee" }); continue; }
    if (!emp.roles.some((r) => r.id === s.role_id)) { dropped.push({ shift: s, reason: "role_not_held" }); continue; }
    if (!weekDays.has(s.start_at.slice(0, 10)) || s.start_at >= s.end_at) { dropped.push({ shift: s, reason: "outside_week_or_invalid" }); continue; }
    if (Date.parse(`${s.end_at}:00Z`) - Date.parse(`${s.start_at}:00Z`) > 16 * 3_600_000) { dropped.push({ shift: s, reason: "too_long" }); continue; }
    kept.push(s);
  }
  const hoursOf = (s: ProposedShift) => (Date.parse(`${s.end_at}:00Z`) - Date.parse(`${s.start_at}:00Z`)) / 3_600_000;
  const total = new Map<number, number>();
  for (const s of kept) {
    const emp = byId.get(s.staff_id)!, date = s.start_at.slice(0, 10);
    total.set(s.staff_id, (total.get(s.staff_id) ?? 0) + hoursOf(s));
    if (emp.time_off.some((o) => overlapsTimeOff(o, s.start_at, s.end_at))) warnings.push({ staff_id: s.staff_id, date, kind: "time_off", text: `${emp.first_name}: time off ${date}` });
    if (findUnavailable(emp.unavailable, s.start_at, s.end_at)) warnings.push({ staff_id: s.staff_id, date, kind: "unavailable", text: `${emp.first_name}: unavailable ${date}` });
    if (emp.fixed_days_off.includes((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7)) warnings.push({ staff_id: s.staff_id, date, kind: "day_off", text: `${emp.first_name}: fixed day off ${date}` });
    for (const o of ctx.already_planned_elsewhere) if (o.staff_id === s.staff_id && o.start_at < s.end_at && s.start_at < o.end_at) warnings.push({ staff_id: s.staff_id, date, kind: "elsewhere", text: `${emp.first_name}: already working elsewhere ${date}` });
    for (const o of kept) if (o !== s && o.staff_id === s.staff_id && o.start_at < s.end_at && s.start_at < o.end_at && o.start_at >= s.start_at) warnings.push({ staff_id: s.staff_id, date, kind: "overlap", text: `${emp.first_name}: overlapping shifts ${date}` });
  }
  for (const emp of ctx.employees) {
    const h = total.get(emp.id) ?? 0;
    const cap = Math.min(emp.max_weekly_hours ?? 999, ctx.overtime_hours);
    if (h > cap + 1e-9) warnings.push({ staff_id: emp.id, kind: "hours_over", text: `${emp.first_name}: ${round(h)} h > ${cap} h` });
    if (emp.promised_hours != null && h < emp.promised_hours - 0.5) warnings.push({ staff_id: emp.id, kind: "hours_under", text: `${emp.first_name}: ${round(h)} h of ${emp.promised_hours} h promised` });
  }
  // coverage against the targets, per department and period (lowest headcount in the period)
  const roleDept = new Map<number, string>();
  for (const emp of ctx.employees) for (const r of emp.roles) roleDept.set(r.id, r.department);
  ctx.week.days.forEach((date, i) => {
    const open = toMin(ctx.restaurant.open_by_dow[i]), close = toMin(ctx.restaurant.close_by_dow[i]);
    for (const dep of ctx.departments) {
      const tg = ctx.targets[date]?.[dep]; if (!tg) continue;
      const wins = periodWindows(ctx.period_boundaries, open, close).filter((w: any) => tg[w.key] !== undefined);
      const present = kept.filter((s) => roleDept.get(s.role_id) === dep).map((s) => ({ start_at: s.start_at, end_at: s.end_at }));
      for (const w of wins) {
        const buckets = coverage(present, date, w.from, w.to);
        const low = Math.min(...buckets.map((b: any) => b.count));
        if (low < tg[w.key]) warnings.push({ date, kind: "short", text: `${date} ${dep} ${fromMinStr(w.from)}–${fromMinStr(w.to)}: ${low}/${tg[w.key]}` });
      }
    }
  });
  return { shifts: kept, warnings, dropped };
}
const round = (n: number) => Math.round(n * 10) / 10;
const fromMinStr = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Sends the prompt to Claude. Returns the text of the answer. */
export async function callClaude(apiKey: string, system: string, user: string, fetcher: typeof fetch = fetch, apiBase = "https://api.anthropic.com"): Promise<string> {
  const res = await fetcher(`${apiBase}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 16000, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`ai_http_${res.status}`);
  const body = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = body.content?.filter((c) => c.type === "text").map((c) => c.text).join("") ?? "";
  if (!text) throw new Error("ai_empty");
  return text;
}
