import { splitName, joinName, shortNames } from "./names.js";
import { t, getLang, setLang, locale, roleName, roleIcon, deptIcon } from "./i18n.js";
import { DEFAULT_BOUNDARIES, periodKeys, toMin, fromMin, shiftSpan, resolveTargets, targetWindows, targetAt, coverage, shortages, surpluses } from "./coverage.js";
import { resolveForDate, ruleMatches, SPECIAL_PRESETS, SEASON_PRESETS, holidaysOn } from "./rules.js";
import { staffColor, textOn, SWATCHES, setStaffOrder } from "./colors.js";

// ---------- helpers ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k in el && k !== "list") { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}


// 24-hour time picker. <input type="time"> follows the device language (AM/PM on English systems),
// so we use two selects. It behaves like an input: .value ("HH:MM"), .disabled, and bubbling "input" events.
// replaceChildren() with arrays and empty values: flatten the arrays and skip null/false/undefined, like h() does for its children
// (otherwise "null" or "[object HTMLDivElement]" would be written on the page).
{
  const native = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...nodes) {
    return native.apply(this, nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
  };
}

function timeField(value = "00:00") {
  const p2 = (n) => String(n).padStart(2, "0");
  const hh = h("select", { "aria-label": "HH" }, Array.from({ length: 24 }, (_, i) => h("option", { value: p2(i) }, p2(i))));
  const mm = h("select", { "aria-label": "MM" });
  const fillMinutes = (current) => {
    const mins = new Set(Array.from({ length: 12 }, (_, i) => i * 5));
    mins.add(Number(current));
    mm.replaceChildren(...[...mins].sort((a, b) => a - b).map((m) => h("option", { value: p2(m) }, p2(m))));
  };
  const el = h("div", { class: "time24" }, hh, h("span", {}, ":"), mm);
  Object.defineProperty(el, "value", {
    get: () => `${hh.value}:${mm.value}`,
    set: (v) => { const [a, b] = String(v || "00:00").split(":"); fillMinutes(b); hh.value = p2(Number(a)); mm.value = p2(Number(b)); },
  });
  Object.defineProperty(el, "disabled", { get: () => hh.disabled, set: (d) => { hh.disabled = d; mm.disabled = d; } });
  el.value = value;
  return el;
}

// Round picture, or a coloured circle with initials when there is no picture. photoV changes with every new upload.
function avatar(id, name, color, photoV, size = 28) {
  const c = staffColor(id, color);
  const style = `--s:${size}px`;
  if (photoV) return h("img", { class: "avatar", style, alt: name, loading: "lazy", src: `/api/staff/${id}/photo?v=${photoV}` });
  const initials = name.replace(/\(.*?\)/g, "").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  return h("span", { class: "avatar", style: `${style};background:${c};color:${textOn(c)}`, "aria-label": name }, initials);
}

// Crop to a centred square and shrink to 256px JPEG, so a phone photo (several MB) becomes about 20 KB.
async function photoToDataUrl(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const side = Math.min(bmp.width, bmp.height), size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  canvas.getContext("2d").drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  return canvas.toDataURL("image/jpeg", 0.85);
}

class ApiError extends Error {
  constructor(status, body) { super(body?.error ?? String(status)); this.status = status; this.body = body ?? {}; }
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? "GET",
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

const money = (cents, decimals = false) => new Intl.NumberFormat(locale(), { style: "currency", currency: "CAD", minimumFractionDigits: decimals ? 2 : 0, maximumFractionDigits: decimals ? 2 : 0 }).format(cents / 100);
const hrs = (n) => `${Math.round(n * 10) / 10}`.replace(".", getLang() === "fr" ? "," : ".");
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const mondayOf = (d) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return ymd(x); };
const hhmm = (iso) => iso.slice(11, 16);
// Until-close shifts show "F" instead of an end time. end_at is a provisional closing time
// until per-restaurant closing hours exist.
// Closing time for a weekday (0 = Monday ... 6 = Sunday).
const closeOf = (restaurantId, dow) => { const r = state.restaurants.find((x) => x.id === restaurantId); return r?.close_by_dow?.[dow] ?? r?.close_time ?? "22:00"; };
const dowOf = (ymdStr) => (parseYmd(ymdStr).getDay() + 6) % 7;
// Opening time for a weekday (0 = Monday ... 6 = Sunday).
const openOf = (restaurantId, dow) => { const r = state.restaurants.find((x) => x.id === restaurantId); return r?.open_by_dow?.[dow] ?? r?.open_time ?? "07:00"; };
const range = (s) => `${hhmm(s.start_at)} – ${s.until_close ? "F" : hhmm(s.end_at)}`;
const dayOf = (iso) => iso.slice(0, 10);
const fmt = (s, opts) => new Intl.DateTimeFormat(locale(), opts).format(parseYmd(s));
const weekLabel = (mon) => {
  const sun = addDays(mon, 6);
  return `${fmt(mon, { day: "numeric", month: "short" })} – ${fmt(sun, { day: "numeric", month: "short", year: "numeric" })}`;
};

function toast(msg) {
  const el = h("div", { class: "toast", role: "status" }, msg);
  document.body.append(el);
  setTimeout(() => el.remove(), 2200);
}

function errorText(e) {
  const map = { forbidden: "forbidden", invalid_times: "invalidTimes", staff_does_not_hold_role_at_restaurant: "notHeld" };
  return t(map[e?.body?.error] ?? "genericError");
}

// ---------- state ----------
const state = {
  me: null, restaurants: [], roles: [], view: "schedule",
  sel: { restaurant: null, department: null, departments: [], week: mondayOf(new Date()), day: ymd(new Date()) },
};

const DEPTS = ["floor", "kitchen", "prep", "delivery", "admin"];
state.zoomDay = null; // desktop coverage: a single day shown large (set by clicking a day header)
state.showHourlyCost = (() => { try { return localStorage.getItem("hourlyCost") === "1"; } catch { return false; } })();

function allowedDepartments(restaurantId) {
  const { me, roles } = state.me ? { me: state.me.me, roles: state.me } : {};
  if (!me) return [];
  if (me.is_admin) return DEPTS;
  const set = new Set();
  for (const m of state.me.managed) if (m.restaurant_id === restaurantId) set.add(m.department_id);
  for (const r of state.me.roles) if (r.restaurant_id === restaurantId) set.add(r.department_id);
  return DEPTS.filter((d) => set.has(d));
}

// ---------- shell ----------
const $app = document.getElementById("app");

function renderChrome() {
  document.getElementById("lang-toggle").textContent = getLang() === "fr" ? "English" : "Français";
  document.getElementById("footer").textContent = t("footer");
  document.getElementById("brand-sub").textContent = t("app");
  document.title = `Mikes · ${t("app")}`;
  const tabs = [["schedule", t("schedule")], ["mine", t("myShifts")], ["timeoff", t("timeOff")], ["account", t("account")]];
  if (state.me?.me.is_admin) tabs.push(["admin", t("admin")]);
  const nav = document.getElementById("main-tabs");
  nav.replaceChildren(
    ...tabs.map(([id, label]) =>
      h("button", { type: "button", "aria-current": state.view === id ? "page" : false, onClick: () => { state.view = id; render(); } }, label)),
  );
}

async function render() {
  renderChrome();
  try {
    setStaffOrder(await api("/staff-order").catch(() => []));
    // Roles and manager scopes can change in Administration at any time, so never trust the copy loaded at start-up.
    if (state.view !== "admin") {
      [state.me, state.restaurants] = await Promise.all([api("/me"), api("/restaurants")]);
      renderChrome();
    }
    if (state.view === "schedule") await renderSchedule();
    else if (state.view === "mine") await renderMine();
    else if (state.view === "timeoff") await renderTimeOff();
    else if (state.view === "account") await renderAccount();
    else await renderAdmin();
  } catch (e) {
    $app.replaceChildren(h("div", { class: "empty" }, errorText(e)));
  }
}

document.getElementById("lang-toggle").addEventListener("click", () => {
  setLang(getLang() === "fr" ? "en" : "fr");
  render();
});

