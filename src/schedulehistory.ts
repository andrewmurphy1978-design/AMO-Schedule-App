// A published schedule is kept as it was published; changes made afterwards (during the week) are found by comparing it with the shifts as they are now.

export interface SnapShift { staff_id: number; role_id: number; extra_role_ids?: number[]; start_at: string; end_at: string; notes?: string | null }
export interface NowShift extends SnapShift { id: number }

export interface Diff {
  changed: { before: SnapShift; after: NowShift }[];     // the same person, the same day, other hours or role
  replaced: { from: SnapShift; to: NowShift }[];         // somebody else now works that slot (same role, same day, overlapping hours)
  added: NowShift[];
  removed: SnapShift[];
}

const day = (s: SnapShift) => s.start_at.slice(0, 10);
const overlaps = (a: SnapShift, b: SnapShift) => a.start_at < b.end_at && b.start_at < a.end_at;
const same = (a: SnapShift, b: SnapShift) => a.staff_id === b.staff_id && a.role_id === b.role_id && a.start_at === b.start_at && a.end_at === b.end_at;

/** What changed between the schedule as published (`base`) and the shifts now (`now`). */
export function diffShifts(base: SnapShift[], now: NowShift[]): Diff {
  let removed = [...base], added = [...now];
  // the shifts that did not change
  for (const b of [...removed]) {
    const i = added.findIndex((n) => same(b, n));
    if (i >= 0) { removed = removed.filter((x) => x !== b); added.splice(i, 1); }
  }
  // the same person on the same day: the hours or the role changed
  const changed: Diff["changed"] = [];
  for (const b of [...removed]) {
    const i = added.findIndex((n) => n.staff_id === b.staff_id && day(n) === day(b));
    if (i >= 0) { changed.push({ before: b, after: added[i] }); removed = removed.filter((x) => x !== b); added.splice(i, 1); }
  }
  // somebody else takes the slot: a replacement
  const replaced: Diff["replaced"] = [];
  for (const b of [...removed]) {
    const i = added.findIndex((n) => n.role_id === b.role_id && day(n) === day(b) && overlaps(n, b));
    if (i >= 0) { replaced.push({ from: b, to: added[i] }); removed = removed.filter((x) => x !== b); added.splice(i, 1); }
  }
  return { changed, replaced, added, removed };
}

export const hasChanges = (d: Diff) => d.changed.length + d.replaced.length + d.added.length + d.removed.length > 0;

export interface MidWeekChange { kind: "changed" | "replacement" | "added" | "removed"; date: string; staff_id: number; was?: { start: string; end: string; role_id: number }; now?: { start: string; end: string; role_id: number }; replaces_staff_id?: number }

/** The changes in the form given to the AI. */
export function changesForAi(d: Diff): MidWeekChange[] {
  const t = (s: SnapShift) => ({ start: s.start_at.slice(11, 16), end: s.end_at.slice(11, 16), role_id: s.role_id });
  return [
    ...d.replaced.map((r) => ({ kind: "replacement" as const, date: day(r.to), staff_id: r.to.staff_id, replaces_staff_id: r.from.staff_id, was: t(r.from), now: t(r.to) })),
    ...d.changed.map((c) => ({ kind: "changed" as const, date: day(c.after), staff_id: c.after.staff_id, was: t(c.before), now: t(c.after) })),
    ...d.added.map((a) => ({ kind: "added" as const, date: day(a), staff_id: a.staff_id, now: t(a) })),
    ...d.removed.map((r) => ({ kind: "removed" as const, date: day(r), staff_id: r.staff_id, was: t(r) })),
  ].sort((a, b) => a.date.localeCompare(b.date));
}
