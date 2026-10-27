// Calendar rules for staffing targets: seasons and special days. Pure functions, shared by browser and tests.
import { resolveTargets } from "./coverage.js";

const MS_DAY = 86400000;
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const iso = (dt) => dt.toISOString().slice(0, 10);
const addDays = (dt, n) => new Date(dt.getTime() + n * MS_DAY);
const parse = (ymd) => utc(+ymd.slice(0, 4), +ymd.slice(5, 7), +ymd.slice(8, 10));
/** 0 = Monday ... 6 = Sunday */
export const weekdayOf = (dt) => (dt.getUTCDay() + 6) % 7;

/** Easter Sunday (anonymous Gregorian algorithm). */
export function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

/** The n-th given weekday (0 = Monday) of a month; n = -1 means the last one. */
export function nthWeekday(year, month, weekday, n) {
  if (n > 0) {
    const first = utc(year, month, 1);
    return addDays(first, (weekday - weekdayOf(first) + 7) % 7 + (n - 1) * 7);
  }
  const last = utc(year, month + 1, 0);
  return addDays(last, -((weekdayOf(last) - weekday + 7) % 7));
}

const mdParts = (md) => [Number(md.slice(0, 2)), Number(md.slice(3, 5))];

/** True when `day` ('YYYY-MM-DD') is covered by the rule. */
export function ruleMatches(rule, day) {
  const dt = parse(day), year = dt.getUTCFullYear();
  switch (rule.type) {
    case "range": {
      const md = day.slice(5);
      return rule.from <= rule.to ? md >= rule.from && md <= rule.to : md >= rule.from || md <= rule.to;
    }
    case "date": return day === rule.date;
    case "fixed": {
      const [m, d] = mdParts(rule.md);
      return [year - 1, year].some((y) => { const off = (dt - utc(y, m, d)) / MS_DAY; return off >= 0 && off < (rule.days ?? 1); });
    }
    case "nth":
      return [year - 1, year].some((y) => { const off = (dt - nthWeekday(y, rule.month, rule.weekday, rule.n)) / MS_DAY; return off >= 0 && off < (rule.days ?? 1); });
    case "easter":
      return [year - 1, year].some((y) => { const off = (dt - easterSunday(y)) / MS_DAY; return off >= rule.from && off <= rule.to; });
    default: return false;
  }
}

/**
 * Layers, least to most specific: base, matching seasons (oldest first), matching special days (oldest first).
 * Each layer overrides slot by slot, and inside a layer a weekday overrides its own default.
 * Returns { targets: {slot: count}, labels: [names of the active seasons/special days] }.
 */
export function resolveForDate(rows, sets, day) {
  const dow = weekdayOf(parse(day));
  const layers = [{ id: 0, name: null }];
  const matching = (kind) => sets.filter((s) => s.kind === kind && ruleMatches(s.rule, day)).sort((a, b) => a.id - b.id);
  layers.push(...matching("season"), ...matching("special"));
  const targets = {};
  for (const layer of layers) Object.assign(targets, resolveTargets(rows.filter((r) => r.set_id === layer.id), dow));
  return { targets, labels: layers.filter((l) => l.name).map((l) => l.name) };
}

// ---------- presets offered in Administration (Québec) ----------
const fixed = (md, days = 1) => ({ type: "fixed", md, days });
export const SPECIAL_PRESETS = [
  { id: "valentine", fr: "Saint-Valentin", en: "Valentine’s Day", rule: fixed("02-14") },
  { id: "easter", fr: "Fin de semaine de Pâques", en: "Easter weekend", rule: { type: "easter", from: -2, to: 1 } },
  { id: "mothers", fr: "Fête des Mères", en: "Mother’s Day", rule: { type: "nth", month: 5, weekday: 6, n: 2, days: 1 } },
  { id: "fathers", fr: "Fête des Pères", en: "Father’s Day", rule: { type: "nth", month: 6, weekday: 6, n: 3, days: 1 } },
  { id: "stjean", fr: "Fête nationale du Québec", en: "Saint-Jean-Baptiste Day", rule: fixed("06-24") },
  { id: "canada", fr: "Fête du Canada", en: "Canada Day", rule: fixed("07-01") },
  { id: "labour", fr: "Fête du Travail", en: "Labour Day", rule: { type: "nth", month: 9, weekday: 0, n: 1, days: 1 } },
  { id: "thanks", fr: "Action de grâce", en: "Thanksgiving", rule: { type: "nth", month: 10, weekday: 0, n: 2, days: 1 } },
  { id: "halloween", fr: "Halloween", en: "Halloween", rule: fixed("10-31") },
  { id: "xmaseve", fr: "Veille de Noël", en: "Christmas Eve", rule: fixed("12-24") },
  { id: "xmas", fr: "Noël", en: "Christmas Day", rule: fixed("12-25") },
  { id: "boxing", fr: "Lendemain de Noël", en: "Boxing Day", rule: fixed("12-26") },
  { id: "nye", fr: "Veille du jour de l’An", en: "New Year’s Eve", rule: fixed("12-31") },
  { id: "nyd", fr: "Jour de l’An", en: "New Year’s Day", rule: fixed("01-01") },
];
export const SEASON_PRESETS = [
  { id: "summer", fr: "Été", en: "Summer", rule: { type: "range", from: "06-21", to: "09-22" } },
  { id: "fall", fr: "Automne", en: "Fall", rule: { type: "range", from: "09-23", to: "12-19" } },
  { id: "holidays", fr: "Temps des Fêtes", en: "Holiday season", rule: { type: "range", from: "12-20", to: "01-05" } },
  { id: "winter", fr: "Hiver", en: "Winter", rule: { type: "range", from: "01-06", to: "03-19" } },
  { id: "spring", fr: "Printemps", en: "Spring", rule: { type: "range", from: "03-20", to: "06-20" } },
];