// ---------- schedule ----------
// Time off requested (C/D) or approved (C/A) for the week shown; managers can answer pending requests right here.
function weekTimeOffPanel(data) {
  const list = data.time_off ?? [];
  if (!list.length) return null;
  const when = (o) => (o.start_date === o.end_date ? fmt(o.start_date, { weekday: "short", day: "numeric", month: "short" }) : `${fmt(o.start_date, { weekday: "short", day: "numeric" })} → ${fmt(o.end_date, { weekday: "short", day: "numeric", month: "short" })}`) + (o.start_time ? ` · ${o.start_time}–${o.end_time}` : "");
  const pending = list.filter((o) => o.status === "requested").length;
  const answer = async (o, approve) => { try { await api(`/time-off/${o.id}/decide`, { method: "POST", body: { approve } }); toast(t("saved")); render(); } catch (e) { toast(errorText(e)); } };
  return h("details", { class: "panel week-off", open: pending > 0 },
    h("summary", {}, `${t("weekTimeOff")} (${list.length})${pending ? ` · ${pending} C/D` : ""}`),
    list.map((o) => h("div", { class: "cov-row" },
      h("div", {}, h("span", { class: `off-chip ${o.status}` }, o.status === "approved" ? "C/A" : "C/D"), ` `, h("b", {}, o.staff_name), ` · ${when(o)}`),
      o.note ? h("div", { class: "meta" }, o.note) : null,
      data.editable && o.status === "requested" ? h("div", { class: "actions" },
        h("button", { class: "btn primary", type: "button", onClick: () => answer(o, true) }, t("approve")),
        h("button", { class: "btn", type: "button", onClick: () => answer(o, false) }, t("deny"))) : null)));
}
// A shift can cover several roles (cook + dishwasher): the main role first, then the extra ones.
const shiftRoles = (s) => [{ name_fr: s.name_fr, name_en: s.name_en, department_id: s.department_id }, ...(s.extra_roles ?? [])].map((r) => ({ ...r, sex: s.sex }));
const shiftRoleLabel = (s) => shiftRoles(s).map((r) => roleName(r)).join(" + ");
const shiftRoleIcons = (s) => shiftRoles(s).map(roleIcon).join("");
const nowLocal = () => { const d = new Date(); return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// Open replacement requests (managers/admins): who was asked, assign by hand, cancel.
function coveragePanel(onChange) {
  const box = h("section", { class: "panel coverage-panel", hidden: true });
  api("/coverage").then((rows) => {
    const open = rows.filter((r) => r.status === "open"), recent = rows.filter((r) => r.status !== "open").slice(0, 5);
    if (!open.length && !recent.length) return;
    box.hidden = false;
    const line = (r) => h("div", { class: `cov-row ${r.status}` },
      h("div", {}, h("b", {}, `${r.sick_name}`), ` · ${roleName(r)} · ${r.restaurant}`, h("div", { class: "meta" }, `${fmt(r.start_at.slice(0, 10), { weekday: "short", day: "numeric", month: "short" })} ${hhmm(r.start_at)}–${r.until_close ? "F" : hhmm(r.end_at)}`)),
      h("div", { class: "meta" }, r.status === "open" ? `${t("asked")}: ${r.offers} · ${t("waiting")}: ${r.waiting} · ${t("declined")}: ${r.declined}${r.escalated_at ? ` · ⚠ ${t("actionRequired")}` : ""}`
        : r.status === "filled" ? `✔ ${t("filledBy")} ${r.filled_by_name ?? ""}` : t("cancelled")),
      r.status === "open" ? h("div", { class: "actions" },
        h("button", { class: "btn primary", type: "button", onClick: () => assignDialog(r, onChange) }, t("assignManually")),
        h("button", { class: "btn danger", type: "button", onClick: async () => { if (confirm(t("confirmCancelSick"))) { try { await api(`/coverage/${r.id}/cancel`, { method: "POST" }); onChange(); } catch (e) { toast(errorText(e)); } } } }, t("cancelSick"))) : null);
    box.replaceChildren(h("h2", {}, t("replacements")), open.map(line), recent.length ? h("details", {}, h("summary", {}, t("recent")), recent.map(line)) : null);
  }).catch(() => {});
  return box;
}

async function assignDialog(r, onChange) {
  const dlg = document.getElementById("modal");
  let cand;
  try { cand = await api(`/coverage/${r.id}/candidates`); } catch (e) { toast(errorText(e)); return; }
  dlg.replaceChildren(h("div", { class: "modal-body" }, h("h2", {}, t("assignManually")),
    cand.eligible.length ? cand.eligible.map((p) => h("button", { class: "btn", type: "button", style: "display:block;width:100%;margin:6px 0;text-align:left", onClick: async () => {
      try { await api(`/coverage/${r.id}/assign`, { method: "POST", body: { staff_id: p.staff_id } }); dlg.close(); toast(t("saved")); onChange(); } catch (e) { toast(errorText(e)); }
    } }, `${p.name} — ${p.week_hours} ${t("hoursShort")}`)) : h("p", { class: "meta" }, t("nobodyEligible")),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: () => dlg.close() }, t("cancel")))));
  dlg.showModal();
}
function mergeSchedules(datas, restaurantId, depts) {
  if (datas.length === 1) return datas[0];
  const seen = new Set();
  const shifts = datas.flatMap((d) => d.shifts).filter((x) => !seen.has(x.id) && seen.add(x.id))
    .sort((a, b) => (a.start_at < b.start_at ? -1 : a.start_at > b.start_at ? 1 : a.staff_name.localeCompare(b.staff_name)));
  const hours = Object.assign({}, ...datas.map((d) => d.hours));
  // "Working elsewhere" must not list shifts that are visible on this very screen.
  const key = new Set();
  const elsewhere = datas.flatMap((d) => d.elsewhere ?? [])
    .filter((e) => !(e.restaurant_id === restaurantId && depts.includes(e.department_id)))
    .filter((e) => { const k = `${e.staff_id}|${e.start_at}|${e.end_at}`; return !key.has(k) && key.add(k); });
  const offSeen = new Set();
  const time_off = datas.flatMap((d) => d.time_off ?? []).filter((o) => { const k = `${o.staff_id}|${o.start_date}|${o.end_date}|${o.status}`; return !offSeen.has(k) && offSeen.add(k); });
  const by_staff = Object.assign({}, ...datas.map((d) => d.limits?.by_staff ?? {}));
  const days_off = Object.assign({}, ...datas.map((d) => d.days_off ?? {}));
  return { ...datas[0], editable: datas.some((d) => d.editable), shifts, hours, elsewhere, time_off, days_off, limits: { ...datas[0].limits, by_staff } };
}
function mergeRosters(rosters) {
  const by = new Map();
  for (const r of rosters.flat()) {
    const e = by.get(r.staff_id);
    if (e) { e.role_ids = [...new Set([...e.role_ids, ...r.role_ids])]; e.all_role_ids = [...new Set([...(e.all_role_ids ?? []), ...(r.all_role_ids ?? [])])]; } else by.set(r.staff_id, { ...r, role_ids: [...r.role_ids] });
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function mergePayrolls(list, depts) {
  const byDept = list.map((p, i) => (p ? { dept: depts[i], payroll: p } : null)).filter(Boolean);
  const ok = list.filter(Boolean);
  if (!ok.length) return null;
  if (ok.length === 1) return { ...ok[0], byDept };
  const days = ok[0].department.days.map((d, i) => ({
    date: d.date,
    cents: ok.reduce((n, p) => n + p.department.days[i].cents, 0),
    hours: ok.reduce((n, p) => n + p.department.days[i].hours, 0),
    by_hour: d.by_hour.map((_, h) => ok.reduce((n, p) => n + p.department.days[i].by_hour[h], 0)),
  }));
  return { ...ok[0], byDept, department: { ...ok[0].department, days,
    total_cents: ok.reduce((n, p) => n + p.department.total_cents, 0),
    total_hours: ok.reduce((n, p) => n + p.department.total_hours, 0) } };
}
function pickDefaults() {
  const sel = state.sel;
  const options = state.restaurants.filter((r) => allowedDepartments(r.id).length);
  if (!options.length) return false;
  if (!options.some((r) => r.id === sel.restaurant)) sel.restaurant = options[0].id;
  const depts = allowedDepartments(sel.restaurant);
  sel.departments = (sel.departments ?? []).filter((d) => depts.includes(d));
  if (!sel.departments.length) sel.departments = [depts.includes(sel.department) ? sel.department : depts.includes("kitchen") ? "kitchen" : depts[0]];
  sel.department = sel.departments[0];
  return options;
}

async function renderSchedule() {
  const options = pickDefaults();
  if (!options) { $app.replaceChildren(h("div", { class: "empty" }, t("noSchedules"))); return; }
  const sel = state.sel;
  // Several departments can be shown together (e.g. Kitchen + Dish/Prep): fetch each one and merge.
  const depts = sel.departments;
  const q = (d) => `restaurant=${sel.restaurant}&department=${d}&week=${sel.week}`;
  const datas = await Promise.all(depts.map((d) => api(`/schedule?${q(d)}`)));
  const data = mergeSchedules(datas, sel.restaurant, depts);
  const rosters = await Promise.all(depts.map(async (d, i) => (datas[i].editable ? api(`/roster?restaurant=${sel.restaurant}&department=${d}`) : [])));
  const roster = mergeRosters(rosters);
  // Labour cost: only requested for admins; the server refuses everyone else.
  const payrollReq = state.me.me.is_admin
    ? Promise.all(depts.map((d) => api(`/admin/payroll?${q(d)}`).catch(() => null))).then((list) => mergePayrolls(list, depts))
    : Promise.resolve(null);
  const [targets, sets, payroll] = await Promise.all([
    Promise.all(depts.map(async (d) => (await api(`/targets?restaurant=${sel.restaurant}&department=${d}`)).map((r) => ({ ...r, department_id: d })))).then((x) => x.flat()),
    api(`/target-sets?restaurant=${sel.restaurant}`),
    payrollReq,
  ]);
  const days = Array.from({ length: 7 }, (_, i) => addDays(sel.week, i));
  if (state.zoomDay && !days.includes(state.zoomDay)) state.zoomDay = null;
  if (!days.includes(sel.day)) sel.day = days.includes(ymd(new Date())) ? ymd(new Date()) : days[0];
  const today = ymd(new Date());

  const controls = h("div", { class: "controls" },
    h("label", { class: "field" }, h("span", {}, t("restaurant")),
      h("select", { onChange: (e) => { sel.restaurant = Number(e.target.value); render(); } },
        options.map((r) => h("option", { value: r.id, selected: r.id === sel.restaurant }, r.name)))),
    h("div", { class: "field" }, h("span", {}, t("department")),
      h("div", { class: "seg" }, allowedDepartments(sel.restaurant).map((d) =>
        h("button", { type: "button", "aria-pressed": String(sel.departments.includes(d)), onClick: () => {
          // Toggle: tap several to show them together; at least one stays selected.
          const on = sel.departments.includes(d);
          if (on && sel.departments.length === 1) return;
          sel.departments = on ? sel.departments.filter((x) => x !== d) : DEPTS.filter((x) => x === d || sel.departments.includes(x));
          sel.department = sel.departments[0]; render();
        } }, t(`dept.${d}`))))),
    h("div", { class: "field" }, h("span", {}, t("week")),
      h("div", { class: "weeknav" },
        h("button", { class: "icon-btn", type: "button", "aria-label": t("prev"), onClick: () => { sel.week = addDays(sel.week, -7); sel.day = sel.week; render(); } }, "‹"),
        h("div", { class: "label" }, weekLabel(sel.week)),
        h("button", { class: "icon-btn", type: "button", "aria-label": t("next"), onClick: () => { sel.week = addDays(sel.week, 7); sel.day = sel.week; render(); } }, "›"))),
    h("div", { class: "field" }, h("span", {}, " "),
      h("button", { class: "btn", type: "button", onClick: () => { sel.week = mondayOf(new Date()); sel.day = ymd(new Date()); render(); } }, t("today"))),
    h("div", { class: "field" }, h("span", {}, " "),
      h("button", { class: "btn", type: "button", title: t("printHint"), onClick: () => window.print() }, `🖨 ${t("printSchedule")}`)),
  );
  // Only shown on paper: a title above the week table so the printed/PDF schedule can be posted in the restaurant.
  const printHead = h("div", { class: "print-head" },
    h("img", { src: "logo.png", alt: "Mikes", height: 48, onerror: (e) => e.target.remove() }),
    h("div", {}, h("h1", {}, `${options.find((r) => r.id === sel.restaurant)?.name ?? ""} — ${sel.departments.map((d) => t(`dept.${d}`)).join(" · ")}`), h("p", {}, weekLabel(sel.week))));

  const status = h("p", {}, h("span", { class: `badge ${data.editable ? "edit" : ""}` }, data.editable ? t("canEdit") : t("viewOnly")));
  const byDay = (d) => data.shifts.filter((s) => dayOf(s.start_at) === d);
  const openEditor = (shift, prefill) => openShiftModal({ shift, prefill, roster, data });

  // Mobile: day tabs + list
  const daytabs = h("div", { class: "daytabs", role: "group" }, days.map((d) =>
    h("button", { type: "button", class: byDay(d).length ? "has" : "", "aria-pressed": String(d === sel.day), onClick: () => { sel.day = d; render(); } },
      h("span", { class: "dow" }, fmt(d, { weekday: "short" })), h("span", { class: "dom" }, fmt(d, { day: "numeric" })))));
  const dayShifts = byDay(sel.day);
  const nameById = new Map([...roster.map((r) => [r.staff_id, r.name]), ...data.shifts.map((x) => [x.staff_id, x.staff_name])]);
  const elsewhereToday = (data.elsewhere ?? []).filter((e) => dayOf(e.start_at) === sel.day);
  const offToday = (data.time_off ?? []).filter((o) => o.start_date <= sel.day && o.end_date >= sel.day);
  const daily = h("section", { class: "daily" },
    h("h2", {}, fmt(sel.day, { weekday: "long", day: "numeric", month: "long" })),
    dayShifts.length
      ? h("div", { class: "list" }, dayShifts.map((s) => {
          const sickDay = s.status === "sick_open";
          const card = [h("span", { class: "time" }, range(s)), h("span", { class: "who" }, avatar(s.staff_id, s.staff_name, s.staff_color, s.photo_v, 40), s.staff_name),
            h("span", { class: "meta" }, [`${shiftRoleIcons(s)} ${shiftRoleLabel(s)}`, s.notes].filter(Boolean).join(" · ")),
            sickDay ? h("span", { class: "sick-badge" }, `🤒 ${t("sickOpen")}`) : null,
            s.replaced_name ? h("span", { class: "replaced" }, `${t("replacing")} ${s.replaced_name}`) : null];
          const cls = `card ${sickDay ? "sick" : ""}`;
          return data.editable ? h("button", { class: cls, type: "button", onClick: () => openEditor(s) }, card) : h("div", { class: cls }, card);
        }))
      : h("div", { class: "empty" }, t("noShifts")),
    // Requested (C/D) and approved (C/A) time off that day.
    offToday.length ? h("div", { class: "off-list" }, h("h3", {}, t("timeOff")),
      offToday.map((o) => h("div", { class: "elsewhere" }, h("span", { class: `off-chip ${o.status}` }, o.status === "approved" ? "C/A" : "C/D"), ` ${nameById.get(o.staff_id) ?? ""}${o.start_time ? ` · ${o.start_time}–${o.end_time}` : ""}`))) : null,
    // People on this schedule who work somewhere else that day (managers only).
    elsewhereToday.length ? h("div", { class: "elsewhere-list" }, h("h3", {}, t("elsewhereToday")),
      elsewhereToday.map((e) => h("div", { class: "elsewhere" }, h("b", {}, `↗ ${nameById.get(e.staff_id) ?? ""} · ${hhmm(e.start_at)}–${hhmm(e.end_at)}`), ` ${e.restaurant_id === sel.restaurant ? `${e.restaurant} · ${t(`dept.${e.department_id}`)}` : e.restaurant}`))) : null,
    // Weekly hours per person (phones; on desktop they are the last column of the grid).
    data.hours && Object.keys(data.hours).length ? h("details", { class: "hours-panel" }, h("summary", {}, t("weekHours")),
      Object.entries(data.hours).map(([id, hh]) => [Number(id), hh]).sort((a, b) => (nameById.get(a[0]) ?? "").localeCompare(nameById.get(b[0]) ?? "", locale())).map(([id, hh]) =>
        h("div", { class: `hours-line ${hh.all > Math.min(data.limits?.by_staff?.[id] ?? 1e9, data.limits?.overtime_hours ?? 40) ? "over" : ""}` }, h("span", {}, nameById.get(id) ?? ""),
          h("b", {}, `${hrs(hh.here)} ${t("hoursShort")}`, hh.all - hh.here > 0.01 ? ` (${hrs(hh.all)} ${t("hoursShort")} ${t("allPlaces")})` : "", hh.all > (data.limits?.overtime_hours ?? 40) ? " ⚠" : "")))) : null);
  const fab = data.editable ? h("button", { class: "fab", type: "button", "aria-label": t("addShift"), onClick: () => openEditor(null, { date: sel.day }) }, "+") : null;

  // Desktop: staff × days grid
  const people = new Map();
  for (const r of roster) people.set(r.staff_id, r.name);
  for (const s of data.shifts) people.set(s.staff_id, s.staff_name);
  const meta = new Map();
  for (const r of roster) meta.set(r.staff_id, { color: r.color, photo_v: r.photo_v });
  for (const sh of data.shifts) meta.set(sh.staff_id, { color: sh.staff_color, photo_v: sh.photo_v });
  // First name on one line, last name on the next: a narrower name column.
  const parts = new Map();
  for (const r of roster) parts.set(r.staff_id, r.first_name ? { first: r.first_name, last: r.last_name } : splitName(r.name));
  for (const sh of data.shifts) parts.set(sh.staff_id, sh.first_name ? { first: sh.first_name, last: sh.last_name } : splitName(sh.staff_name));
  const rows = [...people.entries()].sort((a, b) => a[1].localeCompare(b[1], locale()));
  const limit = data.limits?.overtime_hours ?? 40;
  const offAt = (id, d) => (data.time_off ?? []).find((o) => o.staff_id === id && o.start_date <= d && o.end_date >= d);
  const offChip = (o) => h("div", { class: `off-chip ${o.status}`, title: o.status === "approved" ? t("offApproved") : t("offRequested") }, `${o.status === "approved" ? "C/A" : "C/D"}${o.start_time ? ` ${o.start_time.replace(/^0/, "").replace(":00", "")}–${o.end_time.replace(/^0/, "").replace(":00", "")}` : ""}`);
  const elsewhereAt = (id, d) => (data.elsewhere ?? []).filter((e) => e.staff_id === id && dayOf(e.start_at) === d);
  const place = (e) => (e.restaurant_id === sel.restaurant ? `${e.restaurant} · ${t(`dept.${e.department_id}`)}` : e.restaurant);
  const totalCell = (id) => {
    const hh = data.hours?.[id];
    if (!hh) return h("td", { class: "total" }, "");
    const personal = data.limits?.by_staff?.[id];
    const cap = personal != null ? Math.min(personal, limit) : limit;
    const over = hh.all > cap;
    return h("td", { class: `total ${over ? "over" : ""}`, title: over ? t("overtimeWarn") : "" },
      personal != null ? h("small", {}, `${t("maxShort")} ${hrs(personal)} ${t("hoursShort")}`) : null,
      h("strong", {}, `${hrs(hh.here)} ${t("hoursShort")}`),
      hh.all - hh.here > 0.01 ? h("small", {}, `${hrs(hh.all)} ${t("hoursShort")} ${t("allPlaces")}`) : null,
      over ? h("small", { class: "warn" }, `⚠ ${t("overtimeWarn")}`) : null);
  };
  const grid = h("div", { class: "grid-wrap" }, h("table", { class: "grid" },
    h("thead", {}, h("tr", {}, h("th", {}, ""), days.map((d) =>
      h("th", { class: d === today ? "today" : "" },
        // Clicking a day here zooms the coverage view below on that day and scrolls to it.
        h("button", { type: "button", class: "th-zoom", title: t("zoomDay"), "aria-label": `${t("zoomDay")}: ${fmt(d, { weekday: "long", day: "numeric", month: "long" })}`, onClick: () => zoomTo(d) },
          fmt(d, { weekday: "short", day: "numeric", month: "short" })))), data.hours ? h("th", { class: "total" }, t("total")) : null)),
    h("tbody", {}, rows.length ? rows.map(([id, name]) =>
      h("tr", { class: data.shifts.some((s) => s.staff_id === id) || (data.elsewhere ?? []).some((e) => e.staff_id === id) ? "" : "noshift" }, h("td", { class: "name", title: name }, avatar(id, name, meta.get(id)?.color, meta.get(id)?.photo_v, 36),
        h("span", { class: "name2" }, h("span", { class: "n1" }, parts.get(id)?.first ?? name), parts.get(id)?.last ? h("span", { class: "n2" }, parts.get(id).last) : null)), days.map((d) =>
        h("td", {},
          offAt(id, d) ? offChip(offAt(id, d)) : null,
          (data.days_off?.[id] ?? []).includes((parseYmd(d).getDay() + 6) % 7) ? h("div", { class: "off-chip fixed", title: t("fixedDayOff") }, t("fixedOffShort")) : null,
          data.shifts.filter((s) => s.staff_id === id && dayOf(s.start_at) === d).map((s) => {
            const sick = s.status === "sick_open";
            const body = [h("b", {}, range(s).replace(" – ", "–")), ` ${shiftRoleIcons(s)} ${shiftRoleLabel(s)}`, sick ? h("span", { class: "sick-badge" }, `🤒 ${t("sickOpen")}`) : null,
              s.replaced_name ? h("span", { class: "replaced" }, `${t("replacing")} ${s.replaced_name}`) : null];
            const c = staffColor(s.staff_id, s.staff_color);
            const style = `border-left-color:${c};background:color-mix(in srgb, ${c} 16%, var(--card))`;
            const cls = `shift-chip ${sick ? "sick" : ""}`;
            return data.editable ? h("button", { class: cls, type: "button", style, onClick: () => openEditor(s) }, body) : h("div", { class: cls, style }, body);
          }),
          // Working somewhere else the same day: shown in grey so you don't double-book by mistake.
          elsewhereAt(id, d).map((e) => h("div", { class: "elsewhere", title: t("elsewhere") }, h("b", {}, `↗ ${hhmm(e.start_at)}–${hhmm(e.end_at)}`), ` ${place(e)}`, h("span", { class: "print-only" }, ` (${t("shiftElsewhere")})`))),
          data.editable ? h("button", { class: "add-cell", type: "button", "aria-label": t("addShift"), onClick: () => openEditor(null, { date: d, staff_id: id }) }, "+") : null)),
        data.hours ? totalCell(id) : null))
      : h("tr", {}, h("td", { colSpan: 9 }, h("div", { class: "empty" }, t("noShiftsWeek")))))));

  const timeline = renderTimeline({ data, days, targets, sets, payroll, openEditor });
  $app.replaceChildren(...[printHead, controls, status, data.editable ? coveragePanel(render) : null, weekTimeOffPanel(data), daytabs, timeline, daily, grid, fab].filter(Boolean));
}


// Zoom the coverage view on one day (desktop) or just select it (phone), then bring it into view.
async function zoomTo(day) {
  state.sel.day = day;
  if (mqDesktop.matches) state.zoomDay = day;
  await render();
  document.querySelector("section.timeline")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- coverage timeline (vertical) ----------
// Target periods of a restaurant: Open-8:00, 8:00-9:00 ... 20:00-Close (editable per restaurant).
const boundsOf = (restaurantId, list = state.restaurants) => list?.find((r) => r.id === restaurantId)?.period_bounds ?? DEFAULT_BOUNDARIES;
const hm = (x) => x.replace(/^0/, "");
function periodLabel(boundaries, key) {
  const keys = periodKeys(boundaries), i = keys.indexOf(key);
  const next = i >= 0 && i + 1 < keys.length ? hm(keys[i + 1]) : t("closeSlot");
  return `${key === "open" ? t("openSlot") : hm(key)}–${next}`;
}
const mqDesktop = window.matchMedia("(min-width: 900px)");
mqDesktop.addEventListener("change", () => { if (state.me) render(); });

// Side-by-side lanes for overlapping bars, grouped by department then role (Salle, Cuisine, Plonge/Préparation, Livraison).
// All shifts of one person share one lane (split shift = same column); a lane is shared with someone else only inside the
// same department and only when none of their shifts overlap.
const DEPT_RANK = Object.fromEntries(DEPTS.map((d, i) => [d, i]));
function assignLanes(items) {
  const people = new Map();
  for (const it of items) {
    const rank = (DEPT_RANK[it.s.department_id] ?? 9) * 1000 + (it.s.role_id ?? 0);
    const p = people.get(it.s.staff_id) ?? { rank, first: Infinity, name: it.s.staff_name, spans: [], items: [] };
    p.rank = Math.min(p.rank, rank); p.first = Math.min(p.first, it.from); p.spans.push(it); p.items.push(it);
    people.set(it.s.staff_id, p);
  }
  const lanes = []; // { dept, spans }
  for (const p of [...people.values()].sort((x, y) => x.rank - y.rank || x.first - y.first || x.name.localeCompare(y.name))) {
    const dept = Math.floor(p.rank / 1000);
    let lane = lanes.findIndex((l) => l.dept === dept && l.spans.every((o) => p.spans.every((m) => o.to <= m.from || m.to <= o.from)));
    if (lane === -1) {
      // keep lanes in department order: insert after the last lane of an earlier-or-equal department
      lane = lanes.length; lanes.push({ dept, spans: [] });
    }
    lanes[lane].spans.push(...p.spans);
    for (const it of p.items) it.lane = lane;
  }
  return Math.max(1, lanes.length);
}

function renderTimeline({ data, days, targets, sets, payroll, openEditor }) {
  // The coverage view shows first names only (plus the last-name initial when two people share a first name).
  const shortOf = shortNames([...new Map(data.shifts.map((x) => [x.staff_id, { id: x.staff_id, name: x.staff_name, first_name: x.first_name, last_name: x.last_name }])).values()]);
  const sel = state.sel;
  const desktop = mqDesktop.matches;
  const zoom = !!(desktop && state.zoomDay && days.includes(state.zoomDay));
  const shown = zoom ? [state.zoomDay] : desktop ? days : [sel.day];

  const perDay = shown.map((day) => {
    // Each department resolves its own layers (base/season/special day); the counts are then added together.
    const dayTargets = {}; let labels = [];
    for (const d of sel.departments) {
      const r = resolveForDate(targets.filter((x) => x.department_id === d), sets, day);
      for (const [slot, n] of Object.entries(r.targets)) dayTargets[slot] = (dayTargets[slot] ?? 0) + n;
      labels = r.labels;
    }
    const openMin = toMin(openOf(sel.restaurant, (parseYmd(day).getDay() + 6) % 7));
    const closeMin = toMin(closeOf(sel.restaurant, dowOf(day)));
    const wins = targetWindows(dayTargets, openMin, closeMin, boundsOf(sel.restaurant));
    const items = data.shifts.map((s) => ({ s, span: shiftSpan(s, day) })).filter((x) => x.span.s < 1440 && x.span.e > 0)
      .sort((a, b) => a.span.s - b.span.s || a.s.staff_name.localeCompare(b.s.staff_name, locale()));
    const cost = payroll?.department.days.find((x) => x.date === day) ?? null;
    return { day, wins, items, labels, openMin, closeMin, cost };
  });

  const starts = perDay.flatMap((d) => [...d.items.map((x) => Math.max(0, x.span.s)), ...d.wins.map((w) => w.from)]);
  const ends = perDay.flatMap((d) => [...d.items.map((x) => Math.min(1560, x.span.e)), ...d.wins.map((w) => w.to)]);
  const startMin = Math.floor(Math.min(...perDay.map((d) => d.openMin), ...starts) / 60) * 60;
  const endMin = Math.ceil(Math.max(...perDay.map((d) => d.closeMin), ...ends) / 60) * 60;
  const hours = (endMin - startMin) / 60;
  const ph = zoom ? 68 : desktop ? 44 : 56; // pixels per hour
  const y = (m) => ((m - startMin) / 60) * ph;
  const today = ymd(new Date());
  const mainWidth = $app.clientWidth || 360;
  const colWidth = zoom ? mainWidth - 48 : desktop ? Math.max(payroll && state.showHourlyCost ? 160 : 118, (mainWidth - 48) / 7) : mainWidth - 48;
  const laneArea = colWidth - 46 - (payroll && state.showHourlyCost ? 42 : 0);

  const gapLines = [];
  const extraLines = [];
  let anyTargets = false;
  const dayCols = perDay.map((d) => {
    if (d.wins.length) anyTargets = true;
    const buckets = coverage(d.items.map((x) => x.s).filter((x) => x.status !== "sick_open"), d.day, startMin, endMin);
    const dayLabel = shown.length > 1 ? `${fmt(d.day, { weekday: "short", day: "numeric", month: "short" })} · ` : "";
    for (const g of shortages(buckets, d.wins)) gapLines.push(`${dayLabel}${fromMin(g.from)}–${fromMin(g.to)} · ${t("missingN")} ${g.missing} ${t("personsShort")}`);
    for (const g of surpluses(buckets, d.wins)) extraLines.push(`${dayLabel}${fromMin(g.from)}–${fromMin(g.to)} · ${g.missing} ${t("personsShort")} ${t("tooMany")}`);

    const cells = buckets.map((b) => {
      const tg = targetAt(d.wins, b.t);
      const cls = tg === undefined ? "none" : b.count < tg ? "short" : b.count === tg ? "ok" : "over";
      return h("div", { class: `vtl-cell ${cls}`, style: `top:${y(b.t)}px;height:${ph / 2}px`, title: `${fromMin(b.t)} — ${t("present")} ${b.count}${tg === undefined ? "" : ` / ${t("target")} ${tg}`}` },
        tg === undefined ? String(b.count) : `${b.count}/${tg}`);
    });

    const clipped = d.items.map((x) => ({ ...x, from: Math.max(x.span.s, startMin), to: Math.min(x.span.e, endMin) }));
    const lanes = assignLanes(clipped);
    const bars = clipped.map((x) => {
      const range = `${hhmm(x.s.start_at)}–${x.s.until_close ? "F" : hhmm(x.s.end_at)}`;
      const height = ((x.to - x.from) / 60) * ph;
      const wide = zoom || lanes <= 2 || (!desktop && lanes <= 3);
      const color = staffColor(x.s.staff_id, x.s.staff_color);
      const fill = x.s.until_close ? `linear-gradient(to bottom, ${color} 85%, color-mix(in srgb, ${color} 65%, black))` : color;
      const props = {
        class: `vtl-bar ${wide ? "" : "vertical"} ${x.s.status === "sick_open" ? "sick" : ""}`,
        title: `${shiftRoleIcons(x.s)} ${x.s.staff_name} · ${range} · ${shiftRoleLabel(x.s)}${x.s.status === "sick_open" ? ` · ${t("sickOpen")}` : ""}`,
        style: `top:${y(x.from)}px;height:${height}px;left:${(x.lane / lanes) * 100}%;width:${100 / lanes}%;background:${fill};color:${textOn(color)}`,
      };
      // Picture size follows the room available in this lane; skip it on very short bars.
      const size = Math.max(14, Math.min(zoom ? 44 : 30, Math.floor(laneArea / lanes) - 6));
      const pic = height >= size + 14 ? avatar(x.s.staff_id, x.s.staff_name, x.s.staff_color, x.s.photo_v, size) : null;
      // Role icon (plate = dishwasher, pizza = cook, car = delivery, knife = prep…); the full name is in the tooltip.
      const icon = h("span", { class: "role-icon", "aria-hidden": "true" }, shiftRoleIcons(x.s));
      const body = zoom
        ? [h("b", { class: "bar-name" }, pic, shortOf.get(x.s.staff_id), icon), `${range} · ${shiftRoleLabel(x.s)}`, x.s.notes ? h("em", {}, x.s.notes) : null]
        : wide
        ? [h("b", { class: "bar-name" }, pic, shortOf.get(x.s.staff_id), icon), range]
        : [pic, icon, h("span", { class: "bar-text" }, `${shortOf.get(x.s.staff_id)} ${range}`)];
      return data.editable ? h("button", { ...props, type: "button", onClick: () => openEditor(x.s) }, body) : h("div", props, body);
    });
    // Roles that arrive before opening (cook, waiter…): the closed hatching stops earlier and a lighter "setup" band marks that time.
    const lead = Math.max(0, ...state.roles.filter((r) => sel.departments.includes(r.department_id)).map((r) => r.pre_open_minutes || 0));
    const shade = (from, to, cls = "vtl-closed", title = t("beforeOpen")) => (to > from ? h("div", { class: cls, title, style: `top:${y(from)}px;height:${y(to) - y(from)}px` }) : null);
    const hourly = payroll && state.showHourlyCost && d.cost;
    const costCol = hourly
      ? h("div", { class: "vtl-costcol" }, Array.from({ length: hours }, (_, i) => {
          const c = d.cost.by_hour[(startMin / 60 + i) % 24];
          return h("div", { class: "vtl-costcell", style: `top:${i * ph}px;height:${ph}px`, title: `${(startMin / 60 + i) % 24}h` }, c > 0 ? money(c) : "");
        }))
      : null;
    return h("div", { class: `vtl-day ${hourly ? "with-cost" : ""}` }, shade(startMin, d.openMin - lead), shade(d.openMin - lead, d.openMin, "vtl-setup", t("setupTime")), shade(d.closeMin, endMin), h("div", { class: "vtl-cov" }, cells), costCol, h("div", { class: "vtl-lanes" }, bars));
  });

  const heads = perDay.map((d) => {
    const kids = [fmt(d.day, { weekday: "short" }), h("small", {}, fmt(d.day, { day: "numeric", month: "short" })),
      d.labels.length ? h("span", { class: "tag" }, d.labels.join(" · ")) : null,
      d.cost ? h("span", { class: "cost" }, money(d.cost.cents)) : null,
      // time off that day: C/D requested, C/A approved (first names, with the hours when only part of the day)
      ...(data.time_off ?? []).filter((o) => o.start_date <= d.day && o.end_date >= d.day).map((o) =>
        h("span", { class: `off-chip ${o.status}`, title: `${o.staff_name} — ${o.status === "approved" ? t("offApproved") : t("offRequested")}` },
          `${o.status === "approved" ? "C/A" : "C/D"} ${o.first_name || o.staff_name}${o.start_time ? ` ${o.start_time.slice(0, 5)}–${o.end_time.slice(0, 5)}` : ""}`))];
    const cls = `vtl-head ${d.day === today ? "today" : ""}`;
    // Week view on desktop: clicking a day header zooms into that day.
    return desktop && !zoom && shown.length > 1
      ? h("button", { class: `${cls} zoomable`, type: "button", title: t("zoomDay"), "aria-label": `${t("zoomDay")}: ${fmt(d.day, { weekday: "long", day: "numeric", month: "long" })}`,
          onClick: () => { state.zoomDay = d.day; sel.day = d.day; render(); } }, kids)
      : h("div", { class: cls }, kids);
  });
  const stepDay = (n) => {
    const nd = addDays(state.zoomDay, n);
    if (!days.includes(nd)) sel.week = mondayOf(parseYmd(nd));
    state.zoomDay = nd; sel.day = nd; render();
  };
  const zoomBar = zoom ? h("div", { class: "zoom-bar" },
    h("button", { class: "btn", type: "button", onClick: () => { state.zoomDay = null; render(); } }, `← ${t("backToWeek")}`),
    h("button", { class: "icon-btn", type: "button", "aria-label": t("prevDay"), onClick: () => stepDay(-1) }, "‹"),
    h("button", { class: "icon-btn", type: "button", "aria-label": t("nextDay"), onClick: () => stepDay(1) }, "›")) : null;
  const axis = h("div", { class: "vtl-axis" }, Array.from({ length: hours }, (_, i) =>
    h("div", { class: "vtl-hour", style: `top:${i * ph}px` }, `${(startMin / 60 + i) % 24}h`)));

  const gapBox = !anyTargets
    ? h("div", { class: "empty" }, t("noTargetsYet"))
    : gapLines.length
      ? h("div", { class: "alert", role: "status" }, h("strong", {}, t("shortagesTitle")), h("ul", {}, gapLines.map((l) => h("li", {}, l))))
      : h("div", { class: "okmsg" }, shown.length > 1 ? t("noShortagesWeek") : t("noShortages"));
  // Shown in addition to the shortage message: people above the target (labour cost with no need).
  const extraBox = anyTargets && extraLines.length
    ? h("div", { class: "info", role: "status" }, h("strong", {}, t("surplusTitle")), h("ul", {}, extraLines.map((l) => h("li", {}, l))))
    : null;

  const dayTabs = h("div", { class: "daytabs tl-days", role: "group" }, days.map((d) =>
    h("button", { type: "button", "aria-pressed": String(d === sel.day), onClick: () => { sel.day = d; render(); } },
      h("span", { class: "dow" }, fmt(d, { weekday: "short" })), h("span", { class: "dom" }, fmt(d, { day: "numeric" })))));

  // Summary only: hours and salary, one column per selected department plus a total column when several are shown.
  const payrollBox = payroll ? (() => {
    const cols = payroll.byDept ?? [{ dept: sel.departments[0], payroll }];
    const day = (p) => p.department.days.find((x) => x.date === sel.day);
    const cell = (cents, hrsN, strong) => h(strong ? "th" : "td", { class: "pay-num" }, h("b", {}, money(cents, true)), h("small", {}, `${hrs(hrsN)} ${t("hoursShort")}`));
    const rowsDef = [
      ...(shown.length === 1 ? [[t("costDay"), (p) => { const d = day(p); return [d?.cents ?? 0, d?.hours ?? 0]; }]] : []),
      [t("costWeek"), (p) => [p.department.total_cents, p.department.total_hours]],
    ];
    const unrated = cols.reduce((n, c) => n + (c.payroll.department.unrated_hours ?? 0), 0);
    return h("div", { class: "payroll" },
      h("table", { class: "pay-table" },
        h("thead", {}, h("tr", {}, h("th"), cols.map((c) => h("th", {}, t(`dept.${c.dept}`))), cols.length > 1 ? h("th", { class: "pay-total" }, t("total")) : null)),
        h("tbody", {}, rowsDef.map(([label, get]) => {
          const vals = cols.map((c) => get(c.payroll));
          const sum = vals.reduce((a, v) => [a[0] + v[0], a[1] + v[1]], [0, 0]);
          return h("tr", {}, h("th", { class: "pay-label" }, label), vals.map((v) => cell(v[0], v[1])), cols.length > 1 ? h("td", { class: "pay-num pay-total" }, h("b", {}, money(sum[0], true)), h("small", {}, `${hrs(sum[1])} ${t("hoursShort")}`)) : null);
        }))),
      unrated > 0 ? h("div", { class: "warn" }, `${hrs(unrated)} ${t("unratedHours")}`) : null,
      h("button", { class: "btn", type: "button", onClick: () => { state.showHourlyCost = !state.showHourlyCost; try { localStorage.setItem("hourlyCost", state.showHourlyCost ? "1" : "0"); } catch { /* ignore */ } render(); } },
        state.showHourlyCost ? t("hideHourlyCost") : t("showHourlyCost")));
  })() : null;

  return h("section", { class: "timeline" },
    h("h2", {}, shown.length > 1 ? t("coverageWeek") : `${t("coverage")} — ${fmt(shown[0], { weekday: "long", day: "numeric", month: "long" })}`),
    shown.length > 1 && desktop ? h("p", { class: "zoom-hint" }, `🔍 ${t("zoomHint")}`) : null,
    zoomBar,
    dayTabs,
    payrollBox,
    h("div", { class: "gaps" }, gapBox, extraBox),
    h("div", { class: "vtl-scroll" },
      h("div", { class: `vtl ${zoom ? "zoomed" : ""}`, style: `--cols:${shown.length};--hours:${hours};--ph:${ph}px;--colmin:${zoom ? 420 : desktop ? (payroll && state.showHourlyCost ? 160 : 118) : 240}px` },
        [h("div", { class: "vtl-corner" }), ...heads, axis, ...dayCols])),
    h("div", { class: "tl-legend" },
      h("span", {}, h("i", { style: "background:#86efac" }), t("legendOk")), h("span", {}, h("i", { style: "background:#fca5a5" }), t("legendShort")),
      h("span", {}, h("i", { style: "background:#93c5fd" }), t("legendOver")), h("span", {}, h("i", { style: "background:var(--line)" }), t("legendNone"))));
}

// ---------- shift editor ----------
function openShiftModal({ shift, prefill = {}, roster, data }) {
  const dlg = document.getElementById("modal");
  const sel = state.sel;
  const rolesById = new Map(state.roles.map((r) => [r.id, r]));
  const deptRoles = state.roles.filter((r) => sel.departments.includes(r.department_id));
  const initial = shift
    ? { staff_id: shift.staff_id, role_id: shift.role_id, date: dayOf(shift.start_at), start: hhmm(shift.start_at), end: hhmm(shift.end_at), notes: shift.notes ?? "", until_close: !!shift.until_close }
    : { staff_id: prefill.staff_id ?? roster[0]?.staff_id, role_id: null, date: prefill.date ?? sel.day, start: "11:00", end: "17:00", notes: "", until_close: false };

  const staffSel = h("select", { required: true }, roster.map((r) => h("option", { value: r.staff_id, selected: r.staff_id === initial.staff_id }, r.name)));
  const roleSel = h("select", { required: true });
  // "Also covers": other roles this person holds, checked when the same shift covers them too (e.g. cook + dishwasher).
  const alsoBox = h("div", { class: "also-roles" });
  let alsoChecked = new Set((shift?.extra_roles ?? []).map((r) => r.id));
  const drawAlso = () => {
    const person = roster.find((r) => r.staff_id === Number(staffSel.value));
    const main = Number(roleSel.value);
    const others = state.roles.filter((r) => (person?.all_role_ids ?? person?.role_ids ?? []).includes(r.id) && r.id !== main);
    alsoBox.replaceChildren(...(others.length ? [h("span", { class: "meta" }, t("alsoCovers"))] : []), ...others.map((r) =>
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: alsoChecked.has(r.id), onChange: (e) => { e.target.checked ? alsoChecked.add(r.id) : alsoChecked.delete(r.id); } }), `${roleIcon(r)} ${roleName(r, person?.sex)}`)));
  };
  const fillRoles = () => {
    const person = roster.find((r) => r.staff_id === Number(staffSel.value));
    const ids = person?.role_ids ?? [];
    const keep = Number(roleSel.value) || initial.role_id;
    roleSel.replaceChildren(...deptRoles.filter((r) => ids.includes(r.id)).map((r) =>
      h("option", { value: r.id, selected: r.id === keep }, roleName(r, person?.sex))));
    drawAlso();
  };
  roleSel.addEventListener("change", () => { alsoChecked.delete(Number(roleSel.value)); drawAlso(); });
  staffSel.addEventListener("change", () => { alsoChecked = new Set(); fillRoles(); applyPreOpen(); });
  fillRoles();
  const date = h("input", { type: "date", value: initial.date, required: true });
  const start = timeField(initial.start);
  const end = timeField(initial.end);
  const notes = h("textarea", { value: initial.notes, maxLength: 200 });
  const untilClose = h("input", { type: "checkbox", checked: initial.until_close });
  // New shifts start before opening for roles that must arrive early (cook, waiter: 30 min), unless the start was edited by hand.
  let startTouched = !!shift;
  start.addEventListener("change", () => { startTouched = true; });
  function applyPreOpen() {
    if (startTouched || !date.value) return;
    const role = state.roles.find((r) => r.id === Number(roleSel.value));
    if (!role?.pre_open_minutes) return;
    const dow = (parseYmd(date.value).getDay() + 6) % 7;
    const m = toMin(openOf(sel.restaurant, dow)) - role.pre_open_minutes;
    if (m >= 0) start.value = fromMin(m);
  }
  roleSel.addEventListener("change", applyPreOpen); date.addEventListener("change", applyPreOpen);
  applyPreOpen();
  const alertBox = h("div");
  const nextDay = h("span", { class: "meta" });
  const syncNext = () => {
    end.disabled = untilClose.checked;
    nextDay.textContent = !untilClose.checked && end.value && start.value && end.value <= start.value ? t("nextDay") : "";
  };
  start.addEventListener("input", syncNext); end.addEventListener("input", syncNext); untilClose.addEventListener("change", syncNext); syncNext();

  const payload = (force) => {
    const endTime = untilClose.checked ? closeOf(sel.restaurant, dowOf(date.value)) : end.value;
    const endDate = endTime <= start.value ? addDays(date.value, 1) : date.value;
    return {
      staff_id: Number(staffSel.value), restaurant_id: sel.restaurant, role_id: Number(roleSel.value),
      extra_role_ids: [...alsoChecked].filter((id) => id !== Number(roleSel.value)),
      start_at: `${date.value}T${start.value}`, end_at: `${endDate}T${endTime}`, until_close: untilClose.checked, notes: notes.value || undefined, force: force || undefined,
    };
  };
  const save = async (force) => {
    try {
      await api(shift ? `/shifts/${shift.id}` : "/shifts", { method: shift ? "PUT" : "POST", body: payload(force) });
      dlg.close(); toast(t("saved")); render();
    } catch (e) {
      if (e.body?.error === "overlap") {
        alertBox.replaceChildren(h("div", { class: "alert", role: "alert" }, h("strong", {}, t("overlapTitle")), h("div", {}, t("overlapBody")),
          h("ul", {}, e.body.conflicts.map((c) => h("li", {}, `${c.restaurant} · ${c.start_at.slice(0, 10)} ${hhmm(c.start_at)}–${hhmm(c.end_at)}`))),
          h("button", { class: "btn", type: "button", onClick: () => save(true) }, t("saveAnyway"))));
      } else if (e.body?.error === "unavailable") {
        const r = e.body.rule;
        alertBox.replaceChildren(h("div", { class: "alert", role: "alert" }, h("strong", {}, t("unavailableTitle")),
          h("div", {}, r.kind === "day_off" ? `${weekdayName(r.dow)} — ${t("fixedDayOff")}` : `${weekdayName(r.dow)} ${r.start_time}–${r.end_time}${r.note ? ` · ${r.note}` : ""}`),
          h("button", { class: "btn", type: "button", onClick: () => save(true) }, t("saveAnyway"))));
      } else if (e.body?.error === "max_hours") {
        alertBox.replaceChildren(h("div", { class: "alert", role: "alert" }, h("strong", {}, t("maxHoursTitle")),
          h("div", {}, `${t("maxShort")} ${hrs(e.body.max)} ${t("hoursShort")} — ${t("wouldBe")} ${hrs(e.body.would_be)} ${t("hoursShort")}`),
          h("button", { class: "btn", type: "button", onClick: () => save(true) }, t("saveAnyway"))));
      } else if (e.body?.error === "time_off") {
        const o = e.body.time_off;
        alertBox.replaceChildren(h("div", { class: "alert", role: "alert" }, h("strong", {}, t("timeOffTitle")),
          h("div", {}, `${o.status === "approved" ? t("offApproved") : t("offRequested")} : ${o.start_date} → ${o.end_date}${o.start_time ? ` (${o.start_time}–${o.end_time})` : ""}`),
          h("button", { class: "btn", type: "button", onClick: () => save(true) }, t("saveAnyway"))));
      } else alertBox.replaceChildren(h("div", { class: "alert", role: "alert" }, errorText(e)));
    }
  };
  const del = async () => {
    if (!confirm(t("confirmDelete"))) return;
    try { await api(`/shifts/${shift.id}`, { method: "DELETE" }); dlg.close(); render(); } catch (e) { alertBox.replaceChildren(h("div", { class: "alert" }, errorText(e))); }
  };

  // Sticky header: title and every button (the form fields scroll underneath). Save submits the form through the form= attribute.
  const actions = h("div", { class: "dlg-actions wrap" },
    shift && shift.status === "ok" && shift.end_at > nowLocal() ? h("button", { class: "btn sm", type: "button", title: t("reportSick"), onClick: async () => { if (confirm(t("confirmSickFor"))) { try { await api(`/shifts/${shift.id}/sick`, { method: "POST" }); dlg.close(); toast(t("sickStarted")); render(); } catch (e) { alertBox.replaceChildren(h("div", { class: "alert", role: "alert" }, errorText(e))); } } } }, `🤒 ${t("reportSick")}`) : null,
    shift && state.me.me.is_admin ? h("button", { class: "btn sm", type: "button", onClick: async () => {
      const list = await api("/admin/overview").then((o) => o.staff).catch(() => []);
      dlg.close(); incidentDialog({ staffList: list, staffId: shift.staff_id, date: dayOf(shift.start_at), shift });
    } }, t("recordIncident")) : null,
    shift ? h("button", { class: "btn sm danger", type: "button", onClick: del }, t("delete")) : null,
    h("button", { class: "btn sm", type: "button", onClick: () => dlg.close() }, t("cancel")),
    h("button", { class: "btn sm primary", type: "submit", form: "shift-form" }, t("save")));
  const form = h("form", { id: "shift-form", class: "modal-body shift-dialog", method: "dialog", onSubmit: (e) => { e.preventDefault(); save(false); } },
    h("div", { class: "dlg-top" }, h("div", { class: "dlg-head" }, h("h2", {}, shift ? t("editShift") : t("addShift")), actions), alertBox),
    h("label", { class: "field" }, h("span", {}, t("employee")), staffSel),
    h("label", { class: "field" }, h("span", {}, t("role")), roleSel), alsoBox,
    h("label", { class: "field" }, h("span", {}, t("date")), date),
    h("div", { class: "row2" }, h("label", { class: "field" }, h("span", {}, t("start")), start), h("label", { class: "field" }, h("span", {}, t("end")), end, nextDay)),
    h("label", { class: "check" }, untilClose, t("untilClose")),
    h("label", { class: "field" }, h("span", {}, t("notes")), notes));
  dlg.replaceChildren(form);
  dlg.showModal();
}

