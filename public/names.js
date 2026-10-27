// First/last name helpers shared by the browser and the server.

/** "Marie-Ève  Tremblay" -> { first: "Marie-Ève", last: "Tremblay" } (first word = first name). */
export function splitName(full) {
  const t = String(full ?? "").trim().replace(/\s+/g, " ");
  const i = t.indexOf(" ");
  return i < 0 ? { first: t, last: "" } : { first: t.slice(0, i), last: t.slice(i + 1) };
}

export const joinName = (first, last) => [first, last].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");

const key = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const initial = (last) => [...String(last ?? "").replace(/^[^\p{L}]+/u, "")][0]?.toUpperCase() ?? "";

/**
 * Short names for the coverage view: the first name only, plus the first letter of the last name ("Marie T.")
 * when several of the given people share that first name. people: [{ id, first_name, last_name, name }].
 * Returns Map(id -> short name).
 */
export function shortNames(people) {
  const fallback = (p) => (p.first_name ? p : { ...p, ...{ first_name: splitName(p.name).first, last_name: splitName(p.name).last } });
  const list = people.map(fallback);
  const counts = new Map();
  for (const p of list) counts.set(key(p.first_name), (counts.get(key(p.first_name)) ?? 0) + 1);
  return new Map(list.map((p) => [p.id, counts.get(key(p.first_name)) > 1 && initial(p.last_name) ? `${p.first_name} ${initial(p.last_name)}.` : p.first_name || p.name]));
}

/**
 * Role names are written "Masculine / feminine" ("Cuisinier / cuisinière", "Waiter / waitress"). For an employee whose sex is
 * 'M' or 'F' only the matching form is returned, capitalised ("Cuisinière"); otherwise the full pair is kept.
 */
export function genderedRole(name, sex) {
  if (sex !== "M" && sex !== "F") return name;
  const parts = String(name ?? "").split(" / ");
  if (parts.length !== 2) return name;
  const pick = parts[sex === "M" ? 0 : 1].trim();
  return pick.charAt(0).toUpperCase() + pick.slice(1);
}

/**
 * Order of the staff in the printed schedule.
 *  - "alpha": by name.
 *  - "arrival": who usually starts earliest: average of the first start of each day worked (earlier first; more days first on a tie).
 *  - "custom": by the position set on the employee (print_order), then alphabetical for those without one.
 * people: [{ id, name, print_order }], shifts: [{ staff_id, start_at }] of the week shown. Returns the sorted list of ids.
 */
export function orderStaff(people, shifts, mode, compare = (a, b) => a.localeCompare(b)) {
  const byName = (a, b) => compare(a.name, b.name);
  const first = new Map(); // staff -> Map(day -> earliest start in minutes)
  for (const s of shifts) {
    const day = s.start_at.slice(0, 10), m = Number(s.start_at.slice(11, 13)) * 60 + Number(s.start_at.slice(14, 16));
    const d = first.get(s.staff_id) ?? new Map();
    d.set(day, Math.min(d.get(day) ?? 1e9, m)); first.set(s.staff_id, d);
  }
  const avg = (id) => { const d = first.get(id); return d ? [...d.values()].reduce((a, b) => a + b, 0) / d.size : Infinity; };
  const days = (id) => first.get(id)?.size ?? 0;
  const list = [...people];
  if (mode === "arrival") list.sort((a, b) => avg(a.id) - avg(b.id) || days(b.id) - days(a.id) || byName(a, b));
  else if (mode === "custom") list.sort((a, b) => (a.print_order ?? 1e9) - (b.print_order ?? 1e9) || byName(a, b));
  else list.sort(byName);
  return list.map((p) => p.id);
}
