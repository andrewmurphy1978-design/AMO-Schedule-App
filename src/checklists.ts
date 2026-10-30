// End-of-shift checklists: what someone must do before leaving. A list belongs to a kitchen post (picked by the employee for the shift)
// or to a role (applies by itself to everyone working that role). Items marked "last_out" only concern the last person of the
// department to leave that day (e.g. the last delivery driver closes the day).

export interface ShiftRef { id: number; staff_id: number; restaurant_id: number; role_id: number; start_at: string; end_at: string }
export interface Issue { reason: string; note: string }
export interface Item { id: number; text_fr: string; text_en: string | null; last_out: number; done: boolean; issue: Issue | null }
export interface ShiftList { checklist_id: number; kind: "post" | "role"; target_id: number; name_fr: string; name_en: string; removable: boolean; items: Item[] }

export async function listsForShift(db: D1Database, shift: ShiftRef, clientId: number): Promise<ShiftList[]> {
  const roleIds = [...new Set([
    shift.role_id,
    ...(await db.prepare("SELECT role_id FROM shift_roles WHERE shift_id = ? UNION SELECT role_id FROM shift_segments WHERE shift_id = ?").bind(shift.id, shift.id).all<{ role_id: number }>()).results.map((r) => r.role_id),
  ])];
  const byRole = (await db.prepare(
    `SELECT c.id, c.target_id, ro.name_fr, ro.name_en, ro.department_id FROM checklists c JOIN roles ro ON ro.id = c.target_id
     WHERE c.client_id = ? AND c.kind = 'role' AND c.target_id IN (${roleIds.map(() => "?").join(",")}) ORDER BY ro.id`,
  ).bind(clientId, ...roleIds).all<{ id: number; target_id: number; name_fr: string; name_en: string; department_id: string }>()).results;
  const byPost = (await db.prepare(
    `SELECT c.id, c.target_id, p.name_fr, p.name_en FROM shift_checklists sc JOIN checklists c ON c.id = sc.checklist_id JOIN posts p ON p.id = c.target_id
     WHERE sc.shift_id = ? AND c.kind = 'post' AND c.client_id = ? ORDER BY p.sort`,
  ).bind(shift.id, clientId).all<{ id: number; target_id: number; name_fr: string; name_en: string }>()).results;
  const all = [
    ...byRole.map((r) => ({ ...r, kind: "role" as const, removable: false })),
    ...byPost.map((r) => ({ ...r, kind: "post" as const, removable: true, department_id: "" })),
  ];
  if (!all.length) return [];
  const items = (await db.prepare(`SELECT id, checklist_id, text_fr, text_en, last_out FROM checklist_items WHERE checklist_id IN (${all.map(() => "?").join(",")}) ORDER BY position, id`).bind(...all.map((x) => x.id)).all<{ id: number; checklist_id: number; text_fr: string; text_en: string | null; last_out: number }>()).results;
  const done = new Set((await db.prepare("SELECT item_id FROM shift_checklist_done WHERE shift_id = ?").bind(shift.id).all<{ item_id: number }>()).results.map((r) => r.item_id));
  const issues = new Map((await db.prepare("SELECT item_id, reason, note FROM shift_checklist_issues WHERE shift_id = ?").bind(shift.id).all<{ item_id: number; reason: string; note: string }>()).results.map((r) => [r.item_id, { reason: r.reason, note: r.note }]));
  // "last one to leave": nobody else of the same department finishes later that day at this restaurant
  const lastOut = new Map<string, boolean>();
  const isLast = async (dept: string) => {
    if (!lastOut.has(dept)) {
      const later = await db.prepare(
        `SELECT 1 FROM shifts sh JOIN roles ro ON ro.id = sh.role_id
         WHERE sh.restaurant_id = ? AND ro.department_id = ? AND sh.status = 'ok' AND sh.id != ? AND substr(sh.start_at, 1, 10) = ?
           AND (sh.end_at > ? OR (sh.end_at = ? AND sh.id > ?)) LIMIT 1`,
      ).bind(shift.restaurant_id, dept, shift.id, shift.start_at.slice(0, 10), shift.end_at, shift.end_at, shift.id).first();
      lastOut.set(dept, !later);
    }
    return lastOut.get(dept)!;
  };
  const out: ShiftList[] = [];
  for (const l of all) {
    const mine: Item[] = [];
    for (const it of items.filter((x) => x.checklist_id === l.id)) {
      if (it.last_out && !(l.department_id && (await isLast(l.department_id)))) continue;
      mine.push({ ...it, done: done.has(it.id), issue: issues.get(it.id) ?? null });
    }
    out.push({ checklist_id: l.id, kind: l.kind, target_id: l.target_id, name_fr: l.name_fr, name_en: l.name_en, removable: l.removable, items: mine });
  }
  return out;
}

/** Done / total over every list of the shift. A task reported as not completable (missing ingredient…) counts as handled. */
export async function progress(db: D1Database, shift: ShiftRef, clientId: number) {
  const lists = await listsForShift(db, shift, clientId);
  const total = lists.reduce((n, l) => n + l.items.length, 0), done = lists.reduce((n, l) => n + l.items.filter((i) => i.done || i.issue).length, 0);
  return { total, done, lists };
}
