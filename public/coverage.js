// Pure helpers for the staffing timeline. No DOM access, so they are unit-tested in Node.

export const SLOTS = ["06:30", "08:00", "09:00", "11:00", "14:00", "17:00", "close"];
// The 'close' target applies to the last hour before closing.
export const CLOSE_WINDOW_MIN = 60;

export const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const fromMin = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const dayNumber = (ymd) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 86400000;

/** [start, end) of a shift in minutes from midnight of `day` ('YYYY-MM-DD'). Shifts on other days land outside 0..1440. */
export function shiftSpan(shift, day) {
  const startDate = shift.start_at.slice(0, 10);
  const offset = (dayNumber(startDate) - dayNumber(day)) * 1440;
  const lengthDays = dayNumber(shift.end_at.slice(0, 10)) - dayNumber(startDate);
  return { s: toMin(shift.start_at.slice(11, 16)) + offset, e: toMin(shift.end_at.slice(11, 16)) + lengthDays * 1440 + offset };
}

/** Merge default (dow -1) and per-day override rows into {slot: count}. Override wins slot by slot. */
export function resolveTargets(rows, dow) {
  const out = {};
  for (const r of rows) if (r.dow === -1) out[r.slot] = r.count;
  for (const r of rows) if (r.dow === dow) out[r.slot] = r.count;
  return out;
}

/** Windows [from, to) each carrying a target, from the resolved slot values. */
export function targetWindows(targets, closeMin) {
  const times = SLOTS.slice(0, -1).map(toMin);
  const closeFrom = Math.max(closeMin - CLOSE_WINDOW_MIN, times[times.length - 1]);
  const wins = [];
  for (let i = 0; i < times.length; i++) {
    const to = i + 1 < times.length ? times[i + 1] : closeFrom;
    if (targets[SLOTS[i]] !== undefined && to > times[i]) wins.push({ from: times[i], to, count: targets[SLOTS[i]] });
  }
  if (targets.close !== undefined && closeMin > closeFrom) wins.push({ from: closeFrom, to: closeMin, count: targets.close });
  return wins;
}

export const targetAt = (wins, t) => wins.find((w) => t >= w.from && t < w.to)?.count;

/** Headcount per 30-minute bucket from `from` to `to` (minutes). */
export function coverage(shifts, day, from, to, step = 30) {
  const spans = shifts.map((s) => shiftSpan(s, day));
  const out = [];
  for (let t = from; t < to; t += step) out.push({ t, count: spans.filter((x) => x.s <= t && x.e > t).length });
  return out;
}

/** Contiguous runs where headcount differs from the target in one direction: [{from, to, missing}]. */
function runs(buckets, wins, step, gapOf) {
  const out = [];
  for (const b of buckets) {
    const target = targetAt(wins, b.t);
    const gap = target === undefined ? 0 : gapOf(target, b.count);
    if (gap > 0) {
      const last = out[out.length - 1];
      if (last && last.to === b.t) { last.to = b.t + step; last.missing = Math.max(last.missing, gap); }
      else out.push({ from: b.t, to: b.t + step, missing: gap });
    }
  }
  return out;
}

/** Runs where headcount < target (missing = worst shortfall in the run). */
export const shortages = (buckets, wins, step = 30) => runs(buckets, wins, step, (target, count) => target - count);

/** Runs where headcount > target (missing = worst excess in the run). */
export const surpluses = (buckets, wins, step = 30) => runs(buckets, wins, step, (target, count) => count - target);