// ---------- holidays shown as flags (Québec) ----------
// statutory = jour férié (chômé et payé) under the Québec Act respecting labour standards; the rest are busy days worth flagging.
// Easter Monday and Good Friday are both flagged because an employer chooses which one it observes.
const HOLIDAYS = [
  { id: "nyd", fr: "Jour de l’An", en: "New Year’s Day", statutory: true, on: (y) => utc(y, 1, 1) },
  { id: "valentine", fr: "Saint-Valentin", en: "Valentine’s Day", on: (y) => utc(y, 2, 14) },
  { id: "stpat", fr: "Saint-Patrick", en: "St. Patrick’s Day", on: (y) => utc(y, 3, 17) },
  { id: "goodfriday", fr: "Vendredi saint", en: "Good Friday", statutory: true, on: (y) => addDays(easterSunday(y), -2) },
  { id: "easter", fr: "Pâques", en: "Easter Sunday", on: (y) => easterSunday(y) },
  { id: "eastermon", fr: "Lundi de Pâques", en: "Easter Monday", statutory: true, on: (y) => addDays(easterSunday(y), 1) },
  { id: "mothers", fr: "Fête des Mères", en: "Mother’s Day", on: (y) => nthWeekday(y, 5, 6, 2) },
  { id: "patriotes", fr: "Journée nationale des patriotes", en: "National Patriots’ Day", statutory: true, on: (y) => { const d = utc(y, 5, 24); return addDays(d, -weekdayOf(d)); } },
  { id: "fathers", fr: "Fête des Pères", en: "Father’s Day", on: (y) => nthWeekday(y, 6, 6, 3) },
  { id: "stjean", fr: "Fête nationale du Québec", en: "Saint-Jean-Baptiste Day", statutory: true, on: (y) => utc(y, 6, 24) },
  { id: "canada", fr: "Fête du Canada", en: "Canada Day", statutory: true, on: (y) => utc(y, 7, 1) },
  { id: "labour", fr: "Fête du Travail", en: "Labour Day", statutory: true, on: (y) => nthWeekday(y, 9, 0, 1) },
  { id: "thanks", fr: "Action de grâce", en: "Thanksgiving", statutory: true, on: (y) => nthWeekday(y, 10, 0, 2) },
  { id: "halloween", fr: "Halloween", en: "Halloween", on: (y) => utc(y, 10, 31) },
  { id: "xmaseve", fr: "Veille de Noël", en: "Christmas Eve", on: (y) => utc(y, 12, 24) },
  { id: "xmas", fr: "Noël", en: "Christmas Day", statutory: true, on: (y) => utc(y, 12, 25) },
  { id: "boxing", fr: "Lendemain de Noël", en: "Boxing Day", on: (y) => utc(y, 12, 26) },
  { id: "nye", fr: "Veille du jour de l’An", en: "New Year’s Eve", on: (y) => utc(y, 12, 31) },
];

/** Holidays falling on `day` ('YYYY-MM-DD'): [{id, fr, en, statutory}]. */
export function holidaysOn(day) {
  const y = Number(day.slice(0, 4));
  return HOLIDAYS.filter((hd) => iso(hd.on(y)) === day).map(({ id, fr, en, statutory }) => ({ id, fr, en, statutory: !!statutory }));
}
