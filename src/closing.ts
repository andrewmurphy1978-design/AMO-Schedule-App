// Closing tasks that one person does each day, given in turn: nobody gets the same one every day unless there is nobody else.

export interface ClosingTask { id: number; department_id: string; text_fr: string; text_en: string }

export const closingTasksOf = async (db: D1Database, clientId: number, department: string): Promise<ClosingTask[]> =>
  (await db.prepare("SELECT id, department_id, text_fr, text_en FROM closing_tasks WHERE client_id = ? AND department_id = ? ORDER BY position, id").bind(clientId, department).all<ClosingTask>()).results;

const minutes = (local: string) => Date.parse(`${local}:00Z`) / 60000;

/** The people of the department who leave last that day at this restaurant (within 30 minutes of the last one out). */
export async function closingCrew(db: D1Database, restaurantId: number, date: string, department: string): Promise<number[]> {
  const rows = (await db.prepare(
    `SELECT sh.staff_id, sh.end_at FROM shifts sh JOIN roles ro ON ro.id = sh.role_id JOIN staff s ON s.id = sh.staff_id
     WHERE sh.restaurant_id = ?1 AND sh.status = 'ok' AND s.active = 1 AND substr(sh.start_at, 1, 10) = ?2
       AND (ro.department_id = ?3 OR EXISTS (SELECT 1 FROM shift_roles x JOIN roles r2 ON r2.id = x.role_id WHERE x.shift_id = sh.id AND r2.department_id = ?3)
            OR EXISTS (SELECT 1 FROM shift_segments g JOIN roles r3 ON r3.id = g.role_id WHERE g.shift_id = sh.id AND r3.department_id = ?3))`,
  ).bind(restaurantId, date, department).all<{ staff_id: number; end_at: string }>()).results;
  if (!rows.length) return [];
  const last = Math.max(...rows.map((r) => minutes(r.end_at)));
  return [...new Set(rows.filter((r) => minutes(r.end_at) >= last - 30).map((r) => r.staff_id))];
}

/** Fairest choice: whoever had the task least recently (never = first), then whoever had it least often, then the lowest id. */
export function pickInTurn(candidates: number[], history: { staff_id: number; last: string; n: number }[]): number | null {
  if (!candidates.length) return null;
  const h = new Map(history.map((x) => [x.staff_id, x]));
  return [...candidates].sort((a, b) => (h.get(a)?.last ?? "").localeCompare(h.get(b)?.last ?? "") || (h.get(a)?.n ?? 0) - (h.get(b)?.n ?? 0) || a - b)[0];
}

/** Who has this task on this day at this restaurant: the saved choice if that person still closes, else the next one in turn (saved). */
export async function closingAssignee(db: D1Database, task: ClosingTask, restaurantId: number, date: string): Promise<number | null> {
  const crew = await closingCrew(db, restaurantId, date, task.department_id);
  const saved = await db.prepare("SELECT staff_id, assigned_by FROM closing_task_assignments WHERE task_id = ? AND restaurant_id = ? AND date = ?").bind(task.id, restaurantId, date).first<{ staff_id: number; assigned_by: number | null }>();
  // a manager's choice stays as long as that person works that day at all; an automatic one only while that person is still in the closing crew
  if (saved && (crew.includes(saved.staff_id) || saved.assigned_by !== null)) return saved.staff_id;
  if (!crew.length) return saved?.staff_id ?? null;
  const history = (await db.prepare("SELECT staff_id, MAX(date) AS last, COUNT(*) AS n FROM closing_task_assignments WHERE task_id = ? AND restaurant_id = ? AND date < ? GROUP BY staff_id").bind(task.id, restaurantId, date).all<{ staff_id: number; last: string; n: number }>()).results;
  const pick = pickInTurn(crew, history)!;
  await db.prepare("INSERT INTO closing_task_assignments (task_id, restaurant_id, date, staff_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?, NULL, ?) ON CONFLICT (task_id, restaurant_id, date) DO UPDATE SET staff_id = excluded.staff_id, assigned_by = NULL, assigned_at = excluded.assigned_at")
    .bind(task.id, restaurantId, date, pick, Date.now()).run();
  return pick;
}
