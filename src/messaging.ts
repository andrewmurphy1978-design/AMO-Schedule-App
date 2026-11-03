// Personal messages: who may write to whom, and who may start a group. Pure, so it can be tested.

export interface DmSettings {
  scope: "department" | "restaurant" | "all"; // whom one can write to: people of the same restaurant AND department, of the same restaurant, or everyone in the company
  groups: "all" | "managers" | "off";          // who may start a conversation with several people
  max_group: number;                           // people in a group, counting the creator
}
export const DEFAULT_DM: DmSettings = { scope: "department", groups: "all", max_group: 20 };

const SCOPES = ["department", "restaurant", "all"] as const;
const GROUPS = ["all", "managers", "off"] as const;

export function parseDm(raw: string | null | undefined): DmSettings {
  let o: Record<string, unknown> = {};
  try { const x = JSON.parse(raw ?? ""); if (x && typeof x === "object") o = x as Record<string, unknown>; } catch { /* defaults */ }
  const max = typeof o.max_group === "number" && Number.isInteger(o.max_group) && o.max_group >= 3 && o.max_group <= 50 ? o.max_group : DEFAULT_DM.max_group;
  return {
    scope: (SCOPES as readonly unknown[]).includes(o.scope) ? (o.scope as DmSettings["scope"]) : DEFAULT_DM.scope,
    groups: (GROUPS as readonly unknown[]).includes(o.groups) ? (o.groups as DmSettings["groups"]) : DEFAULT_DM.groups, max_group: max,
  };
}

export function validateDm(b: unknown): { value: DmSettings } | { error: string } {
  if (!b || typeof b !== "object") return { error: "invalid" };
  const o = b as Record<string, unknown>;
  if (!(SCOPES as readonly unknown[]).includes(o.scope)) return { error: "scope" };
  if (!(GROUPS as readonly unknown[]).includes(o.groups)) return { error: "groups" };
  if (typeof o.max_group !== "number" || !Number.isInteger(o.max_group) || o.max_group < 3 || o.max_group > 50) return { error: "max_group" };
  return { value: { scope: o.scope as DmSettings["scope"], groups: o.groups as DmSettings["groups"], max_group: o.max_group } };
}

/** May this person start a conversation with several people? `manager` = holds a manager role somewhere. */
export const canStartGroup = (s: DmSettings, me: { is_admin: boolean }, manager: boolean) => s.groups === "all" || (s.groups === "managers" && (me.is_admin || manager));
