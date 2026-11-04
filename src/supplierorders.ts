// How a supplier takes orders: the ways to order (phone, e-mail, portal, web site, API) and its order calendar
// (which days, the cut-off time, when it delivers). Days are ISO: 1 = Monday ... 7 = Sunday.

export const METHODS = ["call", "email", "portal", "website", "api"] as const;
export type Method = (typeof METHODS)[number];

export interface OrderSettings {
  order_days: number[];            // the days an order can be placed
  cutoff: string | null;           // "HH:MM": the latest time to order on those days
  delivery_mode: "offset" | "days";
  delivery_offset: number;         // "offset": days after the order (1 = the next day)
  delivery_days: number[];         // "days": the weekdays it delivers (the first one after the order day)
  note: string | null;
}

export function cleanMethods(raw: unknown): Method[] {
  if (!Array.isArray(raw)) return [];
  return METHODS.filter((m) => raw.includes(m));
}

const days = (v: unknown): number[] => (Array.isArray(v) ? [...new Set(v.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b) : []);

export function cleanSettings(raw: unknown): OrderSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const cutoff = typeof r.cutoff === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.cutoff) ? r.cutoff : null;
  const off = Number(r.delivery_offset);
  const s: OrderSettings = {
    order_days: days(r.order_days), cutoff, delivery_mode: r.delivery_mode === "days" ? "days" : "offset",
    delivery_offset: Number.isInteger(off) && off >= 0 && off <= 14 ? off : 1, delivery_days: days(r.delivery_days),
    note: typeof r.note === "string" && r.note.trim() ? r.note.trim().slice(0, 200) : null,
  };
  return s.order_days.length || s.cutoff || s.delivery_days.length || s.note ? s : null;
}

export function parseSettings(json: string | null | undefined): OrderSettings | null {
  if (!json) return null;
  try { return cleanSettings(JSON.parse(json)); } catch { return null; }
}

export const addDays = (ymd: string, n: number): string => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const isoDow = (ymd: string): number => { const d = new Date(`${ymd}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };

/** The day an order placed on `orderDate` arrives, or null when the supplier's delivery is not set. */
export function deliveryFor(s: OrderSettings | null, orderDate: string): string | null {
  if (!s) return null;
  if (s.delivery_mode === "days") {
    if (!s.delivery_days.length) return null;
    for (let i = 1; i <= 14; i++) { const d = addDays(orderDate, i); if (s.delivery_days.includes(isoDow(d))) return d; }
    return null;
  }
  return addDays(orderDate, s.delivery_offset);
}

export interface OrderWindow {
  order_date: string;              // the next day to order
  deadline: string | null;         // "HH:MM" that day
  delivery_date: string | null;
  today: boolean;                  // the window is today (still open)
  missed_today: boolean;           // today is an order day but the cut-off has passed
}

/** The next time an order can be placed. `now` is the local "YYYY-MM-DDTHH:MM". */
export function nextWindow(s: OrderSettings | null, now: string): OrderWindow | null {
  if (!s || !s.order_days.length) return null;
  const today = now.slice(0, 10), time = now.slice(11, 16);
  let missed = false;
  for (let i = 0; i <= 7; i++) {
    const d = addDays(today, i);
    if (!s.order_days.includes(isoDow(d))) continue;
    if (i === 0 && s.cutoff && time > s.cutoff) { missed = true; continue; }
    return { order_date: d, deadline: s.cutoff, delivery_date: deliveryFor(s, d), today: i === 0, missed_today: missed };
  }
  return null;
}
