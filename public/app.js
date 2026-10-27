import { t, getLang, setLang, locale, roleName } from "./i18n.js";

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
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
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

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const mondayOf = (d) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return ymd(x); };
const hhmm = (iso) => iso.slice(11, 16);
// Until-close shifts show "F" instead of an end time. end_at is a provisional closing time
// until per-restaurant closing hours exist.
const DEFAULT_CLOSE = "22:00";
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
  sel: { restaurant: null, department: null, week: mondayOf(new Date()), day: ymd(new Date()) },
};

const DEPTS = ["floor", "kitchen", "delivery"];

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
  const tabs = [["schedule", t("schedule")], ["mine", t("myShifts")]];
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
    if (state.view === "schedule") await renderSchedule();
    else if (state.view === "mine") await renderMine();
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
function pickDefaults() {
  const sel = state.sel;
  const options = state.restaurants.filter((r) => allowedDepartments(r.id).length);
  if (!options.length) return false;
  if (!options.some((r) => r.id === sel.restaurant)) sel.restaurant = options[0].id;
  const depts = allowedDepartments(sel.restaurant);
  if (!depts.includes(sel.department)) sel.department = depts[0];
  return options;
}

async function renderSchedule() {
  const options = pickDefaults();
  if (!options) { $app.replaceChildren(h("div", { class: "empty" }, t("noSchedules"))); return; }
  const sel = state.sel;
  const q = `restaurant=${sel.restaurant}&department=${sel.department}&week=${sel.week}`;
  const data = await api(`/schedule?${q}`);
  const roster = data.editable ? await api(`/roster?restaurant=${sel.restaurant}&department=${sel.department}`) : [];
  const days = Array.from({ length: 7 }, (_, i) => addDays(sel.week, i));
  if (!days.includes(sel.day)) sel.day = days.includes(ymd(new Date())) ? ymd(new Date()) : days[0];
  const today = ymd(new Date());

  const controls = h("div", { class: "controls" },
    h("label", { class: "field" }, h("span", {}, t("restaurant")),
      h("select", { onChange: (e) => { sel.restaurant = Number(e.target.value); render(); } },
        options.map((r) => h("option", { value: r.id, selected: r.id === sel.restaurant }, r.name)))),
    h("div", { class: "field" }, h("span", {}, t("department")),
      h("div", { class: "seg" }, allowedDepartments(sel.restaurant).map((d) =>
        h("button", { type: "button", "aria-pressed": String(d === sel.department), onClick: () => { sel.department = d; render(); } }, t(`dept.${d}`))))),
    h("div", { class: "field" }, h("span", {}, t("week")),
      h("div", { class: "weeknav" },
        h("button", { class: "icon-btn", type: "button", "aria-label": t("prev"), onClick: () => { sel.week = addDays(sel.week, -7); sel.day = sel.week; render(); } }, "‹"),
        h("div", { class: "label" }, weekLabel(sel.week)),
        h("button", { class: "icon-btn", type: "button", "aria-label": t("next"), onClick: () => { sel.week = addDays(sel.week, 7); sel.day = sel.week; render(); } }, "›"))),
    h("div", { class: "field" }, h("span", {}, " "),
      h("button", { class: "btn", type: "button", onClick: () => { sel.week = mondayOf(new Date()); sel.day = ymd(new Date()); render(); } }, t("today"))),
  );

  const status = h("p", {}, h("span", { class: `badge ${data.editable ? "edit" : ""}` }, data.editable ? t("canEdit") : t("viewOnly")));
  const byDay = (d) => data.shifts.filter((s) => dayOf(s.start_at) === d);
  const openEditor = (shift, prefill) => openShiftModal({ shift, prefill, roster, data });

  // Mobile: day tabs + list
  const daytabs = h("div", { class: "daytabs", role: "group" }, days.map((d) =>
    h("button", { type: "button", class: byDay(d).length ? "has" : "", "aria-pressed": String(d === sel.day), onClick: () => { sel.day = d; render(); } },
      h("span", { class: "dow" }, fmt(d, { weekday: "short" })), h("span", { class: "dom" }, fmt(d, { day: "numeric" })))));
  const dayShifts = byDay(sel.day);
  const daily = h("section", { class: "daily" },
    h("h2", {}, fmt(sel.day, { weekday: "long", day: "numeric", month: "long" })),
    dayShifts.length
      ? h("div", { class: "list" }, dayShifts.map((s) => {
          const card = [h("span", { class: "time" }, range(s)), h("span", { class: "who" }, s.staff_name),
            h("span", { class: "meta" }, [roleName(s), s.notes].filter(Boolean).join(" · "))];
          return data.editable ? h("button", { class: "card", type: "button", onClick: () => openEditor(s) }, card) : h("div", { class: "card" }, card);
        }))
      : h("div", { class: "empty" }, t("noShifts")));
  const fab = data.editable ? h("button", { class: "fab", type: "button", "aria-label": t("addShift"), onClick: () => openEditor(null, { date: sel.day }) }, "+") : null;

  // Desktop: staff × days grid
  const people = new Map();
  for (const r of roster) people.set(r.staff_id, r.name);
  for (const s of data.shifts) people.set(s.staff_id, s.staff_name);
  const rows = [...people.entries()].sort((a, b) => a[1].localeCompare(b[1], locale()));
  const grid = h("div", { class: "grid-wrap" }, h("table", { class: "grid" },
    h("thead", {}, h("tr", {}, h("th", {}, ""), days.map((d) =>
      h("th", { class: d === today ? "today" : "" }, fmt(d, { weekday: "short", day: "numeric", month: "short" }))))),
    h("tbody", {}, rows.length ? rows.map(([id, name]) =>
      h("tr", {}, h("td", { class: "name" }, name), days.map((d) =>
        h("td", {},
          data.shifts.filter((s) => s.staff_id === id && dayOf(s.start_at) === d).map((s) => {
            const body = [h("b", {}, range(s).replace(" – ", "–")), ` ${roleName(s)}`];
            return data.editable ? h("button", { class: "shift-chip", type: "button", onClick: () => openEditor(s) }, body) : h("div", { class: "shift-chip" }, body);
          }),
          data.editable ? h("button", { class: "add-cell", type: "button", "aria-label": t("addShift"), onClick: () => openEditor(null, { date: d, staff_id: id }) }, "+") : null))))
      : h("tr", {}, h("td", { colSpan: 8 }, h("div", { class: "empty" }, t("noShiftsWeek")))))));

  $app.replaceChildren(...[controls, status, daytabs, daily, grid, fab].filter(Boolean));
}

