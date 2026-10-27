// Labour cost from shifts and hourly rates. Pure functions (no I/O) so they can be unit-tested.
// Times are naive local restaurant times ('YYYY-MM-DDTHH:MM'); daylight-saving shifts are ignored.

export interface PayShift {
  start_at: string;
  end_at: string;
  rate_cents: number | null; // null = no hourly rate set for this employee
}

export interface DayCost {
  date: string;
  cents: number;
  hours: number;
  by_hour: number[]; // 24 values, cents spent in each clock hour (whole cents)
}

export interface CostResult {
  days: DayCost[];
  total_cents: number;
  total_hours: number;
  unrated_hours: number; // worked hours that could not be priced
}

const HOUR_MS = 3_600_000;
const toMs = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), +iso.slice(11, 13), +iso.slice(14, 16));
const dayMs = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));

/** Cost of `shifts` on each of `days`. A shift that crosses midnight is split between the two days. */
export function computeCosts(shifts: PayShift[], days: string[]): CostResult {
  const spans = shifts.map((s) => ({ a: toMs(s.start_at), b: toMs(s.end_at), rate: s.rate_cents }));
  let unrated = 0;
  const out: DayCost[] = days.map((date) => {
    const start = dayMs(date);
    const byHour = new Array<number>(24).fill(0);
    let hours = 0;
    for (let h = 0; h < 24; h++) {
      const from = start + h * HOUR_MS, to = from + HOUR_MS;
      for (const s of spans) {
        const overlap = Math.min(s.b, to) - Math.max(s.a, from);
        if (overlap <= 0) continue;
        const worked = overlap / HOUR_MS;
        hours += worked;
        if (s.rate === null) unrated += worked;
        else byHour[h] += worked * s.rate;
      }
    }
    return { date, cents: Math.round(byHour.reduce((x, y) => x + y, 0)), hours: round2(hours), by_hour: byHour.map(Math.round) };
  });
  return {
    days: out,
    total_cents: out.reduce((n, d) => n + d.cents, 0),
    total_hours: round2(out.reduce((n, d) => n + d.hours, 0)),
    unrated_hours: round2(unrated),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "16.5" / "16,50" / "$16.50" -> 1650 cents, or null when empty/invalid. */
export function parseRate(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === "") return null;
  const cleaned = typeof input === "number" ? String(input) : String(input).replace(/[^\d.,-]/g, "").replace(",", ".");
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0 || n > 1000) return null;
  return Math.round(n * 100);
}