// ---------- my shifts ----------
// ---------- time off ----------
// Time off of one employee, inside the employee dialog: list with approve / decline / withdraw, and a quick "add leave".
function staffTimeOff(person) {
  const box = h("div", {});
  async function load() {
    const rows = await api(`/time-off/staff/${person.id}`);
    const today = ymd(new Date());
    const from = h("input", { type: "date", value: today }), to = h("input", { type: "date", value: today });
    const allDay = h("input", { type: "checkbox", checked: true });
    const ts = timeField("14:00"), te = timeField("21:00");
    const timeBox = h("div", { class: "inline-form", style: "grid-template-columns:1fr 1fr", hidden: true }, h("label", { class: "field" }, h("span", {}, t("start")), ts), h("label", { class: "field" }, h("span", {}, t("end")), te));
    allDay.addEventListener("change", () => { timeBox.hidden = allDay.checked; });
    const label = { requested: t("offRequested"), approved: t("offApproved"), denied: t("offDenied") };
    const dates = (r) => (r.start_date === r.end_date ? fmt(r.start_date, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : `${fmt(r.start_date, { day: "numeric", month: "short" })} → ${fmt(r.end_date, { day: "numeric", month: "short", year: "numeric" })}`) + (r.start_time ? ` · ${r.start_time}–${r.end_time}` : "");
    const act = async (fn) => { try { await fn(); load(); } catch (e) { toast(errorText(e)); } };
    box.replaceChildren(
      rows.length ? rows.map((r) => h("div", { class: "cov-row" },
        h("div", {}, h("span", { class: `off-chip ${r.status}` }, r.status === "approved" ? "C/A" : r.status === "denied" ? "✕" : "C/D"), ` ${dates(r)}`),
        h("div", { class: "meta" }, `${label[r.status] ?? r.status}${r.note ? ` · ${r.note}` : ""}${r.decision_note ? ` · ${r.decision_note}` : ""}`),
        h("div", { class: "actions" },
          r.status !== "approved" ? h("button", { class: "btn primary", type: "button", onClick: () => act(() => api(`/time-off/${r.id}/decide`, { method: "POST", body: { approve: true } })) }, t("approve")) : null,
          r.status !== "denied" ? h("button", { class: "btn", type: "button", onClick: () => act(() => api(`/time-off/${r.id}/decide`, { method: "POST", body: { approve: false } })) }, t("deny")) : null,
          h("button", { class: "btn danger", type: "button", onClick: () => { if (confirm(t("confirmCancelOff"))) act(() => api(`/time-off/${r.id}/withdraw`, { method: "POST" })); } }, t("delete")))))
        : h("p", { class: "meta" }, t("noTimeOff")),
      h("h4", {}, t("addLeaveFor")),
      h("div", { class: "inline-form", style: "grid-template-columns:1fr" },
        h("div", { class: "inline-form", style: "grid-template-columns:1fr 1fr" }, h("label", { class: "field" }, h("span", {}, t("fromDate")), from), h("label", { class: "field" }, h("span", {}, t("toDate")), to)),
        h("label", { class: "check" }, allDay, h("span", {}, t("allDay"))), timeBox,
        h("button", { class: "btn primary", type: "button", onClick: () => act(async () => {
          const body = { staff_id: person.id, start_date: from.value, end_date: to.value || from.value };
          if (!allDay.checked) { body.start_time = ts.value; body.end_time = te.value; }
          try { await api("/time-off", { method: "POST", body }); toast(t("saved")); }
          catch (e) { toast(e.body?.error === "already_requested" ? t("alreadyRequested") : errorText(e)); throw e; }
        }) }, t("add"))));
  }
  load().catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

// Weekly fixed day(s) off and recurring unavailable times (school, other job…), for one employee.
function availabilityEditor(staffId) {
  const box = h("div", { class: "availability" });
  async function load() {
    const rows = await api(`/availability?staff=${staffId}`);
    const dayOffs = new Map(rows.filter((r) => r.kind === "day_off").map((r) => [r.dow, r]));
    const days = h("div", { class: "seg", role: "group", "aria-label": t("fixedDaysOff") }, Array.from({ length: 7 }, (_, i) =>
      h("button", { type: "button", "aria-pressed": String(dayOffs.has(i)), onClick: async () => {
        try {
          if (dayOffs.has(i)) await api(`/availability/${dayOffs.get(i).id}`, { method: "DELETE" });
          else await api("/availability", { method: "POST", body: { staff_id: staffId, dow: i, kind: "day_off" } });
          load();
        } catch (e) { toast(errorText(e)); }
      } }, fmt(addDays("2026-10-26", i), { weekday: "short" }))));
    const dow = h("select", {}, Array.from({ length: 7 }, (_, i) => h("option", { value: i }, weekdayName(i))));
    const st = timeField("08:00"), en = timeField("15:30");
    const note = h("input", { maxLength: 120, placeholder: t("availabilityNote") });
    const vf = h("input", { type: "date" }), vt = h("input", { type: "date" });
    const list = rows.filter((r) => r.kind !== "day_off");
    box.replaceChildren(
      h("h4", {}, t("fixedDaysOff")), h("p", { class: "meta" }, t("fixedDaysOffHelp")), days,
      // On each fixed day off: can this person still be asked to cover a sick colleague that day?
      [...dayOffs.entries()].sort((a, b) => a[0] - b[0]).map(([i, r]) => h("label", { class: "check" },
        h("input", { type: "checkbox", checked: !!r.replacement_ok, onChange: async (e) => { try { await api(`/availability/${r.id}`, { method: "PUT", body: { replacement_ok: e.target.checked } }); toast(t("saved")); } catch (err) { e.target.checked = !e.target.checked; toast(errorText(err)); } } }),
        h("span", {}, `${weekdayName(i)} : ${t("replacementOk")}`))),
      h("h4", {}, t("unavailableTimes")), h("p", { class: "meta" }, t("unavailableHelp")),
      list.length ? h("div", { class: "log" }, list.map((r) => h("div", { class: "log-row" },
        h("span", {}, h("b", {}, weekdayName(r.dow)), ` ${r.start_time}–${r.end_time}${r.note ? ` · ${r.note}` : ""}`),
        r.valid_from || r.valid_to ? h("span", { class: "meta" }, `${r.valid_from ?? "…"} → ${r.valid_to ?? "…"}`) : null,
        h("button", { class: "btn danger", type: "button", onClick: async () => { await api(`/availability/${r.id}`, { method: "DELETE" }); load(); } }, t("delete"))))) : h("p", { class: "meta" }, t("noUnavailable")),
      h("div", { class: "inline-form", style: "grid-template-columns:1fr" },
        h("label", { class: "field" }, h("span", {}, t("weekday")), dow),
        h("div", { class: "inline-form", style: "grid-template-columns:1fr 1fr" }, h("label", { class: "field" }, h("span", {}, t("from")), st), h("label", { class: "field" }, h("span", {}, t("to")), en)),
        h("div", { class: "inline-form", style: "grid-template-columns:1fr 1fr" }, h("label", { class: "field" }, h("span", {}, t("validFrom")), vf), h("label", { class: "field" }, h("span", {}, t("validTo")), vt)),
        h("label", { class: "field" }, h("span", {}, t("note")), note),
        h("button", { class: "btn primary", type: "button", onClick: async () => {
          try { await api("/availability", { method: "POST", body: { staff_id: staffId, dow: Number(dow.value), start_time: st.value, end_time: en.value, note: note.value, valid_from: vf.value || undefined, valid_to: vt.value || undefined } }); load(); }
          catch (e) { toast(e.body?.error === "invalid_times" ? t("opensBeforeCloses") : errorText(e)); }
        } }, t("add"))));
  }
  load().catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

async function renderTimeOff() {
  const today = ymd(new Date());
  const [mine, review] = await Promise.all([api("/time-off/mine"), api("/time-off/review")]);
  const from = h("input", { type: "date", required: true, value: today });
  const to = h("input", { type: "date", value: today });
  from.addEventListener("change", () => { if (to.value < from.value) to.value = from.value; to.min = from.value; });
  to.min = today;
  const note = h("input", { maxLength: 300, placeholder: t("optional") });
  const statusText = { requested: t("offRequested"), approved: t("offApproved"), denied: t("offDenied") };
  const dates = (r) => (r.start_date === r.end_date ? fmt(r.start_date, { weekday: "short", day: "numeric", month: "short" }) : `${fmt(r.start_date, { day: "numeric", month: "short" })} → ${fmt(r.end_date, { day: "numeric", month: "short" })}`) + (r.start_time ? ` · ${r.start_time}–${r.end_time}` : "");
  // Managers and admins can also enter time off for an employee (approved at once).
  const people = state.me.me.is_admin || state.me.managed.length ? await api("/time-off/people").catch(() => []) : [];
  const forWho = people.length ? h("select", {}, h("option", { value: "" }, t("myself")), people.map((p) => h("option", { value: p.id }, p.name))) : null;
  const allDay = h("input", { type: "checkbox", checked: true });
  const tStart = timeField("14:00"), tEnd = timeField("21:00");
  const timeBox = h("div", { class: "inline-form", style: "grid-template-columns:1fr 1fr", hidden: true }, h("label", { class: "field" }, h("span", {}, t("start")), tStart), h("label", { class: "field" }, h("span", {}, t("end")), tEnd));
  allDay.addEventListener("change", () => { timeBox.hidden = allDay.checked; });
  const form = h("form", { class: "panel inline-form", style: "grid-template-columns:1fr", onSubmit: async (e) => {
    e.preventDefault();
    try {
      const body = { start_date: from.value, end_date: to.value || from.value, note: note.value };
      if (!allDay.checked) { body.start_time = tStart.value; body.end_time = tEnd.value; }
      if (forWho?.value) body.staff_id = Number(forWho.value);
      await api("/time-off", { method: "POST", body }); toast(forWho?.value ? t("saved") : t("requestSent")); render();
    } catch (err) { toast(err.body?.error === "already_requested" ? t("alreadyRequested") : err.body?.error === "invalid_times" ? t("opensBeforeCloses") : errorText(err)); }
  } }, h("h2", {}, t("requestTimeOff")),
    forWho ? h("label", { class: "field" }, h("span", {}, t("forEmployee")), forWho, h("span", { class: "meta" }, t("forEmployeeHelp"))) : null,
    h("label", { class: "field" }, h("span", {}, t("fromDate")), from), h("label", { class: "field" }, h("span", {}, t("toDate")), to),
    h("label", { class: "check" }, allDay, h("span", {}, t("allDay"))), timeBox,
    h("label", { class: "field" }, h("span", {}, t("note")), note), h("button", { class: "btn primary", type: "submit" }, t("sendRequest")));
  const myList = h("section", { class: "panel" }, h("h2", {}, t("myTimeOff")), mine.length ? mine.map((r) =>
    h("div", { class: "cov-row" }, h("div", {}, h("span", { class: `off-chip ${r.status}` }, r.status === "approved" ? "C/A" : r.status === "denied" ? "✕" : "C/D"), ` ${dates(r)}`),
      h("div", { class: "meta" }, `${statusText[r.status] ?? r.status}${r.note ? ` · ${r.note}` : ""}${r.decision_note ? ` · ${r.decision_note}` : ""}`),
      r.status === "requested" || r.status === "approved" ? h("button", { class: "btn", type: "button", onClick: async () => { if (confirm(t("confirmCancelOff"))) { await api(`/time-off/${r.id}/cancel`, { method: "POST" }); render(); } } }, t("cancel")) : null))
    : h("p", { class: "meta" }, t("noTimeOff")));
  const decide = async (r, approve) => {
    const dn = prompt(t("decisionNote")) ?? "";
    try {
      const res = await api(`/time-off/${r.id}/decide`, { method: "POST", body: { approve, note: dn } });
      toast(res.shifts_on_those_days ? `${t("saved")} — ⚠ ${res.shifts_on_those_days} ${t("shiftsOnThoseDays")}` : t("saved")); render();
    } catch (e) { toast(errorText(e)); }
  };
  const reviewBox = review.length || state.me.managed.length || state.me.me.is_admin ? h("section", { class: "panel" }, h("h2", {}, t("timeOffToReview")),
    review.length ? review.map((r) => h("div", { class: "cov-row" }, h("div", {}, h("b", {}, r.staff_name), ` · ${dates(r)}`),
      h("div", { class: "meta" }, `${statusText[r.status] ?? r.status}${r.note ? ` · ${r.note}` : ""}`),
      h("div", { class: "actions" },
        r.status !== "approved" ? h("button", { class: "btn primary", type: "button", onClick: () => decide(r, true) }, t("approve")) : null,
        r.status !== "denied" ? h("button", { class: "btn danger", type: "button", onClick: () => decide(r, false) }, t("deny")) : null)))
    : h("p", { class: "meta" }, t("nothingToReview"))) : null;
  $app.replaceChildren(h("div", { class: "account" }, form, myList, reviewBox));
}

async function renderAccount() {
  const acc = await api("/account");
  const phone = h("input", { type: "tel", value: acc.phone ?? "", autocomplete: "tel" });
  const sex = h("select", {}, [["", t("sexUnspecified")], ["M", t("sexMale")], ["F", t("sexFemale")]].map(([v, l]) => h("option", { value: v, selected: (s.sex ?? "") === v }, l)));
  const lang = h("select", {}, ["fr", "en"].map((l) => h("option", { value: l, selected: acc.lang === l }, l === "fr" ? "Français" : "English")));
  const channel = h("select", {}, [["sms", t("sms")], ["email", t("emailCh")]].map(([v, l]) => h("option", { value: v, selected: acc.notify_channel === v }, l)));
  const save = async (e) => {
    e.preventDefault();
    try { await api("/account", { method: "PUT", body: { phone: phone.value, lang: lang.value, notify_channel: channel.value } }); toast(t("saved")); }
    catch (err) { toast(err.body?.error === "invalid_phone" ? t("invalidPhone") : errorText(err)); }
  };
  const calBox = h("div", {});
  const drawCal = (url) => {
    const host = url ? url.replace(/^https?:\/\//, "") : "";
    calBox.replaceChildren(...(url ? [
      h("input", { readonly: true, value: url, onClick: (e) => e.target.select(), "aria-label": t("calendarLink") }),
      h("div", { class: "actions" },
        h("a", { class: "btn primary", target: "_blank", rel: "noopener", href: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(`webcal://${host}`)}` }, t("addToGoogle")),
        h("button", { class: "btn", type: "button", onClick: async () => { try { await navigator.clipboard.writeText(url); toast(t("copied")); } catch { toast(url); } } }, t("copyLink")),
        h("button", { class: "btn", type: "button", onClick: async () => { if (confirm(t("confirmNewLink"))) drawCal((await api("/account/calendar-token", { method: "POST" })).calendar_url); } }, t("newLink")),
        h("button", { class: "btn danger", type: "button", onClick: async () => { await api("/account/calendar-token", { method: "DELETE" }); drawCal(null); } }, t("stopSharing"))),
    ] : [h("button", { class: "btn primary", type: "button", onClick: async () => drawCal((await api("/account/calendar-token", { method: "POST" })).calendar_url) }, t("createLink"))]));
  };
  drawCal(acc.calendar_url);
  const slipsBox = h("div", {}, h("p", { class: "meta" }, t("loading")));
  api("/payslips").then((rows) => slipsBox.replaceChildren(rows.length ? h("div", { class: "log" }, rows.map((r) =>
    h("a", { class: "log-row slip-link", href: `/api/payslips/${r.id}/pdf`, target: "_blank", rel: "noopener" }, h("span", {}, r.pay_date ?? r.filename), h("span", { class: "meta" }, `${r.period_label ?? ""} · PDF`)))) : h("p", { class: "meta" }, t("noPayslips"))))
    .catch(() => slipsBox.replaceChildren(h("p", { class: "meta" }, t("genericError"))));
  $app.replaceChildren(h("div", { class: "account" },
    h("h2", {}, t("account")),
    h("section", { class: "panel" }, h("h3", {}, acc.name), h("p", { class: "meta" }, `${t("loginAs")} ${acc.email ?? "—"}`),
      h("form", { class: "inline-form", style: "grid-template-columns:1fr", onSubmit: save },
        h("label", { class: "field" }, h("span", {}, t("phone")), phone, h("span", { class: "meta" }, t("phoneHelp"))),
        h("label", { class: "field" }, h("span", {}, t("language")), lang),
        h("label", { class: "field" }, h("span", {}, t("notifyBy")), channel),
        h("button", { class: "btn primary", type: "submit" }, t("save")))),
    h("section", { class: "panel" }, h("h3", {}, t("calendarTitle")), h("p", { class: "meta" }, t("calendarHelp")), calBox),
    h("section", { class: "panel" }, h("h3", {}, t("myAvailability")), availabilityEditor(state.me.me.id)),
    h("section", { class: "panel" }, h("h3", {}, t("myPayslips")), slipsBox),
    h("section", { class: "panel" }, h("h3", {}, t("passwordTitle")), h("p", { class: "meta" }, t("passwordHelp")))));
}

async function renderMine() {
  const sel = state.sel;
  const data = await api(`/my-shifts?week=${sel.week}`);
  const nav = h("div", { class: "weeknav", style: "margin-bottom:1rem" },
    h("button", { class: "icon-btn", type: "button", "aria-label": t("prev"), onClick: () => { sel.week = addDays(sel.week, -7); render(); } }, "‹"),
    h("div", { class: "label" }, weekLabel(sel.week)),
    h("button", { class: "icon-btn", type: "button", "aria-label": t("next"), onClick: () => { sel.week = addDays(sel.week, 7); render(); } }, "›"));
  const myHours = h("div", { class: `payroll ${data.total_hours > (data.limits?.overtime_hours ?? 40) ? "over" : ""}` },
    h("div", { class: "row" }, h("span", {}, t("myWeekHours")), h("b", {}, `${hrs(data.total_hours)} ${t("hoursShort")}${data.total_hours > (data.limits?.overtime_hours ?? 40) ? " ⚠" : ""}`)));
  const days = Array.from({ length: 7 }, (_, i) => addDays(sel.week, i)).filter((d) => data.shifts.some((s) => dayOf(s.start_at) === d));
  const body = days.length
    ? days.map((d) => h("section", {}, h("h2", {}, fmt(d, { weekday: "long", day: "numeric", month: "long" })),
        h("div", { class: "list", style: "margin-bottom:1rem" }, data.shifts.filter((s) => dayOf(s.start_at) === d).map((s) =>
          h("div", { class: "card" }, h("span", { class: "time" }, range(s)),
            h("span", { class: "who" }, `${s.restaurant} · ${t(`dept.${s.department_id}`)}`),
            h("span", { class: "meta" }, [roleName(s), s.notes].filter(Boolean).join(" · ")), s.status === "sick_open" ? h("span", { class: "sick-badge" }, `🤒 ${t("sickOpen")}`) : null,
            s.status === "ok" && s.end_at > nowLocal() ? h("button", { class: "btn sick-btn", type: "button", onClick: async () => {
              if (!confirm(t("confirmSick"))) return;
              try { await api(`/shifts/${s.id}/sick`, { method: "POST" }); toast(t("sickStarted")); render(); } catch (e) { toast(e.body?.error === "already_sick" ? t("alreadySick") : errorText(e)); }
            } }, `🤒 ${t("imSick")}`) : null)))))
    : [h("div", { class: "empty" }, t("noShiftsWeek"))];
  $app.replaceChildren(nav, myHours, ...body);
}

// ---------- admin ----------
// ---------- Attendance incidents (admin only): no call / no show, late arrival, early departure not granted ----------
const INCIDENT_KINDS = ["no_call_no_show", "late_arrival", "early_departure"];
const incidentLabel = (k) => t(`inc.${k}`);

// Small form, used from the Incidents screen and from the shift editor (prefilled with the shift).
function incidentDialog({ staffList, staffId, date, shift, onSaved }) {
  const dlg = document.getElementById("modal");
  const who = h("select", { required: true }, staffList.map((s) => h("option", { value: s.id, selected: s.id === staffId }, s.name)));
  const day = h("input", { type: "date", required: true, value: date ?? ymd(new Date()) });
  const kind = h("select", {}, INCIDENT_KINDS.map((k) => h("option", { value: k }, incidentLabel(k))));
  const minutes = h("input", { type: "number", min: 1, max: 1440, inputMode: "numeric", placeholder: t("minutes") });
  const notes = h("textarea", { rows: 3, maxLength: 1000, placeholder: t("incidentNotes") });
  const shiftSel = h("select", {}, h("option", { value: "" }, t("noShiftLink")));
  const minField = h("label", { class: "field" }, h("span", {}, t("minutes")), minutes);
  const sync = () => { minField.hidden = kind.value === "no_call_no_show"; };
  kind.addEventListener("change", sync); sync();
  const loadShifts = async () => {
    shiftSel.replaceChildren(h("option", { value: "" }, t("noShiftLink")));
    if (!who.value || !day.value) return;
    try { for (const sh of await api(`/admin/staff/${who.value}/shifts?date=${day.value}`)) shiftSel.append(h("option", { value: sh.id, selected: shift?.id === sh.id }, `${hhmm(sh.start_at)}–${sh.until_close ? "F" : hhmm(sh.end_at)} · ${sh.restaurant} · ${roleName(sh)}`)); } catch { /* optional */ }
  };
  who.addEventListener("change", loadShifts); day.addEventListener("change", loadShifts); loadShifts();
  if (shift) kind.value = "no_call_no_show", sync();
  const alertBox = h("div", {});
  dlg.replaceChildren(h("form", { class: "modal-body", onSubmit: async (e) => {
    e.preventDefault();
    try {
      await api("/admin/incidents", { method: "POST", body: { staff_id: Number(who.value), incident_date: day.value, kind: kind.value, minutes: kind.value === "no_call_no_show" || !minutes.value ? null : Number(minutes.value), shift_id: shiftSel.value ? Number(shiftSel.value) : null, notes: notes.value } });
      dlg.close(); toast(t("saved")); onSaved?.();
    } catch (err) { alertBox.replaceChildren(h("div", { class: "alert", role: "alert" }, errorText(err))); }
  } }, h("h2", {}, t("recordIncident")),
    h("label", { class: "field" }, h("span", {}, t("employee")), who), h("label", { class: "field" }, h("span", {}, t("date")), day),
    h("label", { class: "field" }, h("span", {}, t("incidentType")), kind), minField,
    h("label", { class: "field" }, h("span", {}, t("linkedShift")), shiftSel), h("label", { class: "field" }, h("span", {}, t("notes")), notes), alertBox,
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: () => dlg.close() }, t("cancel")), h("button", { class: "btn primary", type: "submit" }, t("save")))));
  dlg.showModal();
}

function incidentsPanel(ov) {
  const box = h("section", { class: "panel" });
  const st = { staff: "" };
  async function load() {
    const data = await api(`/admin/incidents${st.staff ? `?staff=${st.staff}` : ""}`);
    const filter = h("select", { onChange: (e) => { st.staff = e.target.value; load(); } }, h("option", { value: "" }, t("everyone")), ov.staff.map((s) => h("option", { value: s.id, selected: String(s.id) === String(st.staff) }, s.name)));
    box.replaceChildren(
      h("h2", {}, t("adminIncidents")), h("p", { class: "meta" }, t("incidentsHelp")),
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onClick: () => incidentDialog({ staffList: ov.staff, onSaved: load }) }, `+ ${t("recordIncident")}`)),
      data.last_12_months.length ? h("details", { open: true }, h("summary", {}, t("last12Months")),
        h("div", { class: "log" }, data.last_12_months.map((r) => h("div", { class: "log-row" }, h("b", {}, r.staff_name),
          h("span", { class: "meta" }, `${r.no_shows} ${t("inc.no_call_no_show").toLowerCase()} · ${r.lates} ${t("inc.late_arrival").toLowerCase()} · ${r.early} ${t("inc.early_departure").toLowerCase()}`))))) : null,
      h("label", { class: "field" }, h("span", {}, t("employee")), filter),
      data.incidents.length ? h("div", { class: "log" }, data.incidents.map((i) => h("div", { class: "log-row inc" },
        h("div", {}, h("b", {}, i.staff_name), ` · ${fmt(i.incident_date, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}`),
        h("div", {}, h("span", { class: `badge inc-${i.kind}` }, incidentLabel(i.kind)), i.minutes ? ` ${i.minutes} min` : "", i.restaurant ? ` · ${i.restaurant}` : ""),
        i.notes ? h("div", { class: "meta" }, i.notes) : null,
        h("div", { class: "meta" }, `${t("recordedBy")} ${i.recorded_by_name ?? "—"}`),
        h("button", { class: "btn danger", type: "button", onClick: async () => { if (confirm(t("confirmDeleteIncident"))) { await api(`/admin/incidents/${i.id}`, { method: "DELETE" }); load(); } } }, t("delete"))))) : h("div", { class: "empty" }, t("noIncidents")));
  }
  load().catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

// ---------- Administration: messaging connections, replacement settings, message log ----------
function messagingPanel() {
  const box = h("section", { class: "panel" });
  async function load() {
    const c = await api("/connections");
    const sid = h("input", { placeholder: "ACxxxxxxxx…", autocomplete: "off" });
    const token = h("input", { type: "password", placeholder: c.sms.configured ? t("keepSaved") : "", autocomplete: "new-password" });
    const from = h("input", { type: "tel", value: c.sms.from ?? "", placeholder: "+18195551234" });
    const host = h("input", { value: c.email.host ?? "", placeholder: "smtp.gmail.com" });
    const port = h("input", { type: "number", value: c.email.port ?? "", placeholder: "465" });
    const secure = h("select", {}, [["implicit", "SSL/TLS (465)"], ["starttls", "STARTTLS (587)"], ["none", t("noEncryption")]].map(([v, l]) => h("option", { value: v, selected: (c.email.secure ?? "implicit") === v }, l)));
    const user = h("input", { value: c.email.user ?? "", autocomplete: "off" });
    const pass = h("input", { type: "password", placeholder: c.email.configured ? t("keepSaved") : "", autocomplete: "new-password" });
    const mailFrom = h("input", { type: "email", value: c.email.from ?? "", placeholder: "horaire@example.com" });
    const saveSms = async (e) => { e.preventDefault(); try { await api("/connections", { method: "PUT", body: { twilio: { sid: sid.value.trim() || undefined, token: token.value || undefined, from: from.value.trim() || undefined } } }); toast(t("saved")); load(); } catch (err) { toast(errorText(err)); } };
    const saveMail = async (e) => { e.preventDefault(); try { await api("/connections", { method: "PUT", body: { smtp: { host: host.value.trim() || undefined, port: port.value ? Number(port.value) : undefined, secure: secure.value, user: user.value, pass: pass.value || undefined, from: mailFrom.value.trim() || undefined } } }); toast(t("saved")); load(); } catch (err) { toast(errorText(err)); } };
    const testTo = h("input", { placeholder: t("testTo") });
    const test = async (channel) => { try { const r = await api("/connections/test", { method: "POST", body: { channel, to: testTo.value } }); toast(r.ok ? t("testSent") : `${t("testFailed")}: ${r.error ?? ""}`); } catch (err) { toast(errorText(err)); } };
    const badge = (ok) => h("span", { class: `badge ${ok ? "edit" : ""}` }, ok ? t("connected") : t("notConnected"));
    box.replaceChildren(
      h("h2", {}, t("adminMessaging")), h("p", { class: "meta" }, t("messagingHelp")),
      h("h3", {}, "SMS (Twilio) ", badge(c.sms.configured)),
      h("form", { class: "inline-form", style: "grid-template-columns:1fr", onSubmit: saveSms },
        h("label", { class: "field" }, h("span", {}, "Account SID"), sid, c.sms.sid_hint ? h("span", { class: "meta" }, `${t("saved")}: ${c.sms.sid_hint}`) : null),
        h("label", { class: "field" }, h("span", {}, "Auth Token"), token),
        h("label", { class: "field" }, h("span", {}, t("twilioFrom")), from),
        h("button", { class: "btn primary", type: "submit" }, t("save"))),
      h("p", { class: "meta" }, `${t("twilioWebhook")}: ${(c.app_url ?? location.origin)}/hooks/twilio`),
      h("h3", {}, `${t("emailCh")} (SMTP) `, badge(c.email.configured)),
      h("p", { class: "meta" }, t("gmailHelp")),
      h("form", { class: "inline-form", style: "grid-template-columns:1fr", onSubmit: saveMail },
        h("label", { class: "field" }, h("span", {}, t("smtpServer")), host), h("label", { class: "field" }, h("span", {}, "Port"), port),
        h("label", { class: "field" }, h("span", {}, t("smtpSecurity")), secure), h("label", { class: "field" }, h("span", {}, t("smtpUser")), user),
        h("label", { class: "field" }, h("span", {}, t("smtpPass")), pass), h("label", { class: "field" }, h("span", {}, t("smtpFrom")), mailFrom),
        h("button", { class: "btn primary", type: "submit" }, t("save"))),
      h("h3", {}, t("sendTest")),
      h("div", { class: "inline-form", style: "grid-template-columns:1fr" }, h("label", { class: "field" }, h("span", {}, t("testTo")), testTo),
        h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: () => test("sms") }, t("testSms")), h("button", { class: "btn", type: "button", onClick: () => test("email") }, t("testEmail")))));
  }
  load().catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

function settingsPanel() {
  const box = h("section", { class: "panel" });
  async function load() {
    const st = await api("/settings");
    const ot = h("input", { type: "number", min: 1, max: 168, value: st.overtime_hours });
    const to = h("input", { type: "number", min: 1, max: 1440, value: st.sick_timeout_minutes });
    const allow = h("input", { type: "checkbox", checked: !!st.replacement_allow_overtime });
    box.replaceChildren(h("h2", {}, t("sickSettings")),
      h("form", { class: "inline-form", style: "grid-template-columns:1fr", onSubmit: async (e) => {
        e.preventDefault();
        try { await api("/settings", { method: "PUT", body: { overtime_hours: Number(ot.value), sick_timeout_minutes: Number(to.value), replacement_allow_overtime: allow.checked } }); toast(t("saved")); } catch (err) { toast(errorText(err)); }
      } },
        h("label", { class: "field" }, h("span", {}, t("overtimeHours")), ot),
        h("label", { class: "field" }, h("span", {}, t("sickTimeout")), to, h("span", { class: "meta" }, t("sickTimeoutHelp"))),
        h("label", { class: "check" }, allow, h("span", {}, t("allowOvertimeReplacement"))),
        h("button", { class: "btn primary", type: "submit" }, t("save"))));
  }
  load().catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

function messageLogPanel() {
  const box = h("section", { class: "panel" });
  api("/admin/notifications").then((rows) => {
    box.replaceChildren(h("h2", {}, t("messageLog")), rows.length ? h("div", { class: "log" }, rows.map((r) =>
      h("div", { class: "log-row" }, h("span", { class: "meta" }, `${new Date(r.created_at).toLocaleString(locale())} · ${r.channel.toUpperCase()} · ${r.kind}`),
        h("span", {}, `${r.staff_name ?? r.to_addr} — ${r.status}${r.error ? ` (${r.error})` : ""}`)))) : h("div", { class: "empty" }, t("noMessages")));
  }).catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

// ---------- Administration: pay slips (batch upload, AI reading, confirmation) ----------
function payslipsAdminPanel(ov) {
  const box = h("section", { class: "panel" });
  const status = h("p", { class: "meta", role: "status" });
  async function load() {
    const [setup, rows] = await Promise.all([api("/admin/payslip-setup"), api("/admin/payslips")]);
    // Upload the files one after the other (each is read by the AI on arrival). Used by the picker and by drag and drop.
    const upload = async (list) => {
      list = [...list].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
      if (!list.length) { toast(t("notPdf")); return; }
      let done = 0;
      for (const f of list) {
        status.textContent = `${t("uploading")} ${done + 1}/${list.length} — ${f.name}`;
        try {
          const res = await fetch("/api/admin/payslips", { method: "POST", headers: { "content-type": "application/pdf", "X-Filename": encodeURIComponent(f.name) }, body: f });
          if (!res.ok) { const b = await res.json().catch(() => ({})); toast(`${f.name}: ${b.error === "file_too_large" ? t("fileTooLarge") : b.error === "not_a_pdf" ? t("notPdf") : t("genericError")}`); }
        } catch { toast(`${f.name}: ${t("genericError")}`); }
        done++;
      }
      status.textContent = ""; load();
    };
    const files = h("input", { type: "file", accept: "application/pdf", multiple: true, hidden: true, onChange: () => { const l = [...files.files]; files.value = ""; upload(l); } });
    const drop = h("div", { class: "dropzone", tabindex: 0, role: "button", "aria-label": t("uploadPayslips"),
      onClick: () => files.click(), onKeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); files.click(); } },
      onDragover: (e) => { e.preventDefault(); drop.classList.add("over"); }, onDragleave: () => drop.classList.remove("over"),
      onDrop: (e) => { e.preventDefault(); drop.classList.remove("over"); upload(e.dataTransfer.files); } },
      h("div", { class: "dz-icon" }, "📄"), h("b", {}, t("dropHere")), h("span", { class: "meta" }, t("orClick")), files);
    const key = h("input", { type: "password", placeholder: setup.ai_configured ? t("keepSaved") : "sk-ant-…", autocomplete: "new-password" });
    const staffOpts = (sel) => [h("option", { value: "" }, t("chooseEmployee")), ...ov.staff.map((s) => h("option", { value: s.id, selected: s.id === sel }, s.name))];
    const rowsUi = rows.map((r) => {
      const pick = h("select", {}, staffOpts(r.suggested_staff_id));
      const sinOk = r.match_kind === "sin";
      return h("div", { class: `slip ${sinOk ? "sure" : "check"}` },
        h("div", {}, h("a", { href: `/api/admin/payslips/${r.id}/pdf`, target: "_blank", rel: "noopener" }, r.filename),
          h("div", { class: "meta" }, [r.period_label, r.pay_date, `${Math.round(r.size / 1024)} KB`].filter(Boolean).join(" · "))),
        h("div", { class: "meta" }, `${t("readName")}: ${r.extracted_name ?? "—"}${r.extracted_last3 ? ` · SIN …${r.extracted_last3}` : ""}`),
        h("div", { class: sinOk ? "ok-line" : "warn" }, sinOk ? `✔ ${t("matchedBySin")} (${r.suggested_name}, …${r.suggested_last3})` : r.match_kind === "name" ? `⚠ ${t("matchedByName")}` : `⚠ ${t("noMatch")}`),
        h("div", { class: "actions" }, pick,
          h("button", { class: "btn primary", type: "button", onClick: async () => { if (!pick.value) return toast(t("chooseEmployee")); try { await api(`/admin/payslips/${r.id}/assign`, { method: "POST", body: { staff_id: Number(pick.value) } }); load(); } catch (e) { toast(errorText(e)); } } }, t("confirm")),
          h("button", { class: "btn danger", type: "button", onClick: async () => { if (confirm(t("confirmDeleteSlip"))) { await api(`/admin/payslips/${r.id}`, { method: "DELETE" }); load(); } } }, t("delete"))));
    });
    const sure = rows.filter((r) => r.match_kind === "sin");
    box.replaceChildren(
      h("h2", {}, t("adminPayslips")), h("p", { class: "meta" }, t("payslipsHelp")),
      h("p", {}, h("span", { class: `badge ${setup.ai_configured ? "edit" : ""}` }, setup.ai_configured ? t("aiReady") : t("aiMissing"))),
      h("form", { class: "inline-form", style: "grid-template-columns:1fr", onSubmit: async (e) => { e.preventDefault(); try { await api("/admin/payslip-setup", { method: "PUT", body: { anthropic_key: key.value || null } }); toast(t("saved")); load(); } catch (err) { toast(err.body?.error === "invalid_key" ? t("genericError") : errorText(err)); } } },
        h("label", { class: "field" }, h("span", {}, t("anthropicKey")), key, h("span", { class: "meta" }, t("anthropicHelp"))), h("button", { class: "btn", type: "submit" }, t("save"))),
      h("h3", {}, t("uploadPayslips")), drop, h("p", { class: "meta" }, t("payslipLimit")), status,
      sure.length > 1 ? h("button", { class: "btn primary", type: "button", onClick: async () => { for (const r of sure) await api(`/admin/payslips/${r.id}/assign`, { method: "POST", body: { staff_id: r.suggested_staff_id } }).catch(() => {}); load(); } }, `${t("confirmAllSin")} (${sure.length})`) : null,
      h("h3", {}, `${t("toConfirm")} (${rows.length})`), rows.length ? rowsUi : h("div", { class: "empty" }, t("nothingToConfirm")));
  }
  load().catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

const ADMIN_SECTIONS_MARK = 0;
const ADMIN_SECTIONS = [["restaurants", "adminRestaurants"], ["targets", "adminTargets"], ["staff", "adminStaff"], ["messaging", "adminMessaging"], ["payslips", "adminPayslips"], ["incidents", "adminIncidents"]];
state.adminSection = "restaurants";

async function renderAdmin() {
  const ov = await api("/admin/overview");

  const restaurantsPanel = h("section", { class: "panel" }, h("h2", {}, t("restaurants")),
    h("p", {}, ov.restaurants.map((r) => h("span", { class: "badge", style: "margin-right:.4rem" }, r.name))),
    (() => {
      const name = h("input", { required: true, maxLength: 80 });
      return h("form", { class: "inline-form", onSubmit: async (e) => {
        e.preventDefault();
        try { await api("/restaurants", { method: "POST", body: { name: name.value } }); state.restaurants = await api("/restaurants"); render(); } catch (err) { toast(errorText(err)); }
      } }, h("label", { class: "field" }, h("span", {}, t("addRestaurant")), name), h("span"), h("button", { class: "btn primary", type: "submit" }, t("add")));
    })());

  const addStaff = (() => {
    const first = h("input", { required: true, maxLength: 80, autocomplete: "off" });
    const last = h("input", { maxLength: 80, autocomplete: "off" });
    const email = h("input", { type: "email" });
    return h("form", { class: "inline-form", onSubmit: async (e) => {
      e.preventDefault();
      try { await api("/staff", { method: "POST", body: { first_name: first.value, last_name: last.value, email: email.value || undefined } }); render(); } catch (err) { toast(errorText(err)); }
    } }, h("label", { class: "field" }, h("span", {}, t("firstName")), first), h("label", { class: "field" }, h("span", {}, t("lastName")), last), h("label", { class: "field" }, h("span", {}, t("email")), email),
    h("button", { class: "btn primary", type: "submit" }, t("add")));
  })();
  const staffPanel = h("section", { class: "panel" }, h("h2", {}, t("staff")), addStaff);
  const staffList = ov.staff.length ? ov.staff.map((s) => staffCard(s, ov)) : [h("div", { class: "empty" }, t("noStaff"))];
  const inactiveCount = ov.staff.filter((s) => s.active === false).length;
  const showInactive = inactiveCount ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!state.showInactive, onChange: (e) => { state.showInactive = e.target.checked; render(); } }), h("span", {}, `${t("showInactive")} (${inactiveCount})`)) : null;

  const sections = {
    restaurants: () => [restaurantsPanel, hoursPanel(ov), periodsPanel(ov), preOpenPanel(), defaultRatesPanel(ov)],
    targets: () => [weeklyTargetsPanel(ov), targetsPanel(ov)],
    staff: () => [staffPanel, showInactive, h("div", { class: state.showInactive ? "" : "hide-inactive" }, staffList)],
    messaging: () => [messagingPanel(), settingsPanel(), messageLogPanel()],
    payslips: () => [payslipsAdminPanel(ov)],
    incidents: () => [incidentsPanel(ov)],
  };
  const nav = h("nav", { class: "admin-nav", "aria-label": t("admin") }, ADMIN_SECTIONS.map(([id, label]) =>
    h("button", { type: "button", "aria-current": state.adminSection === id ? "page" : false, onClick: () => { state.adminSection = id; render(); } }, t(label))));
  $app.replaceChildren(h("div", { class: "admin-layout" }, nav, h("div", { class: "admin-content" }, sections[state.adminSection]())));
}

// ---- seasons / special days ----
const monthName = (m) => new Intl.DateTimeFormat(locale(), { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, m - 1, 1)));
const weekdayName = (i) => fmt(addDays("2026-10-26", i), { weekday: "long" });
const dayMonth = (md) => `${Number(md.slice(3, 5))} ${monthName(Number(md.slice(0, 2)))}`;

function describeRule(r) {
  switch (r.type) {
    case "range": return `${dayMonth(r.from)} → ${dayMonth(r.to)}, ${t("everyYear")}`;
    case "date": return fmt(r.date, { day: "numeric", month: "long", year: "numeric" });
    case "fixed": return `${dayMonth(r.md)}${r.days > 1 ? ` (+${r.days - 1})` : ""}, ${t("everyYear")}`;
    case "nth": return `${r.n === -1 ? t("last") : getLang() === "fr" ? (r.n === 1 ? "1er" : `${r.n}e`) : r.n} ${weekdayName(r.weekday)} · ${monthName(r.month)}, ${t("everyYear")}`;
    case "easter": return r.from === -2 && r.to === 1 ? t("easterRange") : `${t("ruleEaster")} ${r.from > 0 ? "+" : ""}${r.from} → ${r.to > 0 ? "+" : ""}${r.to}`;
    default: return "";
  }
}

// Create / edit a season or special day. Calls onSaved() after the API accepted it.
function periodDialog({ restaurantId, kind, set, onSaved }) {
  const dlg = document.getElementById("modal");
  const presets = kind === "season" ? SEASON_PRESETS : SPECIAL_PRESETS;
  const presetName = (p) => (getLang() === "fr" ? p.fr : p.en);
  const name = h("input", { maxLength: 80, value: set?.name ?? "" });
  const rule0 = set?.rule ?? (kind === "season" ? { type: "range", from: "06-21", to: "09-22" } : { type: "fixed", md: "12-25", days: 1 });
  const num = (v, min, max) => h("input", { type: "number", min, max, value: v, inputMode: "numeric" });
  const mdPick = (md) => {
    const m = h("select", {}, Array.from({ length: 12 }, (_, i) => h("option", { value: i + 1, selected: i + 1 === Number(md.slice(0, 2)) }, monthName(i + 1))));
    const d = num(Number(md.slice(3, 5)), 1, 31);
    return { m, d, node: h("div", { class: "row2" }, m, d), get: () => `${String(m.value).padStart(2, "0")}-${String(Math.min(31, Math.max(1, Number(d.value) || 1))).padStart(2, "0")}` };
  };
  const err = h("div");
  const fields = h("div", { class: "inline-form", style: "grid-template-columns:1fr" });
  let collect;

  const renderFields = (rule) => {
    if (kind === "season") {
      const from = mdPick(rule.from), to = mdPick(rule.to);
      collect = () => ({ type: "range", from: from.get(), to: to.get() });
      fields.replaceChildren(h("label", { class: "field" }, h("span", {}, t("fromLabel")), from.node), h("label", { class: "field" }, h("span", {}, t("toLabel")), to.node));
      return;
    }
    const type = h("select", {}, [["date", t("ruleDate")], ["fixed", t("ruleFixed")], ["nth", t("ruleNth")], ["easter", t("ruleEaster")]]
      .map(([v, l]) => h("option", { value: v, selected: v === rule.type }, l)));
    const body = h("div", { class: "inline-form", style: "grid-template-columns:1fr" });
    const draw = () => {
      const r = type.value === rule.type ? rule : { type: type.value };
      if (type.value === "date") {
        const date = h("input", { type: "date", value: r.date ?? ymd(new Date()) });
        collect = () => ({ type: "date", date: date.value });
        body.replaceChildren(h("label", { class: "field" }, h("span", {}, t("date")), date));
      } else if (type.value === "fixed") {
        const md = mdPick(r.md ?? "12-25"), days = num(r.days ?? 1, 1, 14);
        collect = () => ({ type: "fixed", md: md.get(), days: Number(days.value) || 1 });
        body.replaceChildren(h("label", { class: "field" }, h("span", {}, t("date")), md.node), h("label", { class: "field" }, h("span", {}, t("lengthDays")), days));
      } else if (type.value === "nth") {
        const month = h("select", {}, Array.from({ length: 12 }, (_, i) => h("option", { value: i + 1, selected: i + 1 === (r.month ?? 5) }, monthName(i + 1))));
        const wd = h("select", {}, Array.from({ length: 7 }, (_, i) => h("option", { value: i, selected: i === (r.weekday ?? 6) }, weekdayName(i))));
        const n = h("select", {}, [[1, "1"], [2, "2"], [3, "3"], [4, "4"], [-1, t("last")]].map(([v, l]) => h("option", { value: v, selected: v === (r.n ?? 2) }, l)));
        const days = num(r.days ?? 1, 1, 14);
        collect = () => ({ type: "nth", month: Number(month.value), weekday: Number(wd.value), n: Number(n.value), days: Number(days.value) || 1 });
        body.replaceChildren(h("label", { class: "field" }, h("span", {}, t("nthLabel")), n), h("label", { class: "field" }, h("span", {}, t("weekdayLabel")), wd),
          h("label", { class: "field" }, h("span", {}, t("monthLabel")), month), h("label", { class: "field" }, h("span", {}, t("lengthDays")), days));
      } else {
        const from = num(r.from ?? -2, -7, 7), to = num(r.to ?? 1, -7, 7);
        collect = () => ({ type: "easter", from: Number(from.value), to: Number(to.value) });
        body.replaceChildren(h("p", { class: "meta" }, t("easterRange")), h("div", { class: "row2" }, h("label", { class: "field" }, h("span", {}, t("fromLabel")), from), h("label", { class: "field" }, h("span", {}, t("toLabel")), to)));
      }
    };
    type.addEventListener("change", draw);
    draw();
    fields.replaceChildren(h("label", { class: "field" }, h("span", {}, t("ruleType")), type), body);
  };
  renderFields(rule0);

  const presetSel = set ? null : h("select", { onChange: (e) => {
    const p = presets.find((x) => x.id === e.target.value);
    if (!p) return;
    name.value = presetName(p);
    renderFields(p.rule);
  } }, h("option", { value: "" }, t("customPreset")), presets.map((p) => h("option", { value: p.id }, presetName(p))));

  const save = async () => {
    if (!name.value.trim()) { err.replaceChildren(h("div", { class: "alert" }, t("periodNameReq"))); return; }
    try {
      const body = { name: name.value.trim(), rule: collect() };
      if (set) await api(`/target-sets/${set.id}`, { method: "PUT", body });
      else await api("/target-sets", { method: "POST", body: { ...body, restaurant_id: restaurantId, kind } });
      dlg.close(); toast(t("saved")); onSaved();
    } catch (e) { err.replaceChildren(h("div", { class: "alert" }, errorText(e))); }
  };
  dlg.replaceChildren(h("form", { class: "modal-body", onSubmit: (e) => { e.preventDefault(); save(); } },
    h("h2", {}, kind === "season" ? t("seasonWord") : t("specialWord")),
    presetSel ? h("label", { class: "field" }, h("span", {}, t("preset")), presetSel) : null,
    h("label", { class: "field" }, h("span", {}, t("name")), name),
    fields, err,
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: () => dlg.close() }, t("cancel")), h("button", { class: "btn primary", type: "submit" }, t("save")))));
  dlg.showModal();
}

// Staffing targets as a week table (like the schedule): one column per date, one row per time slot.
// Each cell shows the number that applies on that date (base, season and special days combined).
function weeklyTargetsPanel(ov) {
  const st = { restaurant: ov.restaurants[0]?.id, department: "kitchen", week: mondayOf(new Date()), scope: "week" };
  const box = h("section", { class: "panel" });

  async function load() {
    if (!st.restaurant) { box.replaceChildren(); return; }
    const [rows, sets] = await Promise.all([
      api(`/targets?restaurant=${st.restaurant}&department=${st.department}`),
      api(`/target-sets?restaurant=${st.restaurant}`),
    ]);
    const days = Array.from({ length: 7 }, (_, i) => addDays(st.week, i));
    const info = days.map((day) => {
      const r = resolveForDate(rows, sets, day);
      const hol = holidaysOn(day);
      // a special day or one-off date already applying to this date, if any (used when saving)
      const activeSet = sets.filter((x) => x.kind === "special" && ruleMatchesDay(x.rule, day)).sort((a, b) => b.id - a.id)[0] ?? null;
      return { day, eff: r.targets, labels: r.labels, hol, activeSet };
    });
    const inputs = days.map(() => ({}));
    const sel = (opts, cur, onChange) => h("select", { onChange }, opts.map(([v, l]) => h("option", { value: v, selected: String(v) === String(cur) }, l)));
    const lang = getLang();

    const head = days.map((day, i) => h("th", { class: `tw-head ${info[i].hol.some((x) => x.statutory) ? "stat" : info[i].hol.length ? "spec" : ""}${day === ymd(new Date()) ? " today" : ""}` },
      h("div", { class: "dow" }, fmt(day, { weekday: "short" })),
      h("div", { class: "dom" }, fmt(day, { day: "numeric", month: "short" })),
      info[i].hol.map((x) => h("div", { class: `hol ${x.statutory ? "stat" : "spec"}`, title: x.statutory ? t("statutoryHoliday") : t("busyDay") }, `${x.statutory ? "🏛 " : "★ "}${lang === "fr" ? x.fr : x.en}`)),
      info[i].labels.length ? h("div", { class: "periods" }, info[i].labels.join(", ")) : null));

    const bounds = boundsOf(st.restaurant, ov.restaurants), SLOTS = periodKeys(bounds), slotLabel = (k) => periodLabel(bounds, k);
    const body = SLOTS.map((slot) => h("tr", {},
      h("th", { class: "tw-slot" }, slotLabel(slot)),
      days.map((day, i) => {
        const v = info[i].eff[slot];
        const input = h("input", { type: "number", min: 0, max: 99, inputMode: "numeric", value: v ?? "", "aria-label": `${slotLabel(slot)} ${fmt(day, { weekday: "long", day: "numeric" })}` });
        input.dataset.orig = v === undefined ? "" : String(v);
        inputs[i][slot] = input;
        return h("td", {}, input);
      })));

    const save = async () => {
      try {
        let touched = 0;
        for (let i = 0; i < 7; i++) {
          const changed = {};
          for (const slot of SLOTS) { const inp = inputs[i][slot]; if (inp.value !== inp.dataset.orig && inp.value !== "") changed[slot] = Number(inp.value); }
          if (!Object.keys(changed).length) continue;
          touched++;
          const day = days[i];
          let setId = 0, dow = i;
          if (st.scope === "week" || info[i].activeSet) {
            // Date-specific values live in a one-off special day for that date (or in the special day already covering it).
            let target = info[i].activeSet;
            if (st.scope === "week") target = sets.find((x) => x.kind === "special" && x.rule.type === "date" && x.rule.date === day) ?? null;
            if (!target) {
              const created = await api("/target-sets", { method: "POST", body: { restaurant_id: st.restaurant, name: `${fmt(day, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}`, kind: "special", rule: { type: "date", date: day } } });
              target = { id: created.id };
            }
            setId = target.id; dow = -1;
          }
          const own = {};
          for (const r of rows.filter((x) => x.set_id === setId && x.dow === dow)) own[r.slot] = r.count;
          await api("/targets", { method: "PUT", body: { restaurant_id: st.restaurant, department_id: st.department, set_id: setId, dow, slots: { ...own, ...changed } } });
        }
        toast(touched ? t("saved") : t("nothingChanged"));
        load();
      } catch (e) { toast(errorText(e)); }
    };

    box.replaceChildren(
      h("h2", {}, t("targetsWeekTitle")), h("p", { class: "meta" }, t("targetsWeekHelp")),
      h("div", { class: "inline-form", style: "grid-template-columns:1fr" },
        h("label", { class: "field" }, h("span", {}, t("restaurant")), sel(ov.restaurants.map((r) => [r.id, r.name]), st.restaurant, (e) => { st.restaurant = Number(e.target.value); load(); })),
        h("label", { class: "field" }, h("span", {}, t("department")), sel(DEPTS.map((d) => [d, t(`dept.${d}`)]), st.department, (e) => { st.department = e.target.value; load(); }))),
      h("div", { class: "weeknav", style: "margin:8px 0" },
        h("button", { class: "icon-btn", type: "button", "aria-label": t("prev"), onClick: () => { st.week = addDays(st.week, -7); load(); } }, "‹"),
        h("div", { class: "label" }, weekLabel(st.week)),
        h("button", { class: "icon-btn", type: "button", "aria-label": t("next"), onClick: () => { st.week = addDays(st.week, 7); load(); } }, "›"),
        h("button", { class: "btn", type: "button", onClick: () => { st.week = mondayOf(new Date()); load(); } }, t("today"))),
      h("div", { class: "field" }, h("span", {}, t("applyChangesTo")),
        h("div", { class: "seg" },
          [["week", t("scopeWeek")], ["always", t("scopeAlways")]].map(([v, l]) => h("button", { type: "button", "aria-pressed": String(st.scope === v), onClick: () => { st.scope = v; load(); } }, l))),
        h("span", { class: "meta" }, st.scope === "week" ? t("scopeWeekHelp") : t("scopeAlwaysHelp"))),
      h("div", { class: "tw-scroll" }, h("table", { class: "tw" }, h("thead", {}, h("tr", {}, h("th"), head)), h("tbody", {}, body))),
      h("p", { class: "meta" }, `🏛 ${t("statutoryHoliday")} · ★ ${t("busyDay")} · ${t("closeHelp")}`),
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onClick: save }, t("save"))));
  }
  load();
  return box;
}

function ruleMatchesDay(rule, day) { return ruleMatches(rule, day); }

function targetsPanel(ov) {
  const st = { restaurant: ov.restaurants[0]?.id, department: "kitchen", setId: 0, dow: -1 };
  const box = h("section", { class: "panel" });
  const inputs = {};

  async function load() {
    if (!st.restaurant) { box.replaceChildren(); return; }
    const [rows, sets] = await Promise.all([
      api(`/targets?restaurant=${st.restaurant}&department=${st.department}`),
      api(`/target-sets?restaurant=${st.restaurant}`),
    ]);
    if (st.setId !== 0 && !sets.some((x) => x.id === st.setId)) st.setId = 0;
    const set = sets.find((x) => x.id === st.setId);
    const own = rows.filter((r) => r.set_id === st.setId && r.dow === st.dow);
    // What the empty boxes fall back to: this period's own "every day" values, then the base values.
    const fallback = { ...resolveTargets(rows.filter((r) => r.set_id === 0), st.dow) };
    if (st.setId !== 0 && st.dow !== -1) Object.assign(fallback, resolveTargets(rows.filter((r) => r.set_id === st.setId), -1));
    const resto = ov.restaurants.find((r) => r.id === st.restaurant);
    const sel = (opts, cur, onChange) => h("select", { onChange }, opts.map(([v, l]) => h("option", { value: v, selected: String(v) === String(cur) }, l)));
    const reload = () => load();

    const bounds2 = boundsOf(st.restaurant, ov.restaurants), SLOTS2 = periodKeys(bounds2), slotLabel2 = (k) => periodLabel(bounds2, k);
    const slotInputs = SLOTS2.map((slot) => {
      const mine = own.find((r) => r.slot === slot)?.count;
      const dflt = fallback[slot];
      const input = h("input", { type: "number", min: 0, max: 99, inputMode: "numeric", value: mine ?? "", placeholder: dflt !== undefined ? String(dflt) : "" });
      inputs[slot] = input;
      return h("label", { class: "field" }, h("span", {}, slotLabel2(slot)), input);
    });
    const saveTargets = async (slots) => {
      try { await api("/targets", { method: "PUT", body: { restaurant_id: st.restaurant, department_id: st.department, set_id: st.setId, dow: st.dow, slots } }); toast(t("saved")); reload(); }
      catch (e) { toast(errorText(e)); }
    };

    const periodOpts = [[0, t("basePeriod")],
      ...sets.filter((x) => x.kind === "season").map((x) => [x.id, `${t("seasonWord")} · ${x.name}`]),
      ...sets.filter((x) => x.kind === "special").map((x) => [x.id, `${t("specialWord")} · ${x.name}`])];

    box.replaceChildren(...[
      h("h2", {}, t("targetsPeriods")), h("p", { class: "meta" }, t("targetsHelp")),
      h("div", { class: "inline-form", style: "grid-template-columns:1fr" },
        h("label", { class: "field" }, h("span", {}, t("restaurant")), sel(ov.restaurants.map((r) => [r.id, r.name]), st.restaurant, (e) => { st.restaurant = Number(e.target.value); st.setId = 0; reload(); })),
        h("label", { class: "field" }, h("span", {}, t("department")), sel(DEPTS.map((d) => [d, t(`dept.${d}`)]), st.department, (e) => { st.department = e.target.value; reload(); })),
        h("label", { class: "field" }, h("span", {}, t("period")), sel(periodOpts, st.setId, (e) => { st.setId = Number(e.target.value); reload(); }))),
      h("div", { class: "period-bar" },
        h("button", { class: "btn", type: "button", onClick: () => periodDialog({ restaurantId: st.restaurant, kind: "season", onSaved: reload }) }, t("addSeason")),
        h("button", { class: "btn", type: "button", onClick: () => periodDialog({ restaurantId: st.restaurant, kind: "special", onSaved: reload }) }, t("addSpecial"))),
      set ? h("div", { class: "period-note" }, h("strong", {}, set.name), ` — ${describeRule(set.rule)}`,
        h("div", { class: "period-bar" },
          h("button", { class: "btn", type: "button", onClick: () => periodDialog({ restaurantId: st.restaurant, kind: set.kind, set, onSaved: reload }) }, t("editPeriod")),
          h("button", { class: "btn danger", type: "button", onClick: async () => {
            if (!confirm(t("confirmDeletePeriod"))) return;
            try { await api(`/target-sets/${set.id}`, { method: "DELETE" }); st.setId = 0; reload(); } catch (e) { toast(errorText(e)); }
          } }, t("deletePeriod")))) : null,
      st.setId !== 0 ? h("p", { class: "meta" }, t("inheritNote")) : null,
      h("label", { class: "field" }, h("span", {}, t("week")), sel([[-1, t("allDays")], ...Array.from({ length: 7 }, (_, i) => [i, weekdayName(i)])], st.dow, (e) => { st.dow = Number(e.target.value); reload(); })),
      st.dow !== -1 ? h("p", { class: "meta" }, t("dayOverride")) : null,
      h("div", { class: "slot-grid" }, slotInputs),
      h("p", { class: "meta" }, t("closeHelp")),
      h("div", { class: "actions" },
        st.dow !== -1 ? h("button", { class: "btn danger", type: "button", onClick: () => saveTargets({}) }, t("resetDay")) : null,
        h("button", { class: "btn primary", type: "button", onClick: () => {
          const slots = {};
          for (const slot of SLOTS2) if (inputs[slot].value !== "") slots[slot] = Number(inputs[slot].value);
          saveTargets(slots);
        } }, t("save"))),
    ].filter(Boolean));
  }
  load();
  return box;
}

// Shared by the role dialogs: "from" date (default Monday of the current week). Earlier shifts keep their old role.
const thisMonday = () => mondayOf(new Date());
function fromField() {
  const input = h("input", { type: "date", value: thisMonday() });
  return { input, node: h("label", { class: "field" }, h("span", {}, t("effectiveFrom")), input, h("span", { class: "meta" }, t("effectiveHelp"))) };
}

// The time periods of the staffing targets, per restaurant (Open-8:00, 8:00-9:00 ... 20:00-Close).
function periodsPanel(ov) {
  const st = { restaurant: ov.restaurants[0]?.id };
  const box = h("section", { class: "panel" });
  function draw() {
    const resto = ov.restaurants.find((r) => r.id === st.restaurant);
    if (!resto) { box.replaceChildren(); return; }
    let list = [...(resto.period_bounds ?? DEFAULT_BOUNDARIES)];
    const paint = () => {
      const fields = list.map((b, i) => { const f = timeField(b); f.addEventListener("change", () => { list[i] = f.value; showPreview(); }); return f; });
      const preview = h("p", { class: "meta" });
      const showPreview = () => { preview.textContent = periodKeys(list).map((k) => periodLabel(list, k)).join("  ·  "); };
      showPreview();
      box.replaceChildren(h("h2", {}, t("periodsTitle")), h("p", { class: "meta" }, t("periodsHelp")),
        h("label", { class: "field" }, h("span", {}, t("restaurant")), h("select", { onChange: (e) => { st.restaurant = Number(e.target.value); draw(); } }, ov.restaurants.map((r) => h("option", { value: r.id, selected: r.id === st.restaurant }, r.name)))),
        h("div", { class: "hours-table" }, h("div", { class: "hours-row" }, h("strong", {}, t("openSlot")), h("span", { class: "meta" }, t("firstPeriod"))),
          fields.map((f, i) => h("div", { class: "hours-row" }, h("strong", {}, t("periodStarts")), f,
            list.length > 1 ? h("button", { class: "btn danger", type: "button", onClick: () => { list.splice(i, 1); paint(); } }, t("delete")) : null))),
        preview,
        h("div", { class: "actions" },
          list.length < 10 ? h("button", { class: "btn", type: "button", onClick: () => { const last = list[list.length - 1]; const m = Math.min(1380, toMin(last) + 60); list.push(fromMin(m)); paint(); } }, `+ ${t("addPeriod")}`) : null,
          h("button", { class: "btn", type: "button", onClick: () => { list = [...DEFAULT_BOUNDARIES]; paint(); } }, t("defaultPeriods")),
          h("button", { class: "btn primary", type: "button", onClick: async () => {
            try {
              await api(`/restaurants/${st.restaurant}/periods`, { method: "PUT", body: { boundaries: list } });
              state.restaurants = await api("/restaurants"); ov.restaurants = await api("/restaurants"); toast(t("saved")); draw();
            } catch (e) { toast(e.body?.error === "invalid_periods" ? t("periodsInvalid") : errorText(e)); }
          } }, t("save"))));
    };
    paint();
  }
  draw();
  return box;
}

// Default hourly rates used when an employee has no rate of their own (Québec minimum wages).
function defaultRatesPanel(ov) {
  const box = h("section", { class: "panel" });
  const fmtRate = (c) => (c == null ? "" : (c / 100).toFixed(2));
  api("/roles").then((roles) => {
    const d = ov.default_rates ?? { general_cents: null, roles: {} };
    const general = h("input", { type: "number", min: 0, max: 1000, step: "0.05", inputMode: "decimal", value: fmtRate(d.general_cents) });
    const rows = roles.map((r) => ({ r, input: h("input", { type: "number", min: 0, max: 1000, step: "0.05", inputMode: "decimal", placeholder: t("sameAsGeneral"), value: fmtRate(d.roles[r.id]) }) }));
    box.replaceChildren(h("h2", {}, t("defaultRatesTitle")), h("p", { class: "meta" }, t("defaultRatesHelp")),
      h("label", { class: "field" }, h("span", {}, t("generalRate")), general),
      h("div", { class: "hours-table" }, rows.map(({ r, input }) => h("div", { class: "hours-row" }, h("strong", {}, `${roleIcon(r)} ${roleName(r)}`), h("label", { class: "mini" }, h("span", {}, "$ / h"), input)))),
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onClick: async () => {
        try {
          const saved = await api("/admin/default-rates", { method: "PUT", body: { general: general.value, roles: Object.fromEntries(rows.map(({ r, input }) => [r.id, input.value])) } });
          ov.default_rates = saved; toast(t("saved"));
        } catch (e) { toast(e.body?.error === "invalid_rate" ? t("genericError") : errorText(e)); }
      } }, t("save"))));
  }).catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

// Minutes before opening that each role should arrive (default start of new shifts).
function preOpenPanel() {
  const box = h("section", { class: "panel" });
  api("/roles").then((roles) => {
    const inputs = roles.map((r) => ({ r, input: h("input", { type: "number", min: 0, max: 180, step: 5, inputMode: "numeric", value: r.pre_open_minutes ?? 0 }) }));
    box.replaceChildren(h("h2", {}, t("preOpenTitle")), h("p", { class: "meta" }, t("preOpenHelp")),
      h("div", { class: "hours-table" }, inputs.map(({ r, input }) => h("div", { class: "hours-row" }, h("strong", {}, `${roleIcon(r)} ${roleName(r)}`), h("label", { class: "mini" }, h("span", {}, t("minutes")), input)))),
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onClick: async () => {
        try {
          for (const { r, input } of inputs) { const m = Number(input.value) || 0; if (m !== (r.pre_open_minutes ?? 0)) { await api(`/roles/${r.id}/pre-open`, { method: "PUT", body: { minutes: m } }); r.pre_open_minutes = m; } }
          state.roles = await api("/roles"); toast(t("saved"));
        } catch (e) { toast(errorText(e)); }
      } }, t("save"))));
  }).catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

// Opening and closing time for every weekday of one restaurant.
function hoursPanel(ov) {
  const st = { restaurant: ov.restaurants[0]?.id };
  const box = h("section", { class: "panel" });
  function draw() {
    const resto = ov.restaurants.find((r) => r.id === st.restaurant);
    if (!resto) { box.replaceChildren(h("h2", {}, t("hoursTitle")), h("div", { class: "empty" }, t("noSchedules"))); return; }
    const rows = Array.from({ length: 7 }, (_, i) => ({
      open: timeField(resto.open_by_dow?.[i] ?? resto.open_time),
      close: timeField(resto.close_by_dow?.[i] ?? resto.close_time),
    }));
    const copyMonday = () => rows.slice(1).forEach((r) => { r.open.value = rows[0].open.value; r.close.value = rows[0].close.value; });
    box.replaceChildren(
      h("h2", {}, t("hoursTitle")),
      h("p", { class: "meta" }, t("hoursHelp")),
      h("label", { class: "field" }, h("span", {}, t("restaurant")),
        h("select", { onChange: (e) => { st.restaurant = Number(e.target.value); draw(); } },
          ov.restaurants.map((r) => h("option", { value: r.id, selected: r.id === st.restaurant }, r.name)))),
      h("div", { class: "hours-table" },
        h("div", { class: "hours-head" }, h("span"), h("span", {}, t("openTime")), h("span", {}, t("closeTime"))),
        rows.map((r, i) => h("div", { class: "hours-row" }, h("strong", {}, weekdayName(i)),
          h("label", { class: "mini" }, h("span", {}, t("openTime")), r.open),
          h("label", { class: "mini" }, h("span", {}, t("closeTime")), r.close)))),
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "button", onClick: copyMonday }, t("copyMonday")),
        h("button", { class: "btn primary", type: "button", onClick: async () => {
          try {
            await api(`/restaurants/${st.restaurant}/hours`, { method: "PUT", body: { open_times: rows.map((r) => r.open.value), close_times: rows.map((r) => r.close.value) } });
            state.restaurants = await api("/restaurants"); ov.restaurants = await api("/restaurants"); toast(t("saved")); draw();
          } catch (e) { toast(e.body?.error === "invalid_times" ? t("opensBeforeCloses") : errorText(e)); }
        } }, t("save"))));
  }
  draw();
  return box;
}

// Untick a role: if shifts still use it, ask whether to move them to another role or delete them.
async function removeRole(body, role, input, onRemoved) {
  const dlg = document.getElementById("modal");
  const from = thisMonday();
  try {
    await api("/staff-roles", { method: "DELETE", body: { ...body, effective_from: from } });
    onRemoved?.(); toast(t("saved"));
    return;
  } catch (e) {
    if (e.body?.error !== "has_shifts") { input.checked = true; toast(errorText(e)); return; }
    const { count, alternatives } = e.body;
    const date = fromField();
    let decided = false;
    const act = async (extra) => {
      try { await api("/staff-roles", { method: "DELETE", body: { ...body, effective_from: date.input.value, ...extra } }); decided = true; dlg.close(); onRemoved?.(); toast(t("saved")); }
      catch (err) { toast(errorText(err)); }
    };
    dlg.replaceChildren(h("div", { class: "modal-body" },
      h("h2", {}, t("hasShiftsTitle")),
      h("p", {}, `${count} ${t("hasShiftsBody")}`),
      date.node,
      alternatives.length
        ? alternatives.map((a) => h("button", { class: "btn primary", type: "button", onClick: () => act({ reassign_to_role_id: a.id }) },
            `${t("moveShiftsTo")} ${roleName(a)} (${t(`dept.${a.department_id}`)})`))
        : h("p", { class: "meta" }, t("addRoleFirst")),
      h("button", { class: "btn danger", type: "button", onClick: () => act({ delete_shifts: true }) }, t("deleteShifts")),
      h("button", { class: "btn", type: "button", onClick: () => dlg.close() }, t("cancel"))));
    dlg.addEventListener("close", () => { if (!decided) input.checked = true; }, { once: true });
    dlg.showModal();
  }
}

// Ticking a new role for someone who already holds another one at this restaurant: add it, or replace the old one.
function roleChoiceDialog({ s, r, ro, others, input, roleInputs }) {
  const dlg = document.getElementById("modal");
  const date = fromField();
  const oldRole = (x) => state.roles.find((q) => q.id === x.role_id);
  let decided = false;
  const done = () => { decided = true; dlg.close(); toast(t("saved")); };
  const add = async () => {
    try { await api("/staff-roles", { method: "POST", body: { staff_id: s.id, restaurant_id: r.id, role_id: ro.id } }); s.roles.push({ staff_id: s.id, restaurant_id: r.id, role_id: ro.id }); done(); }
    catch (e) { toast(errorText(e)); }
  };
  const replace = async (old) => {
    try {
      await api("/staff-roles", { method: "POST", body: { staff_id: s.id, restaurant_id: r.id, role_id: ro.id } });
      s.roles.push({ staff_id: s.id, restaurant_id: r.id, role_id: ro.id });
      await api("/staff-roles", { method: "DELETE", body: { staff_id: s.id, restaurant_id: r.id, role_id: old.role_id, reassign_to_role_id: ro.id, effective_from: date.input.value } });
      s.roles = s.roles.filter((x) => !(x.restaurant_id === r.id && x.role_id === old.role_id));
      const box = roleInputs.get(`${r.id}:${old.role_id}`); if (box) box.checked = false;
      done();
    } catch (e) { toast(errorText(e)); }
  };
  dlg.replaceChildren(h("div", { class: "modal-body" },
    h("h2", {}, `${roleName(ro)} — ${r.name}`),
    h("p", {}, t("roleChoiceBody")),
    date.node,
    others.map((old) => h("button", { class: "btn primary", type: "button", onClick: () => replace(old) },
      `${t("replace")} ${roleName(oldRole(old))} → ${roleName(ro)}`)),
    h("button", { class: "btn", type: "button", onClick: add }, t("addAlso")),
    h("button", { class: "btn", type: "button", onClick: () => dlg.close() }, t("cancel"))));
  dlg.addEventListener("close", () => { if (!decided) input.checked = false; }, { once: true });
  dlg.showModal();
}

function staffCard(s, ov) {
  const sp = s.first_name ? { first: s.first_name, last: s.last_name } : splitName(s.name);
  const first = h("input", { value: sp.first, required: true, maxLength: 80 });
  const last = h("input", { value: sp.last, maxLength: 80 });
  const fullName = () => joinName(first.value, last.value);
  const email = h("input", { type: "email", value: s.email ?? "" });
  const phone = h("input", { type: "tel", value: s.phone ?? "" });
  const lang = h("select", {}, ["fr", "en"].map((l) => h("option", { value: l, selected: s.lang === l }, l === "fr" ? "Français" : "English")));
  const channel = h("select", {}, [["sms", t("sms")], ["email", t("emailCh")]].map(([v, l]) => h("option", { value: v, selected: s.notify_channel === v }, l)));
  const rate = h("input", { type: "number", min: 0, max: 1000, step: "0.05", inputMode: "decimal", placeholder: ov.default_rates?.general_cents != null ? `${t("defaultWord")} ${(ov.default_rates.general_cents / 100).toFixed(2)}` : t("noRate"), value: s.hourly_cents != null ? (s.hourly_cents / 100).toFixed(2) : "" });
  // Optional hourly rate per role held (e.g. delivery driver vs cook); blank = use the general rate.
  const heldRoleIds = [...new Set(s.roles.map((r) => r.role_id))];
  const roleRateInputs = heldRoleIds.map((rid) => {
    const ro = state.roles.find((x) => x.id === rid);
    const cents = s.role_rates?.[rid];
    return { rid, ro, input: h("input", { type: "number", min: 0, max: 1000, step: "0.05", inputMode: "decimal", placeholder: (() => { const dr = ov.default_rates?.roles?.[rid] ?? ov.default_rates?.general_cents; return dr != null ? `${t("defaultWord")} ${(dr / 100).toFixed(2)}` : t("sameAsGeneral"); })(), value: cents != null ? (cents / 100).toFixed(2) : "" }) };
  }).filter((x) => x.ro);
  const adminMsg = h("div", { class: "alert", role: "alert" });
  const maxHours = h("input", { type: "number", min: 1, max: 168, step: "0.5", inputMode: "decimal", placeholder: t("noMaxHours"), value: s.max_weekly_hours ?? "" });
  const sinInput = h("input", { inputMode: "numeric", autocomplete: "off", placeholder: s.sin_last3 ? `••• ••• ${s.sin_last3}` : "000 000 000", maxLength: 11 });
  let bigAvatar = avatar(s.id, s.name, s.color, s.photo_v, 72);
  let summaryAvatar = avatar(s.id, s.name, s.color, s.photo_v, 28);
  const refreshAvatars = () => {
    const big = avatar(s.id, s.name, chosen ?? s.color, s.photo_v, 72), small = avatar(s.id, s.name, chosen ?? s.color, s.photo_v, 28);
    bigAvatar.replaceWith(big); bigAvatar = big; summaryAvatar.replaceWith(small); summaryAvatar = small;
  };
  const fileInput = h("input", { type: "file", accept: "image/*", hidden: true });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const data_url = await photoToDataUrl(file);
      const r = await api(`/staff/${s.id}/photo`, { method: "PUT", body: { data_url } });
      s.photo_v = r.photo_v; refreshAvatars(); toast(t("saved"));
    } catch (e) { toast(e.body?.error === "invalid_image" ? t("badImage") : errorText(e)); }
    fileInput.value = "";
  });
  const photoRow = h("div", { class: "photo-row" }, bigAvatar,
    h("div", { class: "photo-actions" },
      h("button", { class: "btn", type: "button", onClick: () => fileInput.click() }, t("choosePhoto")),
      h("button", { class: "btn", type: "button", onClick: async () => {
        try { await api(`/staff/${s.id}/photo`, { method: "DELETE" }); s.photo_v = null; refreshAvatars(); toast(t("saved")); } catch (e) { toast(errorText(e)); }
      } }, t("removePhoto")), fileInput));
  let chosen = s.color ?? null; // null = automatic colour
  const dot = h("span", { class: "dot big", style: `background:${staffColor(s.id, chosen)}` });
  const picker = h("input", { type: "color", value: staffColor(s.id, chosen), "aria-label": t("colour") });
  const setColor = (c) => { chosen = c; const shown = staffColor(s.id, c); dot.style.background = shown; picker.value = shown; summaryDot.style.background = shown; if (!s.photo_v) refreshAvatars(); };
  picker.addEventListener("input", () => setColor(picker.value));
  const swatches = h("div", { class: "swatches" }, SWATCHES.map((c) =>
    h("button", { type: "button", class: "swatch", style: `background:${c}`, "aria-label": c, onClick: () => setColor(c) })),
    h("button", { type: "button", class: "btn", onClick: () => setColor(null) }, t("autoColour")));
  const summaryDot = h("span", { class: "dot", style: `background:${staffColor(s.id, chosen)}` });
  const details = h("form", { id: `staff-form-${s.id}`, class: "inline-form", style: "grid-template-columns:1fr", onSubmit: async (e) => {
    e.preventDefault();
    try {
      await api(`/staff/${s.id}`, { method: "PUT", body: { first_name: first.value, last_name: last.value, sex: sex.value || null, email: email.value, phone: phone.value, lang: lang.value, notify_channel: channel.value, color: chosen } });
      const w = await api(`/staff/${s.id}/wage`, { method: "PUT", body: { hourly_rate: rate.value, role_rates: Object.fromEntries(roleRateInputs.map((x) => [x.rid, x.input.value])) } });
      s.hourly_cents = w.hourly_cents; s.role_rates = w.role_rates;
      const lim = await api(`/staff/${s.id}/limit`, { method: "PUT", body: { max_weekly_hours: maxHours.value } }); s.max_weekly_hours = lim.max_weekly_hours;
      if (sinInput.value.trim()) { const r = await api(`/staff/${s.id}/sin`, { method: "PUT", body: { sin: sinInput.value } }); s.sin_last3 = r.sin_last3; sinInput.value = ""; sinInput.placeholder = `••• ••• ${r.sin_last3}`; }
      toast(t("saved"));
    } catch (err) { toast(err.body?.error === "invalid_sin" ? t("invalidSin") : err.body?.error === "sin_already_used" ? t("sinUsed") : err.body?.error === "invalid_rate" ? t("genericError") : errorText(err)); }
  } },
    h("label", { class: "field" }, h("span", {}, t("firstName")), first), h("label", { class: "field" }, h("span", {}, t("lastName")), last),
    h("label", { class: "field" }, h("span", {}, t("sexLabel")), sex, h("span", { class: "meta" }, t("sexHelp"))), h("label", { class: "field" }, h("span", {}, t("email")), email),
    h("label", { class: "field" }, h("span", {}, t("phone")), phone), h("label", { class: "field" }, h("span", {}, t("language")), lang),
    h("label", { class: "field" }, h("span", {}, t("notifyBy")), channel),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: s.active !== false, onChange: async (e) => {
      const want = e.target.checked;
      adminMsg.textContent = "";
      try {
        const r = await api(`/staff/${s.id}/active`, { method: "PUT", body: { active: want } });
        s.active = want; rowEl.classList.toggle("inactive", !want);
        toast(!want && r.upcoming_shifts ? `${t("saved")} — ⚠ ${r.upcoming_shifts} ${t("upcomingShiftsKept")}` : t("saved"));
      } catch (err) { e.target.checked = !want; adminMsg.textContent = { cannot_remove_self: t("cannotRemoveSelf"), last_admin: t("lastAdmin") }[err.body?.error] ?? errorText(err); }
    } }), h("span", {}, t("activeLabel"))),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!s.is_admin, onChange: async (e) => {
      const want = e.target.checked;
      adminMsg.textContent = "";
      try {
        await api(`/staff/${s.id}/admin`, { method: "PUT", body: { is_admin: want, email: email.value } });
        s.is_admin = want; s.email = email.value.trim().toLowerCase() || s.email; toast(t("saved"));
      } catch (err) {
        e.target.checked = !want;
        // shown inside the dialog: a toast would be hidden behind it
        adminMsg.textContent = { email_required: t("adminNeedsEmail"), invalid_email: t("invalidEmail"), email_taken: t("emailTaken"), cannot_remove_self: t("cannotRemoveSelf"), last_admin: t("lastAdmin") }[err.body?.error] ?? errorText(err);
        if (err.body?.error === "email_required") email.focus();
      }
    } }), h("span", {}, t("isAdminLabel"))),
    adminMsg,
    h("label", { class: "field" }, h("span", {}, t("hourlyRate")), rate, h("span", { class: "meta" }, t("adminOnlyField"))),
    h("label", { class: "field" }, h("span", {}, t("maxWeeklyHours")), maxHours, h("span", { class: "meta" }, t("maxWeeklyHoursHelp"))),
    h("label", { class: "field" }, h("span", {}, t("sinLabel")), sinInput, h("span", { class: "meta" }, t("sinHelp"))),
    roleRateInputs.length > 1 ? h("div", { class: "field" }, h("span", {}, t("rateByRole")), roleRateInputs.map((x) =>
      h("label", { class: "role-rate" }, h("span", {}, `${roleIcon(x.ro)} ${roleName(x.ro, s.sex)}`), x.input))) : null,
    photoRow,
    h("div", { class: "field" }, h("span", {}, t("colour")), h("div", { class: "colour-row" }, dot, picker), swatches));

  const toggle = (checked, onOn, onOff) => async (e) => {
    try { await (e.target.checked ? onOn() : onOff()); toast(t("saved")); } catch (err) { e.target.checked = !e.target.checked; toast(errorText(err)); }
  };
  const roleInputs = new Map();
  const blocks = ov.restaurants.map((r) => h("div", { class: "resto-block" }, h("h3", {}, r.name),
    DEPTS.map((d) => {
      const dRoles = state.roles.filter((ro) => ro.department_id === d);
      return h("div", {}, h("div", { class: "sub" }, t(`dept.${d}`)),
        h("div", { class: "checks" },
          dRoles.map((ro) => {
            const body = { staff_id: s.id, restaurant_id: r.id, role_id: ro.id };
            const on = s.roles.some((x) => x.restaurant_id === r.id && x.role_id === ro.id);
            const input = h("input", { type: "checkbox", checked: on });
            roleInputs.set(`${r.id}:${ro.id}`, input);
            input.addEventListener("change", async () => {
              if (input.checked) {
                const others = s.roles.filter((x) => x.restaurant_id === r.id && x.role_id !== ro.id);
                if (others.length) { roleChoiceDialog({ s, r, ro, others, input, roleInputs }); return; }
                try { await api("/staff-roles", { method: "POST", body }); s.roles.push({ staff_id: s.id, restaurant_id: r.id, role_id: ro.id }); toast(t("saved")); }
                catch (err) { input.checked = false; toast(errorText(err)); }
              } else {
                removeRole(body, ro, input, () => { s.roles = s.roles.filter((x) => !(x.restaurant_id === r.id && x.role_id === ro.id)); });
              }
            });
            return h("label", { class: "check" }, input, `${roleIcon(ro)} ${roleName(ro, s.sex)}`);
          }),
          (() => {
            const body = { staff_id: s.id, restaurant_id: r.id, department_id: d };
            const on = s.managers.some((x) => x.restaurant_id === r.id && x.department_id === d);
            return h("label", { class: "check", style: "border-color:var(--brand)" }, h("input", { type: "checkbox", checked: on, onChange: toggle(on,
              () => api("/managers", { method: "POST", body }), () => api("/managers", { method: "DELETE", body })) }), `★ ${t("managerOf")}`);
          })()));
    })));

  // The card is a compact row; the details open in their own dialog (separate from #modal, which the role dialogs use).
  // Icons grouped by restaurant: the roles held there, then ⭐ + the department icon for each department managed there.
  const shortName = (n) => n.split(/-des-|\sdes\s/)[0];
  const byResto = ov.restaurants.map((r) => {
    const roleIcons = [...new Set(s.roles.filter((x) => x.restaurant_id === r.id).map((x) => roleIcon(state.roles.find((y) => y.id === x.role_id))))];
    const mgr = s.managers.filter((m) => m.restaurant_id === r.id).map((m) => deptIcon(m.department_id));
    return { r, roleIcons, mgr };
  }).filter((x) => x.roleIcons.length || x.mgr.length);
  const iconBlock = h("span", { class: "staff-icons" }, byResto.map(({ r, roleIcons, mgr }) =>
    h("span", { class: "resto-icons", title: r.name }, h("small", {}, shortName(r.name)), ` ${roleIcons.join(" ")}`,
      mgr.length ? h("span", { class: "mgr-icons", title: t("managerOf") }, mgr.map((i) => h("span", {}, `⭐${i}`))) : null)));
  const nameEl = h("span", {}, s.name);
  const open = () => {
    let dlg = document.getElementById("staff-modal");
    if (!dlg) { dlg = h("dialog", { id: "staff-modal", class: "wide" }); document.body.append(dlg); }
    // Four tabs: details (the form), roles, availability and requested time off. Save only applies to the details tab.
    const tabs = [["details", t("details")], ["roles", t("rolesTab")], ["availability", t("availability")], ["timeoff", t("requestedTimeOff")]];
    let tab = "details";
    const saveBtn = h("button", { class: "btn primary", type: "submit", form: `staff-form-${s.id}` }, t("save"));
    const tabBar = h("div", { class: "dlg-tabs", role: "tablist" });
    const content = h("div", { class: "dlg-content" });
    const panes = {
      details: () => [details],
      roles: () => [blocks],
      availability: () => [availabilityEditor(s.id)],
      timeoff: () => [staffTimeOff(s)],
    };
    const draw = () => {
      saveBtn.hidden = tab !== "details";
      tabBar.replaceChildren(...tabs.map(([id, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(tab === id), onClick: () => { tab = id; draw(); } }, label)));
      content.replaceChildren(...panes[tab]());
    };
    dlg.replaceChildren(h("div", { class: "modal-body staff-dialog" },
      // Sticky header: Save submits the details form (form= attribute), Close just closes.
      h("div", { class: "dlg-top" },
        h("div", { class: "dlg-head" }, h("h2", {}, s.name), h("div", { class: "dlg-actions" }, saveBtn, h("button", { class: "btn", type: "button", onClick: () => dlg.close() }, t("close")))),
        tabBar),
      content));
    draw();
    dlg.addEventListener("close", () => { s.first_name = first.value.trim() || s.first_name; s.last_name = last.value.trim(); nameEl.textContent = fullName() || s.name; s.name = nameEl.textContent; }, { once: true });
    dlg.showModal();
  };
  const rowEl = h("button", { class: `staff-row ${s.active === false ? "inactive" : ""}`, type: "button", onClick: open },
    h("span", { class: "who-row" }, summaryAvatar, nameEl), iconBlock,
    h("span", { class: "inactive-badge badge" }, t("inactive")),
    s.is_admin ? h("span", { class: "badge" }, t("admin_flag")) : h("span", { class: "meta" }, s.email ?? ""));
  return rowEl;
}

// ---------- boot ----------
async function boot() {
  try {
    state.me = await api("/me");
  } catch (e) {
    renderChrome();
    const detail = e.body?.email ? `${t("signedInAs")} ${e.body.email}` : e.body?.reason ?? String(e.message ?? "");
    $app.replaceChildren(h("div", { class: "empty" }, h("h2", {}, t("noAccessTitle")), t("noAccessBody"),
      h("p", { class: "meta" }, detail)));
    return;
  }
  [state.restaurants, state.roles] = await Promise.all([api("/restaurants"), api("/roles")]);
  render();
}
boot();