// ---------- shift editor ----------
function openShiftModal({ shift, prefill = {}, roster, data }) {
  const dlg = document.getElementById("modal");
  const sel = state.sel;
  const rolesById = new Map(state.roles.map((r) => [r.id, r]));
  const deptRoles = state.roles.filter((r) => r.department_id === sel.department);
  const initial = shift
    ? { staff_id: shift.staff_id, role_id: shift.role_id, date: dayOf(shift.start_at), start: hhmm(shift.start_at), end: hhmm(shift.end_at), notes: shift.notes ?? "", until_close: !!shift.until_close }
    : { staff_id: prefill.staff_id ?? roster[0]?.staff_id, role_id: null, date: prefill.date ?? sel.day, start: "11:00", end: "17:00", notes: "", until_close: false };

  const staffSel = h("select", { required: true }, roster.map((r) => h("option", { value: r.staff_id, selected: r.staff_id === initial.staff_id }, r.name)));
  const roleSel = h("select", { required: true });
  const fillRoles = () => {
    const person = roster.find((r) => r.staff_id === Number(staffSel.value));
    const ids = person?.role_ids ?? [];
    const keep = Number(roleSel.value) || initial.role_id;
    roleSel.replaceChildren(...deptRoles.filter((r) => ids.includes(r.id)).map((r) =>
      h("option", { value: r.id, selected: r.id === keep }, roleName(r))));
  };
  staffSel.addEventListener("change", fillRoles);
  fillRoles();
  const date = h("input", { type: "date", value: initial.date, required: true });
  const start = h("input", { type: "time", value: initial.start, required: true });
  const end = h("input", { type: "time", value: initial.end, required: true });
  const notes = h("textarea", { value: initial.notes, maxLength: 200 });
  const untilClose = h("input", { type: "checkbox", checked: initial.until_close });
  const alertBox = h("div");
  const nextDay = h("span", { class: "meta" });
  const syncNext = () => {
    end.disabled = untilClose.checked;
    nextDay.textContent = !untilClose.checked && end.value && start.value && end.value <= start.value ? t("nextDay") : "";
  };
  start.addEventListener("input", syncNext); end.addEventListener("input", syncNext); untilClose.addEventListener("change", syncNext); syncNext();

  const payload = (force) => {
    const endTime = untilClose.checked ? DEFAULT_CLOSE : end.value;
    const endDate = endTime <= start.value ? addDays(date.value, 1) : date.value;
    return {
      staff_id: Number(staffSel.value), restaurant_id: sel.restaurant, role_id: Number(roleSel.value),
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
      } else alertBox.replaceChildren(h("div", { class: "alert", role: "alert" }, errorText(e)));
    }
  };
  const del = async () => {
    if (!confirm(t("confirmDelete"))) return;
    try { await api(`/shifts/${shift.id}`, { method: "DELETE" }); dlg.close(); render(); } catch (e) { alertBox.replaceChildren(h("div", { class: "alert" }, errorText(e))); }
  };

  const form = h("form", { class: "modal-body", method: "dialog", onSubmit: (e) => { e.preventDefault(); save(false); } },
    h("h2", {}, shift ? t("editShift") : t("addShift")),
    h("label", { class: "field" }, h("span", {}, t("employee")), staffSel),
    h("label", { class: "field" }, h("span", {}, t("role")), roleSel),
    h("label", { class: "field" }, h("span", {}, t("date")), date),
    h("div", { class: "row2" }, h("label", { class: "field" }, h("span", {}, t("start")), start), h("label", { class: "field" }, h("span", {}, t("end")), end, nextDay)),
    h("label", { class: "check" }, untilClose, t("untilClose")),
    h("label", { class: "field" }, h("span", {}, t("notes")), notes),
    alertBox,
    h("div", { class: "actions" },
      shift ? h("button", { class: "btn danger", type: "button", onClick: del }, t("delete")) : null,
      h("button", { class: "btn", type: "button", onClick: () => dlg.close() }, t("cancel")),
      h("button", { class: "btn primary", type: "submit" }, t("save"))));
  dlg.replaceChildren(form);
  dlg.showModal();
}

