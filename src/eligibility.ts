// Who can be asked to replace a sick employee? Pure rules; the caller gathers the data.
export interface Candidate {
  staff_id: number;
  name: string;
  has_phone: boolean;
  has_email: boolean;
  week_hours: number;                              // hours already scheduled that week (all restaurants)
  shifts: { start_at: string; end_at: string }[];  // their other working shifts (status ok) around the day
  max_hours?: number | null;                       // personal weekly maximum (e.g. under 16): never exceeded, even if overtime is allowed
  blocked?: "time_off" | "unavailable";            // time off or weekly unavailability covering the shift
}

export interface Shift { start_at: string; end_at: string }

const overlaps = (a: Shift, b: Shift) => a.start_at < b.end_at && b.start_at < a.end_at;
const hoursOf = (s: Shift) => (Date.parse(`${s.end_at}:00Z`) - Date.parse(`${s.start_at}:00Z`)) / 3_600_000;

export interface Result { eligible: Candidate[]; excluded: { staff_id: number; name: string; reason: "busy" | "overtime" | "no_contact" | "time_off" | "unavailable" | "max_hours" }[] }

export function chooseCandidates(shift: Shift, sickStaffId: number, people: Candidate[], opts: { overtime_hours: number; allow_overtime: boolean }): Result {
  const need = hoursOf(shift);
  const out: Result = { eligible: [], excluded: [] };
  for (const p of people) {
    if (p.staff_id === sickStaffId) continue;
    if (p.shifts.some((s) => overlaps(s, shift))) out.excluded.push({ staff_id: p.staff_id, name: p.name, reason: "busy" });
    else if (p.blocked) out.excluded.push({ staff_id: p.staff_id, name: p.name, reason: p.blocked });
    else if (p.max_hours != null && p.week_hours + need > p.max_hours + 1e-9) out.excluded.push({ staff_id: p.staff_id, name: p.name, reason: "max_hours" });
    else if (!opts.allow_overtime && p.week_hours + need > opts.overtime_hours + 1e-9) out.excluded.push({ staff_id: p.staff_id, name: p.name, reason: "overtime" });
    else if (!p.has_phone && !p.has_email) out.excluded.push({ staff_id: p.staff_id, name: p.name, reason: "no_contact" });
    else out.eligible.push(p);
  }
  return out;
}

/** Fewest hours first, so replacements are spread fairly and nobody is pushed towards overtime needlessly. */
export const byFewestHours = (a: Candidate, b: Candidate) => a.week_hours - b.week_hours || a.name.localeCompare(b.name);
