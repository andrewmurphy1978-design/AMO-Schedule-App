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