// ---------- my shifts ----------
async function renderMine() {
  const sel = state.sel;
  const data = await api(`/my-shifts?week=${sel.week}`);
  const nav = h("div", { class: "weeknav", style: "margin-bottom:1rem" },
    h("button", { class: "icon-btn", type: "button", "aria-label": t("prev"), onClick: () => { sel.week = addDays(sel.week, -7); render(); } }, "‹"),
    h("div", { class: "label" }, weekLabel(sel.week)),
    h("button", { class: "icon-btn", type: "button", "aria-label": t("next"), onClick: () => { sel.week = addDays(sel.week, 7); render(); } }, "›"));
  const days = Array.from({ length: 7 }, (_, i) => addDays(sel.week, i)).filter((d) => data.shifts.some((s) => dayOf(s.start_at) === d));
  const body = days.length
    ? days.map((d) => h("section", {}, h("h2", {}, fmt(d, { weekday: "long", day: "numeric", month: "long" })),
        h("div", { class: "list", style: "margin-bottom:1rem" }, data.shifts.filter((s) => dayOf(s.start_at) === d).map((s) =>
          h("div", { class: "card" }, h("span", { class: "time" }, range(s)),
            h("span", { class: "who" }, `${s.restaurant} · ${t(`dept.${s.department_id}`)}`),
            h("span", { class: "meta" }, [roleName(s), s.notes].filter(Boolean).join(" · ")))))))
    : [h("div", { class: "empty" }, t("noShiftsWeek"))];
  $app.replaceChildren(nav, ...body);
}

// ---------- admin ----------
async function renderAdmin() {
  const ov = await api("/admin/overview");
  const rest = h("section", { class: "panel" }, h("h2", {}, t("restaurants")),
    h("p", {}, ov.restaurants.map((r) => h("span", { class: "badge", style: "margin-right:.4rem" }, r.name))),
    (() => {
      const name = h("input", { required: true, maxLength: 80 });
      return h("form", { class: "inline-form", onSubmit: async (e) => {
        e.preventDefault();
        try { await api("/restaurants", { method: "POST", body: { name: name.value } }); state.restaurants = await api("/restaurants"); render(); } catch (err) { toast(errorText(err)); }
      } }, h("label", { class: "field" }, h("span", {}, t("addRestaurant")), name), h("span"), h("button", { class: "btn primary", type: "submit" }, t("add")));
    })());

  const addStaff = (() => {
    const name = h("input", { required: true, maxLength: 80 });
    const email = h("input", { type: "email" });
    return h("form", { class: "inline-form", onSubmit: async (e) => {
      e.preventDefault();
      try { await api("/staff", { method: "POST", body: { name: name.value, email: email.value || undefined } }); render(); } catch (err) { toast(errorText(err)); }
    } }, h("label", { class: "field" }, h("span", {}, t("name")), name), h("label", { class: "field" }, h("span", {}, t("email")), email),
    h("button", { class: "btn primary", type: "submit" }, t("add")));
  })();
  const staffPanel = h("section", { class: "panel" }, h("h2", {}, t("staff")), addStaff);

  const staffList = ov.staff.length ? ov.staff.map((s) => staffCard(s, ov)) : [h("div", { class: "empty" }, t("noStaff"))];
  $app.replaceChildren(rest, staffPanel, ...staffList);
}

