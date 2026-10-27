export interface Interval {
  start_at: string;
  end_at: string;
}

/** Half-open overlap: a shift ending at 17:00 does not clash with one starting at 17:00. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start_at < b.end_at && b.start_at < a.end_at;
}

export function findOverlaps<T extends Interval>(candidate: Interval, existing: T[]): T[] {
  return existing.filter((s) => overlaps(candidate, s));
}

export const SHIFT_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
