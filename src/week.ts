// Weeks run Monday–Sunday. A week is identified by its Monday, 'YYYY-MM-DD'.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parse(date: string): Date | null {
  if (!DATE_RE.test(date)) return null;
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date ? null : d;
}

export function isMonday(date: string): boolean {
  return parse(date)?.getUTCDay() === 1;
}

/** Returns [start, end) bounds as 'YYYY-MM-DDT00:00' strings, or null if not a Monday. */
export function weekBounds(monday: string): { start: string; end: string } | null {
  const d = parse(monday);
  if (!d || d.getUTCDay() !== 1) return null;
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + 7);
  return { start: `${monday}T00:00`, end: `${next.toISOString().slice(0, 10)}T00:00` };
}
