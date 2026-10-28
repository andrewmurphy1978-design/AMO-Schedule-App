// Pure helpers for the staffing timeline. No DOM access, so they are unit-tested in Node.

// Staffing-target periods. A restaurant has a list of boundaries (default below): the first period runs from opening to the first
// boundary, each boundary starts the next period, and the last period runs to closing. A period is identified by its key:
// "open" for the first one, otherwise its start time ("08:00", "12:00"...). Open-8:00, 8:00-9:00, 9:00-11:00, 11:00-12:00,
// 12:00-14:00, 14:00-17:00, 17:00-20:00, 20:00-Close with the default boundaries.
export const DEFAULT_BOUNDARIES = ["08:00", "09:00", "11:00", "12:00", "14:00", "17:00", "20:00"];

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

/** Period keys of a boundary list: "open" then each boundary. */
export const periodKeys = (boundaries = DEFAULT_BOUNDARIES) => ["open", ...boundaries];

/** Periods of a day as [{ key, from, to }] in minutes, clipped to opening hours (periods that fall outside are dropped). */
export function periodWindows(boundaries, openMin, closeMin) {
  const keys = periodKeys(boundaries);
  const out = [];
  keys.forEach((key, i) => {
    const from = Math.max(openMin, key === "open" ? openMin : toMin(key));
    const to = Math.min(closeMin, i + 1 < keys.length ? toMin(keys[i + 1]) : closeMin);
    if (to > from) out.push({ key, from, to });
  });
  return out;
}

/** Windows [from, to) each carrying a target, from the resolved period values. */
export function targetWindows(targets, openMin, closeMin, boundaries = DEFAULT_BOUNDARIES) {
  return periodWindows(boundaries, openMin, closeMin).filter((w) => targets[w.key] !== undefined).map((w) => ({ from: w.from, to: w.to, count: targets[w.key] }));
}

/**
 * Re-key a {period: count} map when a restaurant changes its boundaries: each new period takes the value of the old period
 * that covered its start time. Periods the old map did not cover stay empty.
 */
export function remapPeriods(oldBoundaries, newBoundaries, values) {
  const oldKeys = periodKeys(oldBoundaries);
  const out = {};
  for (const key of periodKeys(newBoundaries)) {
    let source = "open";
    if (key !== "open") for (const k of oldKeys) if (k !== "open" && toMin(k) <= toMin(key)) source = k;
    if (values[source] !== undefined) out[key] = values[source];
  }
  return out;
}

/** Valid boundary list: 1 to 10 times "HH:MM", strictly increasing. */
export const validBoundaries = (b) => Array.isArray(b) && b.length >= 1 && b.length <= 10 && b.every((x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x)) && b.every((x, i) => i === 0 || b[i - 1] < x);

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

/**
 * Kitchen posts nobody competent is covering.
 * people: [{ skills: Set of post ids, a, b }] (kitchen staff present, minutes from midnight); posts: [{ id, code, all_posts }];
 * checked every `step` minutes from `from` to `to`, only where at least one person is present (an empty kitchen is a shortage,
 * reported elsewhere). A runner (all_posts) is competent at every post.
 *  - With 4 or more people present, each of the 4 principal posts (subs, starters/fryer, pasta, pizza) needs its own competent
 *    person (one person per post). The out-of-the-oven post is done by whoever is on pizza, subs or pasta, or by delivery staff,
 *    so it needs no one extra.
 *  - With fewer people, one person covers several posts: each post just needs someone competent present (the oven counts as
 *    covered when someone present can work the oven, pizza, subs or pasta).
 * `ovenHelpers` ([{ a, b }]): delivery staff present: they can also take the oven post.
 * Returns { postId: [{ from, to }] } of the uncovered stretches.
 */
export const PRINCIPAL_POSTS = ["pizza", "pasta", "subs", "starters"]; // order used when reporting which post is the one left out
export function postGaps(people, posts, from, to, step = 30, ovenHelpers = []) {
  const runnerIds = new Set(posts.filter((p) => p.all_posts).map((p) => p.id));
  const real = posts.filter((p) => !p.all_posts);
  const byCode = Object.fromEntries(real.map((p) => [p.code, p]));
  const principals = PRINCIPAL_POSTS.map((c) => byCode[c]).filter(Boolean);
  const can = (x, post) => x.skills.has(post.id) || [...runnerIds].some((r) => x.skills.has(r));
  const gaps = Object.fromEntries(real.map((p) => [p.id, []]));
  const add = (post, t) => { const list = gaps[post.id], last = list[list.length - 1]; if (last && last.to === t) last.to = t + step; else list.push({ from: t, to: t + step }); };
  for (let t = from; t < to; t += step) {
    const here = people.filter((x) => x.a <= t && x.b > t);
    if (!here.length) continue;
    const missing = new Set();
    if (here.length >= principals.length && principals.length === 4) {
      // one person per principal post: bipartite matching by augmenting paths, posts tried in a fixed order
      const owner = new Map(); // person index -> post id
      const holder = new Map(); // post id -> person index
      const place = (pi, seen) => {
        for (let i = 0; i < here.length; i++) {
          if (seen.has(i) || !can(here[i], principals[pi])) continue;
          seen.add(i);
          const cur = owner.get(i);
          if (cur === undefined || place(principals.findIndex((q) => q.id === cur), seen)) { owner.set(i, principals[pi].id); holder.set(principals[pi].id, i); return true; }
        }
        return false;
      };
      principals.forEach((p, pi) => { if (!place(pi, new Set())) missing.add(p.id); });
    } else {
      for (const p of principals) if (!here.some((x) => can(x, p))) missing.add(p.id);
    }
    const oven = byCode.oven;
    if (oven && !ovenHelpers.some((x) => x.a <= t && x.b > t) && !here.some((x) => can(x, oven) || principals.some((p) => ["pizza", "subs", "pasta"].includes(p.code) && can(x, p)))) missing.add(oven.id);
    for (const p of real) if (missing.has(p.id)) add(p, t);
  }
  return gaps;
}