function staffCard(s, ov) {
  const name = h("input", { value: s.name, required: true });
  const email = h("input", { type: "email", value: s.email ?? "" });
  const phone = h("input", { type: "tel", value: s.phone ?? "" });
  const lang = h("select", {}, ["fr", "en"].map((l) => h("option", { value: l, selected: s.lang === l }, l === "fr" ? "Français" : "English")));
  const channel = h("select", {}, [["sms", t("sms")], ["email", t("emailCh")]].map(([v, l]) => h("option", { value: v, selected: s.notify_channel === v }, l)));
  const details = h("form", { class: "inline-form", style: "grid-template-columns:1fr", onSubmit: async (e) => {
    e.preventDefault();
    try { await api(`/staff/${s.id}`, { method: "PUT", body: { name: name.value, email: email.value, phone: phone.value, lang: lang.value, notify_channel: channel.value } }); toast(t("saved")); } catch (err) { toast(errorText(err)); }
  } },
    h("label", { class: "field" }, h("span", {}, t("name")), name), h("label", { class: "field" }, h("span", {}, t("email")), email),
    h("label", { class: "field" }, h("span", {}, t("phone")), phone), h("label", { class: "field" }, h("span", {}, t("language")), lang),
    h("label", { class: "field" }, h("span", {}, t("notifyBy")), channel), h("button", { class: "btn primary", type: "submit" }, t("save")));

  const toggle = (checked, onOn, onOff) => async (e) => {
    try { await (e.target.checked ? onOn() : onOff()); toast(t("saved")); } catch (err) { e.target.checked = !e.target.checked; toast(errorText(err)); }
  };
  const blocks = ov.restaurants.map((r) => h("div", { class: "resto-block" }, h("h3", {}, r.name),
    DEPTS.map((d) => {
      const dRoles = state.roles.filter((ro) => ro.department_id === d);
      return h("div", {}, h("div", { class: "sub" }, t(`dept.${d}`)),
        h("div", { class: "checks" },
          dRoles.map((ro) => {
            const body = { staff_id: s.id, restaurant_id: r.id, role_id: ro.id };
            const on = s.roles.some((x) => x.restaurant_id === r.id && x.role_id === ro.id);
            return h("label", { class: "check" }, h("input", { type: "checkbox", checked: on, onChange: toggle(on,
              () => api("/staff-roles", { method: "POST", body }), () => api("/staff-roles", { method: "DELETE", body })) }), roleName(ro));
          }),
          (() => {
            const body = { staff_id: s.id, restaurant_id: r.id, department_id: d };
            const on = s.managers.some((x) => x.restaurant_id === r.id && x.department_id === d);
            return h("label", { class: "check", style: "border-color:var(--brand)" }, h("input", { type: "checkbox", checked: on, onChange: toggle(on,
              () => api("/managers", { method: "POST", body }), () => api("/managers", { method: "DELETE", body })) }), `★ ${t("managerOf")}`);
          })()));
    })));

  return h("details", { class: "staff" },
    h("summary", {}, h("span", {}, s.name), s.is_admin ? h("span", { class: "badge" }, t("admin_flag")) : h("span", { class: "meta" }, s.email ?? "")),
    h("div", { class: "staff-body" }, h("h3", {}, t("details")), details, h("h3", {}, t("assignments")), blocks));
}

// ---------- boot ----------
async function boot() {
  try {
    state.me = await api("/me");
  } catch (e) {
    renderChrome();
    $app.replaceChildren(h("div", { class: "empty" }, h("h2", {}, t("noAccessTitle")), t("noAccessBody")));
    return;
  }
  [state.restaurants, state.roles] = await Promise.all([api("/restaurants"), api("/roles")]);
  render();
}
boot();
