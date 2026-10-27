// Time off (whole or part of a day) and weekly unavailability, checked against a shift. Pure, unit-tested.
// Times are naive local 'YYYY-MM-DDTHH:MM'.

export interface TimeOff { start_date: string; end_date: string; start_time?: string | null; end_time?: string | null }
export interface Unavailable { dow: number; start_time: string; end_time: string; valid_from?: string | null; valid_to?: string | null; note?: string | null }

const DAY = 86_400_000;
const ms = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), +(iso.slice(11, 13) || 0), +(iso.slice(14, 16) || 0));
const minutes = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);
const dayStart = (ymd: string) => ms(`${ymd}T00:00`);
const ymdOf = (t: number) => new Date(t).toISOString().slice(0, 10);
/** 0 = Monday ... 6 = Sunday */
export const dowOf = (ymd: string) => (new Date(dayStart(ymd)).getUTCDay() + 6) % 7;

/** Days (YYYY-MM-DD) touched by [startAt, endAt). */
function daysOf(startAt: string, endAt: string): string[] {
  const out: string[] = [];
  const last = ms(endAt) > dayStart(endAt.slice(0, 10)) ? dayStart(endAt.slice(0, 10)) : dayStart(endAt.slice(0, 10)) - DAY;
  for (let t = dayStart(startAt.slice(0, 10)); t <= last && out.length < 8; t += DAY) out.push(ymdOf(t));
  return out;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

/** Does the shift overlap the time off? Whole-day requests block every shift touching those days. */
export function overlapsTimeOff(off: TimeOff, startAt: string, endAt: string): boolean {
  const s = ms(startAt), e = ms(endAt);
  for (const day of daysOf(startAt, endAt)) {
    if (day < off.start_date || day > off.end_date) continue;
    if (!off.start_time || !off.end_time) return true;
    const base = dayStart(day);
    if (overlap(s, e, base + minutes(off.start_time) * 60_000, base + minutes(off.end_time) * 60_000)) return true;
  }
  return false;
}

/** First unavailability rule that the shift runs into, or null. */
export function findUnavailable(rules: Unavailable[], startAt: string, endAt: string): Unavailable | null {
  const s = ms(startAt), e = ms(endAt);
  for (const day of daysOf(startAt, endAt)) {
    const dow = dowOf(day);
    const base = dayStart(day);
    for (const r of rules) {
      if (r.dow !== dow) continue;
      if (r.valid_from && day < r.valid_from) continue;
      if (r.valid_to && day > r.valid_to) continue;
      if (overlap(s, e, base + minutes(r.start_time) * 60_000, base + minutes(r.end_time) * 60_000)) return r;
    }
  }
  return null;
}

/** Label such as "C/D 14:00–21:00" part of a chip. */
export const timeRange = (o: { start_time?: string | null; end_time?: string | null }) => (o.start_time && o.end_time ? `${o.start_time}–${o.end_time}` : "");
