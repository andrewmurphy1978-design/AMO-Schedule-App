import { splitName, joinName, shortNames, orderStaff } from "./names.js";
import { t, getLang, setLang, locale, roleName, roleIcon, deptIcon } from "./i18n.js";
import { postGaps, hoursFor, DEFAULT_BOUNDARIES, GRID_KEYS, toMin, fromMin, shiftSpan, resolveTargets, targetWindows, targetAt, coverage, shortages, surpluses } from "./coverage.js";
import { resolveForDate, ruleMatches, SPECIAL_PRESETS, SEASON_PRESETS, holidaysOn } from "./rules.js";
import { staffColor, textOn, SWATCHES, setStaffOrder } from "./colors.js";

// ---------- helpers ----------
// "+18194297404" / "819-429-7404" -> "+1 (819) 429-7404" (North American numbers); anything else is left as typed.
function formatPhone(v) {
  const d = String(v ?? "").replace(/\D/g, "");
  const n = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
  return n.length === 10 ? `+1 (${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : String(v ?? "");
}
// A group of radio buttons whose .value works like a select's.
function radioGroup(name, options, current) {
  const el = h("div", { class: "radio-group", role: "radiogroup" }, options.map(([v, label]) =>
    h("label", { class: "radio" }, h("input", { type: "radio", name, value: v, checked: String(current ?? "") === String(v) }), h("span", {}, label))));
  Object.defineProperty(el, "value", { get: () => el.querySelector("input:checked")?.value ?? "" });
  return el;
}
// Date field: shows "25 octobre 2026" / "October 25, 2026" when idle and becomes a real date picker while it has focus.
// .value stays the ISO "YYYY-MM-DD" string.
function enhanceDateInput(el) {
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  let iso = "";
  const show = () => { el.type = "text"; proto.set.call(el, iso ? fmt(iso, { day: "numeric", month: "long", year: "numeric" }) : ""); };
  Object.defineProperty(el, "value", { get: () => iso, set: (v) => { iso = v || ""; if (el.type === "date") proto.set.call(el, iso); else show(); }, configurable: true });
  el.addEventListener("focus", () => { if (el.type === "date") return; el.type = "date"; proto.set.call(el, iso); try { el.showPicker?.(); } catch {} });
  el.addEventListener("change", () => { if (el.type === "date") iso = proto.get.call(el); });
  el.addEventListener("blur", () => { if (el.type === "date") { iso = proto.get.call(el); show(); } });
  el.setAttribute("autocomplete", "off");
  show();
}
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  if (tag === "input" && attrs?.type === "date") { attrs = { ...attrs }; delete attrs.type; enhanceDateInput(el); }
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
// A platform owner can work inside another client: every request then carries that client's id.
const clientHeader = () => { try { const v = localStorage.getItem("workClient"); return v ? { "X-Client": v } : {}; } catch { return {}; } };
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? "GET",
    headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...clientHeader() },
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
// Hours of one date: the weekly hours unless the day is closed or has special hours.
const hoursOn = (restaurantId, day) => {
  const r = state.restaurants.find((x) => x.id === restaurantId), dow = dowOf(day);
  return hoursFor(r?.special_hours, day, openOf(restaurantId, dow), closeOf(restaurantId, dow));
};
const openOf = (restaurantId, dow) => { const r = state.restaurants.find((x) => x.id === restaurantId); return r?.open_by_dow?.[dow] ?? r?.open_time ?? "07:00"; };
const range = (s) => `${hhmm(s.start_at)} – ${s.until_close ? "F" : hhmm(s.end_at)}`;
const dayOf = (iso) => iso.slice(0, 10);
const longDate = (s) => fmt(s, { day: "numeric", month: "long", year: "numeric" });
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
  const key = map[e?.body?.error];
  // Unknown failures name their code so they can be traced.
  return key ? t(key) : `${t("genericError")} (${e?.body?.error ?? e?.status ?? "network"})`;
}

// ---------- state ----------
const state = {
  me: null, restaurants: [], roles: [], posts: [], view: window.matchMedia("(min-width: 900px)").matches ? "schedule" : "mine",
  sel: { restaurant: null, department: null, departments: [], week: mondayOf(new Date()), day: ymd(new Date()) },
};

const DEPTS = ["floor", "kitchen", "prep", "delivery", "admin"];
state.zoomDay = null; // desktop coverage: a single day shown large (set by clicking a day header)
state.notifyOnPublish = (() => { try { return localStorage.getItem("notifyOnPublish") !== "0"; } catch { return true; } })();
state.scheduleTab = (() => { try { return localStorage.getItem("scheduleTab") || "coverage"; } catch { return "coverage"; } })();
state.tableOrder = (() => { try { return localStorage.getItem("tableOrder") || "alpha"; } catch { return "alpha"; } })();
state.showHourlyCost = (() => { try { return localStorage.getItem("hourlyCost") === "1"; } catch { return false; } })();

function allowedDepartments(restaurantId) {
  const { me, roles } = state.me ? { me: state.me.me, roles: state.me } : {};
  if (!me) return [];
  if (me.is_admin) return DEPTS;
  const set = new Set();
  for (const m of state.me.managed) if (m.restaurant_id === restaurantId) set.add(m.department_id);
  // the server decides which schedules this person may look at (their roles, or the list an administrator ticked)
  if (state.me.schedules) for (const x of state.me.schedules) { if (x.restaurant_id === restaurantId) set.add(x.department_id); }
  else for (const r of state.me.roles) if (r.restaurant_id === restaurantId) set.add(r.department_id);
  return DEPTS.filter((d) => set.has(d));
}

// ---------- shell ----------
const $app = document.getElementById("app");

function renderClientBanner() {
  const bar = document.getElementById("client-bar");
  let work = null; try { work = localStorage.getItem("workClient"); } catch {}
  if (!(state.me?.me.is_super && work && state.me.client && String(state.me.client.id) === work)) { bar?.remove(); return; }
  const el = bar ?? h("div", { id: "client-bar", class: "client-bar" });
  if (!bar) document.querySelector(".topbar").after(el);
  el.replaceChildren(h("span", {}, `${t("clientEditing")} `), h("b", {}, state.me.client.name), h("button", { class: "btn", type: "button", onClick: () => { try { localStorage.removeItem("workClient"); } catch {} location.reload(); } }, t("clientBack")));
}

// Icons of the main tabs (shown alone on a phone so that every tab fits).
const TAB_ICONS = { schedule: "📋", mine: "🕐", community: "💬", account: "👤", admin: "⚙️" };
function renderChrome() {
  renderClientBanner();
  fsLabel();
  document.getElementById("lang-toggle").textContent = mqDesktop.matches ? (getLang() === "fr" ? "English" : "Français") : (getLang() === "fr" ? "EN" : "FR");
  document.title = `${state.brand.name} · ${t("app")}`;
  // Desktop is for managing the schedule; on a phone people mostly look at their own shifts, so that comes first.
  const tabs = mqDesktop.matches
    ? [["schedule", t("schedule")], ["mine", t("myShifts")], ["community", t("community")], ["account", t("account")]]
    : [["mine", t("myShifts")], ["schedule", t("schedule")], ["community", t("community")], ["account", t("account")]];
  if (state.me?.me.is_admin) tabs.push(["admin", t("admin")]);
  const nav = document.getElementById("main-tabs");
  nav.replaceChildren(
    ...tabs.map(([id, label]) =>
      h("button", { type: "button", "aria-label": label, title: label, "aria-current": state.view === id ? "page" : false, onClick: () => { state.view = id; render(); } },
        h("span", { class: "tab-ic", "aria-hidden": "true" }, TAB_ICONS[id] ?? "•"), h("span", { class: "tab-tx" }, label),
        id === "community" && (state.communityUnread ?? 0) > 0 ? h("span", { class: "nav-badge", "aria-label": `${state.communityUnread} ${t("newPosts")}` }, String(state.communityUnread)) : null)),
  );
}

async function render() {
  renderChrome();
  try {
    setStaffOrder(await api("/staff-order").catch(() => []));
    // Roles and manager scopes can change in Administration at any time, so never trust the copy loaded at start-up.
    if (state.view !== "admin") {
      let comm;
      [state.me, state.restaurants, comm] = await Promise.all([api("/me"), api("/restaurants"), api("/communities").catch(() => [])]);
      state.communityUnread = comm.reduce((n, x) => n + (x.unread || 0), 0);
      renderChrome();
    }
    if (state.view === "schedule") await renderSchedule();
    else if (state.view === "mine") await renderMine();
    else if (state.view === "timeoff") { state.view = "account"; state.accountTab = "timeoff"; await renderAccount(); }
    else if (state.view === "community") await renderCommunity();
    else if (state.view === "account") await renderAccount();
    else await renderAdmin();
  } catch (e) {
    if (e.status === 401) { state.me = null; renderLogin(); return; } // session expired
    console.error("render failed:", e);
    $app.replaceChildren(h("div", { class: "empty" }, errorText(e)));
  }
}

// Full screen (desktop header button).
const fsBtn = document.getElementById("fs-toggle");
const fsLabel = () => { if (fsBtn) fsBtn.textContent = document.fullscreenElement ? `⤢ ${t("exitFullscreen")}` : `⛶ ${t("fullscreen")}`; };
if (fsBtn) {
  if (!document.fullscreenEnabled) fsBtn.hidden = true;
  fsBtn.addEventListener("click", () => { (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}); });
  document.addEventListener("fullscreenchange", fsLabel);
}

document.getElementById("lang-toggle").addEventListener("click", () => {
  setLang(getLang() === "fr" ? "en" : "fr");
  if (!state.me) { renderChrome(); renderLogin(); return; }
  render();
});

// A small confirmation screen (yes / no) that resolves true or false.
function confirmDialog({ title, message, yes, no, lines }) {
  return new Promise((resolve) => {
    // its own dialog, so it can open on top of another dialog without replacing its content
    let dlg = document.getElementById("confirm-modal");
    if (!dlg) { dlg = h("dialog", { id: "confirm-modal" }); document.body.append(dlg); }
    let answered = false;
    const answer = (v) => { if (answered) return; answered = true; resolve(v); dlg.close(); };
    dlg.replaceChildren(h("div", { class: "modal-body" },
      h("h2", {}, title), h("p", {}, message), lines?.length ? h("ul", { class: "dlg-lines" }, lines.slice(0, 12).map((l) => h("li", {}, l)), lines.length > 12 ? h("li", {}, `… +${lines.length - 12}`) : null) : null,
      h("div", { class: "actions" }, no ? h("button", { class: "btn", type: "button", onClick: () => answer(false) }, no) : null, h("button", { class: "btn primary", type: "button", onClick: () => answer(true) }, yes))));
    dlg.addEventListener("close", () => { if (!answered) { answered = true; resolve(false); } }, { once: true });
    dlg.showModal();
  });
}

// Simple yes/no question in the app's own dialog (never the browser's, which would show the web address).
const ask = (message, yes) => confirmDialog({ title: t("confirmTitle"), message, yes: yes ?? t("confirmYes"), no: t("cancel") });

// A short text question in the app's own dialog; resolves to the text, or null when cancelled.
function promptDialog({ title, label, yes }) {
  return new Promise((resolve) => {
    let dlg = document.getElementById("prompt-modal");
    if (!dlg) { dlg = h("dialog", { id: "prompt-modal" }); document.body.append(dlg); }
    let done = false; const finish = (v) => { if (done) return; done = true; resolve(v); dlg.close(); };
    const input = h("input", { maxLength: 300, autocomplete: "off", "aria-label": label });
    dlg.replaceChildren(h("form", { class: "modal-body", onSubmit: (e) => { e.preventDefault(); finish(input.value); } },
      h("h2", {}, title), h("label", { class: "field" }, h("span", {}, label), input),
      h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: () => finish(null) }, t("cancel")), h("button", { class: "btn primary", type: "submit" }, yes ?? t("confirmYes")))));
    dlg.addEventListener("close", () => { if (!done) { done = true; resolve(null); } }, { once: true });
    dlg.showModal(); input.focus();
  });
}

// "Je serai absent": the employee picks a reason (only managers see it). Resolves to { reason, note } or null.
const ABSENCE_REASONS = ["sick", "medical", "family", "transport", "personal", "other"];
function absenceDialog({ forOther = false } = {}) {
  return new Promise((resolve) => {
    let dlg = document.getElementById("absence-modal");
    if (!dlg) { dlg = h("dialog", { id: "absence-modal" }); document.body.append(dlg); }
    let done = false; const finish = (v) => { if (done) return; done = true; resolve(v); dlg.close(); };
    let reason = null;
    const note = h("input", { maxLength: 200, placeholder: t("absenceNote"), "aria-label": t("absenceNote") });
    const go = h("button", { class: "btn primary", type: "button", disabled: true, onClick: () => finish({ reason, note: note.value.trim() }) }, t("absenceConfirm"));
    const cancel = h("button", { class: "btn", type: "button", onClick: () => finish(null) }, t("cancel"));
    const desktop = mqDesktop.matches; // desktop: the buttons sit in the red header, like the other dialogs
    const list = h("div", { class: "reason-list", role: "radiogroup", "aria-label": t("absenceReason") }, ABSENCE_REASONS.map((r) =>
      h("label", { class: "reason" }, h("input", { type: "radio", name: "absence-reason", value: r, onChange: () => { reason = r; go.disabled = false; } }), h("span", {}, t(`reason.${r}`)))));
    const title = forOther ? t("reportAbsent") : t("imAbsent");
    dlg.replaceChildren(h("div", { class: `modal-body ${desktop ? "staff-dialog" : ""}` },
      desktop ? h("div", { class: "dlg-top" }, h("div", { class: "dlg-head" }, h("h2", {}, title), h("div", { class: "dlg-actions" }, cancel, go))) : h("h2", {}, title),
      h("p", { class: "meta" }, t("absenceHelp")), list, note,
      desktop ? null : h("div", { class: "actions" }, cancel, go)));
    dlg.addEventListener("close", () => { if (!done) { done = true; resolve(null); } }, { once: true });
    dlg.showModal();
  });
}

// ---------- schedule ----------
// Long last names are folded so the name column stays narrow: a break opportunity after every 9 letters of a long word
// ("Constantineau" -> "Constanti / neau"); hyphens and spaces already break lines ("Douville- / Bondu").
const foldLast = (last) => last.split(/(?<=[-\s])/).map((seg) => (seg.length > 9 ? seg.match(/.{1,9}/gs).join("\u200b") : seg)).join("");
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
// Different roles by hour (Prep 10:30-11, Delivery + Dish 11-14, Cook 14-19:30): the shift is cut into slices, each with its own roles.
function shiftSlices(s) {
  const base = shiftRoles(s);
  const segs = s.segments ?? [];
  if (!segs.length) return [{ a: s.start_at, b: s.end_at, roles: base, custom: false }];
  const pts = [...new Set([s.start_at, s.end_at, ...segs.flatMap((g) => [g.start_at, g.end_at])])].filter((x) => x >= s.start_at && x <= s.end_at).sort();
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const seg = segs.find((g) => g.start_at <= pts[i] && pts[i + 1] <= g.end_at);
    out.push({ a: pts[i], b: pts[i + 1], roles: seg ? seg.roles.map((r) => ({ ...r, sex: s.sex })) : base, custom: !!seg });
  }
  return out;
}
const roleText = (roles) => roles.map((r) => roleName(r) + (r.no_count ? "*" : "")).join(" + ");
const shiftRoleLabel = (s) => (s.segments?.length ? shiftSlices(s).map((sl) => `${hhmm(sl.a)}–${hhmm(sl.b)} ${roleText(sl.roles)}`).join(" · ") : roleText(shiftRoles(s)));
const shiftRoleIcons = (s) => [...new Set((s.segments?.length ? shiftSlices(s).flatMap((sl) => sl.roles) : shiftRoles(s)).map(roleIcon))].join("");
// One line per time range when the roles change during the shift, otherwise a single label.
const roleLines = (s) => (s.segments?.length ? shiftSlices(s).map((sl) => h("div", { class: "seg-line", title: roleText(sl.roles) }, `${hhmm(sl.a)}–${hhmm(sl.b)} ${sl.roles.map(roleIcon).join("")}`)) : [h("span", { class: "role-label" }, shiftRoleLabel(s))]);
// Overlapping shifts of the same person (here or at another restaurant/department) are shown in red.
function conflictSets(data) {
  const byPerson = new Map();
  const add = (kind, key, x) => { if (x.status && x.status !== "ok") return; const l = byPerson.get(x.staff_id) ?? []; l.push({ kind, key, a: x.start_at, b: x.end_at }); byPerson.set(x.staff_id, l); };
  for (const x of data.shifts) add("shift", x.id, x);
  (data.elsewhere ?? []).forEach((x, i) => add("else", i, x));
  const shifts = new Set(), elsewhere = new Set();
  for (const list of byPerson.values())
    for (const x of list) if (list.some((y) => y !== x && x.a < y.b && y.a < x.b)) (x.kind === "shift" ? shifts : elsewhere).add(x.key);
  return { shifts, elsewhere };
}
const nowLocal = () => { const d = new Date(); return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// Open replacement requests (managers/admins): who was asked, assign by hand, cancel.
function coveragePanel(onChange) {
  const box = h("section", { class: "panel coverage-panel", hidden: true });
  api("/coverage").then((rows) => {
    const open = rows.filter((r) => r.status === "open"), recent = rows.filter((r) => r.status !== "open").slice(0, 5);
    if (!open.length && !recent.length) return;
    box.hidden = false;
    const line = (r) => h("div", { class: `cov-row ${r.status}` },
      h("div", {}, h("b", {}, `${r.sick_name}`), ` · ${roleName(r)} · ${r.restaurant}`, r.reason ? h("div", { class: "meta" }, `${t("reasonLabel")} : ${t(`reason.${r.reason}`)}${r.reason_note ? ` — ${r.reason_note}` : ""}`) : null, h("div", { class: "meta" }, `${fmt(r.start_at.slice(0, 10), { weekday: "short", day: "numeric", month: "short" })} ${hhmm(r.start_at)}–${r.until_close ? "F" : hhmm(r.end_at)}`)),
      h("div", { class: "meta" }, r.status === "open" ? `${t("asked")}: ${r.offers} · ${t("waiting")}: ${r.waiting} · ${t("declined")}: ${r.declined}${r.escalated_at ? ` · ⚠ ${t("actionRequired")}` : ""}`
        : r.status === "filled" ? `✔ ${t("filledBy")} ${r.filled_by_name ?? ""}` : t("cancelled")),
      r.status === "open" ? h("div", { class: "actions" },
        h("button", { class: "btn primary", type: "button", onClick: () => assignDialog(r, onChange) }, t("assignManually")),
        h("button", { class: "btn danger", type: "button", onClick: async () => { if ((await ask(t("confirmCancelSick")))) { try { await api(`/coverage/${r.id}/cancel`, { method: "POST" }); onChange(); } catch (e) { toast(errorText(e)); } } } }, t("cancelSick"))) : null);
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
  const skills = Object.assign({}, ...datas.map((d) => d.skills ?? {}));
  const delivery_presence = datas.flatMap((d) => d.delivery_presence ?? []);
  return { ...datas[0], editable: datas.some((d) => d.editable), shifts, hours, elsewhere, time_off, days_off, skills, any_skills: datas.some((d) => d.any_skills), delivery_presence, limits: { ...datas[0].limits, by_staff } };
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
  data.conflicts = conflictSets(data);
  const days = Array.from({ length: 7 }, (_, i) => addDays(sel.week, i));
  if (state.zoomDay && !days.includes(state.zoomDay)) state.zoomDay = null;
  if (!days.includes(sel.day)) sel.day = days.includes(ymd(new Date())) ? ymd(new Date()) : days[0];
  const today = ymd(new Date());

  // The table order and Print/PDF live in the publish bar below the sticky line.
  const orderField = h("label", { class: "field desktop-only order-field" },
      h("select", { "aria-label": t("tableOrder"), title: t("tableOrder"), onChange: (e) => { state.tableOrder = e.target.value; try { localStorage.setItem("tableOrder", state.tableOrder); } catch { /* ignore */ } render(); } },
        [["alpha", t("orderAlpha")], ["arrival", t("orderArrival")], ["custom", t("orderCustom")]].map(([v, l]) => h("option", { value: v, selected: state.tableOrder === v, title: l }, l))));
  const printField = h("div", { class: "field desktop-only" }, h("span", {}, " "),
      h("button", { class: "btn", type: "button", title: t("printHint"), onClick: async () => {
        // the printout is the table: show it for printing, then go back to the tab you were on
        const prev = state.scheduleTab;
        if (prev !== "table") { state.scheduleTab = "table"; await render(); }
        window.addEventListener("afterprint", () => { if (state.scheduleTab !== prev) { state.scheduleTab = prev; render(); } }, { once: true });
        setTimeout(() => window.print(), 150);
      } }, `🖨 ${t("printSchedule")}`));
  const controls = h("div", { class: "controls" },
    h("div", { class: "field" }, h("span", {}, t("restaurant")), restaurantSelect({ list: options, value: sel.restaurant, onChange: (id) => { sel.restaurant = id; render(); } })),
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
    state.me.me.is_admin ? h("div", { class: "field desktop-only" }, h("span", {}, " "),
      h("button", { class: "btn", type: "button", title: t("aiTitle"), onClick: () => aiScheduleDialog({ restaurantId: sel.restaurant, departments: [...sel.departments], currentWeek: sel.week }) }, `✨ ${t("aiButton")}`)) : null,

  );
  // Only shown on paper: a title above the week table so the printed/PDF schedule can be posted in the restaurant.
  const printHead = h("div", { class: "print-head" },
    h("img", { src: "logo.png", alt: "Mikes", height: 48, onerror: (e) => e.target.remove() }),
    h("div", {}, h("h1", {}, `${options.find((r) => r.id === sel.restaurant)?.name ?? ""} — ${sel.departments.map((d) => t(`dept.${d}`)).join(" · ")}`), h("p", {}, weekLabel(sel.week))));

  const status = h("p", { class: "status-line" }, h("span", { class: `badge ${data.editable ? "edit" : ""}` }, data.editable ? t("canEdit") : t("viewOnly")));
  const byDay = (d) => data.shifts.filter((s) => dayOf(s.start_at) === d);
  // Changing a schedule that employees can already see: ask once per schedule (until the page is reloaded).
  state.ackPublished ??= new Set();
  const openEditor = async (shift, prefill) => {
    const involved = shift?.department_id ? [shift.department_id] : sel.departments;
    const pending = involved.filter((d) => datas[depts.indexOf(d)]?.published && !state.ackPublished.has(`${sel.restaurant}|${d}|${sel.week}`));
    if (pending.length) {
      if (!(await confirmDialog({ title: t("publishedChangeTitle"), message: t("publishedChangeAsk"), yes: t("changeAnyway"), no: t("cancel") }))) return;
      pending.forEach((d) => state.ackPublished.add(`${sel.restaurant}|${d}|${sel.week}`));
    }
    openShiftModal({ shift, prefill, roster, data });
  };

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
            sickDay ? h("span", { class: "sick-badge" }, `🚫 ${t("sickOpen")}`) : null,
            s.replaced_name ? h("span", { class: "replaced" }, `${t("replacing")} ${s.replaced_name}`) : null];
          const cls = `card ${sickDay ? "sick" : ""} ${data.conflicts.shifts.has(s.id) ? "conflict" : ""}`;
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
  // Row order: alphabetical, by usual arrival time (who opens most often comes first), or by the position set on each employee.
  const orderInfo = new Map();
  for (const r of roster) orderInfo.set(r.staff_id, r.print_order ?? null);
  for (const sh of data.shifts) orderInfo.set(sh.staff_id, sh.print_order ?? orderInfo.get(sh.staff_id) ?? null);
  const orderedIds = orderStaff([...people.entries()].map(([id, name]) => ({ id, name, print_order: orderInfo.get(id) ?? null })), data.shifts.filter((x) => x.status !== "sick_open"), state.tableOrder, (a, b) => a.localeCompare(b, locale()));
  // When Plonge/Préparation is shown together with other departments, its staff go to the bottom of the table.
  const rosterRoles = new Map(roster.map((r) => [r.staff_id, r.role_ids ?? []]));
  const prepOnly = (id) => {
    const mine = data.shifts.filter((x) => x.staff_id === id);
    if (mine.length) return mine.every((x) => x.department_id === "prep" && (x.extra_roles ?? []).every((r) => r.department_id === "prep"));
    const ids = rosterRoles.get(id) ?? [];
    return ids.length > 0 && ids.every((rid) => state.roles.find((r) => r.id === rid)?.department_id === "prep");
  };
  const mixed = sel.departments.includes("prep") && sel.departments.length > 1;
  const rows = [...orderedIds.filter((id) => !(mixed && prepOnly(id))), ...orderedIds.filter((id) => mixed && prepOnly(id))].map((id) => [id, people.get(id)]);
  const limit = data.limits?.overtime_hours ?? 40;
  const offAt = (id, d) => (data.time_off ?? []).find((o) => o.staff_id === id && o.start_date <= d && o.end_date >= d);
  const offChip = (o) => h("div", { class: `off-chip ${o.status}`, title: o.status === "approved" ? t("offApproved") : t("offRequested") }, `${o.status === "approved" ? "C/A" : "C/D"}${o.start_time ? ` ${o.start_time.replace(/^0/, "").replace(":00", "")}–${o.end_time.replace(/^0/, "").replace(":00", "")}` : ""}`);
  const elsewhereAt = (id, d) => (data.elsewhere ?? []).filter((e) => e.staff_id === id && dayOf(e.start_at) === d);
  // "Saint-Sauveur" -> "St-Sauveur", "Ste-Agathe-des-Monts" -> "Ste-Agathe"
  const shortResto = (n) => n.replace(/^Saint-/, "St-").split(/-des-|\sdes\s/)[0];
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
        h("button", { type: "button", class: "th-zoom screen-only", title: t("zoomDay"), "aria-label": `${t("zoomDay")}: ${fmt(d, { weekday: "long", day: "numeric", month: "long" })}`, onClick: () => zoomTo(d) },
          fmt(d, { weekday: "short", day: "numeric", month: "short" })),
        // paper: plain text, because buttons are not drawn in the header repeated on the next page
        h("span", { class: "print-only print-date" }, fmt(d, { weekday: "short", day: "numeric", month: "short" })))), data.hours ? h("th", { class: "total" }, t("total")) : null)),
    h("tbody", {}, rows.length ? rows.map(([id, name]) =>
      h("tr", { class: data.shifts.some((s) => s.staff_id === id) || (data.elsewhere ?? []).some((e) => e.staff_id === id) ? "" : "noshift" }, h("td", { class: "name", title: name }, avatar(id, name, meta.get(id)?.color, meta.get(id)?.photo_v, 36),
        h("span", { class: "name2" }, h("span", { class: "n1" }, parts.get(id)?.first ?? name), parts.get(id)?.last ? h("span", { class: "n2" }, foldLast(parts.get(id).last)) : null)), days.map((d) =>
        h("td", {},
          offAt(id, d) ? offChip(offAt(id, d)) : null,
          (data.days_off?.[id] ?? []).includes((parseYmd(d).getDay() + 6) % 7) ? h("div", { class: "off-chip fixed", title: t("fixedDayOff") }, t("fixedOffShort")) : null,
          data.shifts.filter((s) => s.staff_id === id && dayOf(s.start_at) === d).map((s) => {
            const sick = s.status === "sick_open";
            const body = [h("b", {}, range(s).replace(" – ", "–")), s.segments?.length ? "" : ` ${shiftRoleIcons(s)} `, ...roleLines(s), sick ? h("span", { class: "sick-badge" }, `🚫 ${t("sickOpen")}`) : null,
              s.replaced_name ? h("span", { class: "replaced" }, `${t("replacing")} ${s.replaced_name}`) : null];
            const c = staffColor(s.staff_id, s.staff_color);
            const style = `border-left-color:${c};background:color-mix(in srgb, ${c} 16%, var(--card))`;
            const cls = `shift-chip ${sick ? "sick" : ""} ${data.conflicts.shifts.has(s.id) ? "conflict" : ""}`;
            return data.editable ? h("button", { class: cls, type: "button", style, onClick: () => openEditor(s) }, body) : h("div", { class: cls, style }, body);
          }),
          // Working somewhere else the same day: shown in grey so you don't double-book by mistake.
          (data.elsewhere ?? []).map((e, i) => [e, i]).filter(([e]) => e.staff_id === id && dayOf(e.start_at) === d).map(([e, i]) => h("div", { class: `elsewhere ${data.conflicts.elsewhere.has(i) ? "conflict" : ""}`, title: `${data.conflicts.elsewhere.has(i) ? `⚠ ${t("conflictWord")} · ` : ""}${t("elsewhere")}: ${hhmm(e.start_at)}–${hhmm(e.end_at)} ${place(e)}` },
            // on screen: times and place; on paper: just the short restaurant name and the role icon ("St-Sauveur 🚗")
            h("span", { class: "screen-only" }, h("b", {}, `↗ ${hhmm(e.start_at)}–${hhmm(e.end_at)}`), ` ${place(e)}`),
            h("span", { class: "print-only" }, `${e.restaurant_id === sel.restaurant ? t(`dept.${e.department_id}`) : shortResto(e.restaurant)} ${roleIcon(e)}`))),
          data.editable ? h("button", { class: "add-cell", type: "button", "aria-label": t("addShift"), onClick: () => openEditor(null, { date: d, staff_id: id }) }, "+") : null)),
        data.hours ? totalCell(id) : null))
      : h("tr", {}, h("td", { colSpan: 9 }, h("div", { class: "empty" }, t("noShiftsWeek")))))));

  const onSummary = state.scheduleTab === "summary" && !!payroll;
  const timeline = onSummary ? null : renderTimeline({ data, days, targets, sets, payroll, openEditor });
  const setTab = (v) => { state.scheduleTab = v; try { localStorage.setItem("scheduleTab", v); } catch { /* ignore */ } render(); };
  if (state.scheduleTab === "summary" && !payroll) state.scheduleTab = "coverage"; // the summary exists for administrators only
  const subtabs = h("div", { class: "subtabs", role: "tablist" },
    ...[...(payroll ? [["summary", t("summaryTab")]] : []), ["coverage", t("coverageTab")], ["table", t("tableTab")]].map(([v, l]) => h("button", { type: "button", role: "tab", "aria-selected": String(state.scheduleTab === v), onClick: () => setTab(v) }, l)), status);
  const onTable = state.scheduleTab === "table";
  // Draft / published: new schedules are seen only by administrators and the managers of the department until published.
  const editableDepts = depts.filter((d, i) => datas[i].editable);
  const draftDepts = editableDepts.filter((d) => !datas[depts.indexOf(d)].published);
  // Publishing is refused while somebody is booked twice; staffing gaps or surpluses only need a confirmation.
  const tryPublish = async () => {
    const conflicts = conflictLines(data);
    if (conflicts.length) { await confirmDialog({ title: t("cannotPublishTitle"), message: t("fixConflictsFirst"), lines: conflicts, yes: t("ok") }); return; }
    const w = renderTimeline({ data, days, targets, sets, payroll, openEditor, weekView: true }).lines;
    if ((w.gapLines.length || w.extraLines.length) && !(await confirmDialog({ title: t("publishBtn"), message: t("publishAnywayStaffing"), yes: t("publishNow"), no: t("cancel") }))) return;
    await setPublished(draftDepts, true);
  };
  const setPublished = async (list, published) => {
    try {
      const results = await Promise.all(list.map((d) => api("/schedule/publish", { method: "POST", body: { restaurant_id: sel.restaurant, department_id: d, week: sel.week, published, notify: state.notifyOnPublish } })));
      const n = results.reduce((a, r) => a + (r.notified ?? 0), 0);
      toast(published ? `${t("publishedToast")}${n ? ` ${n} ${t("employeesNotified")}` : ""}` : t("unpublishedToast")); render();
    } catch (e) { if (e.body?.error === "conflicts") await confirmDialog({ title: t("cannotPublishTitle"), message: t("fixConflictsFirst"), yes: t("ok") }); else toast(errorText(e)); }
  };
  const allDraft = datas.every((d) => !d.published);
  const barText = editableDepts.length
    ? (draftDepts.length ? `📝 ${t("draftState")}${editableDepts.length > 1 ? ` (${draftDepts.map((d) => t(`dept.${d}`)).join(", ")})` : ""} — ${t("draftHelp")}` : `✅ ${t("publishedState")}`)
    : allDraft ? `📝 ${t("notPublishedYet")}` : `✅ ${t("publishedStateEmployee")}`;
  const barButton = editableDepts.length
    ? (draftDepts.length ? h("button", { class: "btn primary", type: "button", onClick: tryPublish }, t("publishBtn"))
        : h("button", { class: "btn", type: "button", onClick: async () => { if (await confirmDialog({ title: t("unpublishBtn"), message: t("unpublishConfirm"), yes: t("unpublishBtn"), no: t("cancel") })) setPublished(editableDepts, false); } }, t("unpublishBtn")))
    : null;
  const publishBar = h("div", { class: `publish-bar ${editableDepts.length ? (draftDepts.length ? "draft" : "live") : allDraft ? "draft" : "live"}` },
    h("span", { class: "pb-text" }, barText), h("div", { class: "pb-tools" },
      draftDepts.length && editableDepts.length ? h("label", { class: "check notify-check" }, h("input", { type: "checkbox", checked: state.notifyOnPublish, onChange: (e) => { state.notifyOnPublish = e.target.checked; try { localStorage.setItem("notifyOnPublish", e.target.checked ? "1" : "0"); } catch { /* ignore */ } } }), h("span", {}, t("notifyEmployees"))) : null,
      barButton, orderField, printField));
  $app.replaceChildren(...[printHead, controls, publishBar, subtabs, data.editable ? coveragePanel(render) : null, weekTimeOffPanel(data), ...(onTable ? [daytabs, daily, grid] : state.scheduleTab === "summary" ? [renderSummary({ days, payroll, sel, data, boxes: renderTimeline({ data, days, targets, sets, payroll, openEditor, weekView: true }).boxes })] : [timeline]), fab].filter(Boolean));
  syncStickyOffsets();
}


// The header, the Restaurant/Department/Week line and the publish bar stay on top while scrolling (desktop):
// each sticks just under the previous one, so their heights are published as CSS variables.
function syncStickyOffsets() {
  const set = () => {
    const root = document.documentElement.style;
    root.setProperty("--topbar-h", `${document.querySelector(".topbar")?.offsetHeight ?? 0}px`);
    root.setProperty("--controls-h", `${document.querySelector(".controls")?.offsetHeight ?? 0}px`);
  };
  set();
  if (!state.stickyObserver && "ResizeObserver" in window) {
    state.stickyObserver = new ResizeObserver(set);
    state.stickyObserver.observe(document.querySelector(".topbar"));
  }
  document.querySelectorAll(".controls").forEach((el) => state.stickyObserver?.observe(el));
}
window.addEventListener("resize", () => { if (document.querySelector(".controls")) syncStickyOffsets(); });

// Zoom the coverage view on one day (desktop) or just select it (phone), then bring it into view.
async function zoomTo(day) {
  state.sel.day = day;
  if (mqDesktop.matches) state.zoomDay = day;
  await render();
  document.querySelector("section.timeline")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Restaurant picker with the franchise logo in front of each name: a real drop-down (not the phone's native list).
const restaurantLogo = (r) => (r?.franchise?.logo ? `/api/restaurants/${r.id}/logo?v=${r.franchise.logo_v}` : state.brand.logo ? `/api/auth/logo?v=${state.brand.logo_v}` : "logo.png");
function restaurantSelect({ list, value, onChange }) {
  const wrap = h("div", { class: "rs" });
  const btn = h("button", { type: "button", class: "rs-btn", "aria-haspopup": "listbox", "aria-expanded": "false" });
  const menu = h("ul", { class: "rs-menu", role: "listbox", hidden: true, tabindex: "-1" });
  let active = Math.max(0, list.findIndex((r) => r.id === value));
  const item = (r) => h("span", { class: "rs-item" }, h("img", { src: restaurantLogo(r), alt: "", width: 24, height: 24 }), h("span", {}, r.name));
  const current = list.find((r) => r.id === value) ?? list[0];
  btn.replaceChildren(current ? item(current) : "—", h("span", { class: "rs-caret", "aria-hidden": "true" }, "▾"));
  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", outside, true); };
  const outside = (e) => { if (!wrap.contains(e.target)) close(); };
  const paint = () => [...menu.children].forEach((li, i) => { li.classList.toggle("active", i === active); li.setAttribute("aria-selected", String(list[i].id === value)); });
  const choose = (i) => { close(); btn.focus(); if (list[i].id !== value) onChange(list[i].id); };
  list.forEach((r, i) => menu.append(h("li", { role: "option", class: "rs-opt", onClick: () => choose(i), onPointerEnter: () => { active = i; paint(); } }, item(r))));
  const open = () => { menu.hidden = false; btn.setAttribute("aria-expanded", "true"); active = Math.max(0, list.findIndex((r) => r.id === value)); paint(); document.addEventListener("pointerdown", outside, true); };
  btn.addEventListener("click", () => (menu.hidden ? open() : close()));
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { close(); return; }
    if (["ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); if (menu.hidden) open(); else { active = (active + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length; paint(); } }
    if (e.key === "Enter" && !menu.hidden) { e.preventDefault(); choose(active); }
  });
  wrap.append(btn, menu);
  return wrap;
}

// ---------- coverage timeline (vertical) ----------
// Staffing targets use fixed 30-minute intervals ("8:00–8:30"); only the ones inside the opening hours are shown.
const boundsOf = () => DEFAULT_BOUNDARIES;
const hm = (x) => x.replace(/^0/, "");
const periodLabel = (_boundaries, key) => `${hm(key)}–${hm(fromMin(toMin(key) + 30))}`;
function hoursSlots(restaurantId, list = state.restaurants) {
  const r = list?.find((x) => x.id === restaurantId);
  if (!r) return GRID_KEYS.filter((k) => toMin(k) >= 360 && toMin(k) < 1380);
  const lo = Math.floor(Math.min(...r.open_by_dow.map(toMin)) / 30) * 30, hi = Math.max(...r.close_by_dow.map(toMin));
  return GRID_KEYS.filter((k) => toMin(k) >= lo && toMin(k) < hi);
}

// Quick edit of a staffing target from the coverage view (administrators): a time range, one number per department, one layer.
function targetDialog({ day, minute, endMinute = minute + 30, dep, deps, targets, sets, onSaved }) {
  const restaurant = state.sel.restaurant;
  const dow = dowOf(day);
  const slots = hoursSlots(restaurant);
  const matching = (kind) => sets.filter((x) => x.kind === kind && ruleMatches(x.rule, day)).sort((x, y) => x.id - y.id);
  const dateSet = sets.find((x) => x.kind === "special" && x.rule.type === "date" && x.rule.date === day);
  // where the values are stored, least to most specific: every weekday, seasons, special days, then only this date
  const layers = [{ id: 0, dow, label: `${t("everyWeekday")} ${weekdayName(dow)}` },
    ...matching("season").map((x) => ({ id: x.id, dow, label: `${t("everyWeekday")} ${weekdayName(dow)} · ${x.name}` })),
    ...matching("special").filter((x) => x !== dateSet).map((x) => ({ id: x.id, dow: -1, label: `${t("onlyThisDay")} · ${x.name}` })),
    { id: dateSet?.id ?? null, dow: -1, create: !dateSet, label: `${t("onlyThis")} ${weekdayName(dow)}` }];
  const key = fromMin(Math.floor(minute / 30) * 30);
  const rangeKeys = GRID_KEYS.filter((k) => toMin(k) >= toMin(key) && toMin(k) < endMinute);
  const current = (d) => resolveForDate(targets.filter((x) => x.department_id === d), sets, day).targets[key];
  // several slots selected: the value is shown when they all agree, otherwise the box stays empty ("mixed") and is left alone
  const valuesIn = (d) => { const all = resolveForDate(targets.filter((x) => x.department_id === d), sets, day).targets; return rangeKeys.map((k) => all[k]); };
  // the most specific layer that defines the value shown
  const sourceOf = (d) => [...layers].reverse().find((l) => l.id !== null && targets.some((x) => x.department_id === d && x.set_id === l.id && x.slot === key && (x.dow === l.dow || x.dow === -1))) ?? layers[0];
  return new Promise((resolve) => {
    let dlg = document.getElementById("target-modal");
    if (!dlg) { dlg = h("dialog", { id: "target-modal" }); document.body.append(dlg); }
    let done = false; const finish = (v) => { if (done) return; done = true; resolve(v); dlg.close(); };
    const fromSel = h("select", { "aria-label": t("from") }, slots.map((k) => h("option", { value: k, selected: k === key }, hm(k))));
    const toSel = h("select", { "aria-label": t("to") }, [...slots.slice(1), fromMin(toMin(slots[slots.length - 1]) + 30)].map((k) => h("option", { value: k, selected: toMin(k) === endMinute }, hm(k))));
    // one number per displayed department (even a single one), the clicked department first
    const order = [dep, ...deps.filter((d) => d !== dep)].filter((d) => deps.includes(d));
    const counts = order.map((d) => {
      const vals = valuesIn(d), same = vals.every((x) => x === vals[0]), v = same ? vals[0] : undefined;
      return { d, v, mixed: !same, input: h("input", { type: "number", min: 0, max: 99, inputMode: "numeric", value: v ?? "", placeholder: same ? "" : "…", "aria-label": `${t(`dept.${d}`)} — ${t("peopleNeeded")}` }) };
    });
    const layerSel = h("select", { "aria-label": t("appliesTo") }, layers.map((l, i) => h("option", { value: i }, l.label)));
    layerSel.value = String(Math.max(...order.map((d) => layers.indexOf(sourceOf(d)))));
    const save = async () => {
      const l = layers[Number(layerSel.value)];
      if (toMin(toSel.value) <= toMin(fromSel.value)) { toast(t("invalidTimes")); return; }
      try {
        let setId = l.id;
        if (l.create) setId = (await api("/target-sets", { method: "POST", body: { restaurant_id: restaurant, name: fmt(day, { weekday: "short", day: "numeric", month: "short", year: "numeric" }), kind: "special", rule: { type: "date", date: day } } })).id;
        for (const c of counts) {
          if (c.input.value === "" && (c.v === undefined || c.mixed)) continue; // nothing there (or mixed values left untouched), nothing entered
          await api("/targets/range", { method: "PUT", body: { restaurant_id: restaurant, department_id: c.d, set_id: setId, dow: l.dow, from: fromSel.value, to: toSel.value, count: c.input.value === "" ? null : Number(c.input.value) } });
        }
        toast(t("saved")); finish(true); onSaved?.();
      } catch (e) { toast(errorText(e)); }
    };
    const title = h("div", {}, h("h2", {}, t("editTarget")), h("span", { class: "meta" }, fmt(day, { weekday: "long", day: "numeric", month: "long" })));
    // sticky header: title and buttons stay in view
    dlg.replaceChildren(h("div", { class: "modal-body target-dialog" },
      h("div", { class: "dlg-top" }, h("div", { class: "dlg-head" }, title,
        h("div", { class: "dlg-actions" }, h("button", { class: "btn", type: "button", onClick: () => finish(false) }, t("cancel")), h("button", { class: "btn primary", type: "button", onClick: save }, t("save"))))),
      h("form", { class: "td-body", onSubmit: (e) => { e.preventDefault(); save(); } },
        h("div", { class: "td-times" }, h("label", { class: "field" }, h("span", {}, t("from")), fromSel), h("label", { class: "field" }, h("span", {}, t("to")), toSel)),
        h("div", { class: "td-depts" }, counts.map((c) => h("label", { class: "td-dept" }, h("span", {}, `${deptIcon(c.d)} ${t(`dept.${c.d}`)}`), c.input))),
        h("label", { class: "field" }, h("span", {}, t("appliesTo")), layerSel),
        h("p", { class: "meta" }, t("clearHint")),
        h("button", { type: "submit", hidden: true }))));
    dlg.addEventListener("close", () => { if (!done) { done = true; resolve(false); } }, { once: true });
    dlg.showModal();
  });
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

// Employees booked twice at the same time (in this schedule or elsewhere): one line per overlap.
function conflictLines(data) {
  const names = new Map(data.shifts.map((x) => [x.staff_id, x.staff_name]));
  const by = new Map();
  const add = (x, where) => { if (x.status && x.status !== "ok") return; const l = by.get(x.staff_id) ?? []; l.push({ a: x.start_at, b: x.end_at, where }); by.set(x.staff_id, l); };
  for (const x of data.shifts) add(x, t(`dept.${x.department_id}`));
  for (const x of data.elsewhere ?? []) add(x, `${x.restaurant ?? ""} ${t(`dept.${x.department_id}`)}`.trim());
  const out = [];
  for (const [id, list] of by) {
    list.sort((p, q) => (p.a < q.a ? -1 : 1));
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++)
      if (list[i].a < list[j].b && list[j].a < list[i].b)
        out.push(`${names.get(id) ?? `#${id}`} · ${fmt(list[i].a.slice(0, 10), { weekday: "short", day: "numeric", month: "short" })} ${hhmm(list[i].a)}–${hhmm(list[i].b)} (${list[i].where}) ↔ ${hhmm(list[j].a)}–${hhmm(list[j].b)} (${list[j].where})`);
  }
  return out;
}

// "Sommaire" tab: hours and salary (administrators only): each day and the week, one column per selected department plus a total.
function renderSummary({ days, payroll, sel, data, boxes }) {
  const cols = payroll.byDept ?? [{ dept: sel.departments[0], payroll }];
  const cell = (cents, hrsN, tag = "td", extra = "") => h(tag, { class: `pay-num ${extra}` }, h("b", {}, money(cents, true)), h("small", {}, `${hrs(hrsN)} ${t("hoursShort")}`));
  const dayOf = (p, d) => p.department.days.find((x) => x.date === d);
  const rows = [
    ...days.map((d) => [fmt(d, { weekday: "long", day: "numeric", month: "short" }), (p) => { const x = dayOf(p, d); return [x?.cents ?? 0, x?.hours ?? 0]; }, false]),
    [t("costWeek"), (p) => [p.department.total_cents, p.department.total_hours], true],
  ];
  const unrated = cols.reduce((n, c) => n + (c.payroll.department.unrated_hours ?? 0), 0);
  const whole = cols[0].payroll.restaurant;
  const conflicts = conflictLines(data);
  const conflictBox = conflicts.length
    ? h("div", { class: "alert", role: "alert" }, h("strong", {}, `⚠ ${t("conflictsTitle")}`), h("ul", {}, conflicts.map((l) => h("li", {}, l))))
    : h("div", { class: "okmsg" }, t("noConflicts"));
  return h("section", { class: "timeline summary" },
    h("h2", {}, `${t("summaryTab")} — ${weekLabel(sel.week)}`),
    // the same warnings as the coverage view, for the whole week
    h("div", { class: `gaps ${conflictBox ? "three" : ""}` }, boxes.gapBox, boxes.extraBox, conflictBox),
    h("div", { class: "payroll" },
      h("table", { class: "pay-table" },
        h("thead", {}, h("tr", {}, h("th"), cols.map((c) => h("th", {}, t(`dept.${c.dept}`))), cols.length > 1 ? h("th", { class: "pay-total" }, t("total")) : null)),
        h("tbody", {}, rows.map(([label, get, strong]) => {
          const vals = cols.map((c) => get(c.payroll));
          const sum = vals.reduce((a, v) => [a[0] + v[0], a[1] + v[1]], [0, 0]);
          return h("tr", { class: strong ? "pay-week" : "" }, h("th", { class: "pay-label" }, label), vals.map((v) => cell(v[0], v[1])), cols.length > 1 ? cell(sum[0], sum[1], "td", "pay-total") : null);
        }))),
      unrated > 0 ? h("div", { class: "warn" }, `${hrs(unrated)} ${t("unratedHours")}`) : null,
      whole ? h("p", { class: "meta" }, `${t("summaryRestaurant")} : `, h("b", {}, money(whole.total_cents, true)), ` · ${hrs(whole.total_hours)} ${t("hoursShort")}`) : null,
      h("button", { class: "btn", type: "button", onClick: () => { state.showHourlyCost = !state.showHourlyCost; try { localStorage.setItem("hourlyCost", state.showHourlyCost ? "1" : "0"); } catch { /* ignore */ } render(); } },
        state.showHourlyCost ? t("hideHourlyCost") : t("showHourlyCost"))));
}

// Mouse drag over the coverage cells of one day selects a time range (highlighted while dragging); a click or shift-click also works.
let rangeSuppressClick = false, rangeAnchor = null;
function beginRangeSelect(day, startT, done) {
  const cells = [...document.querySelectorAll(`.vtl-cell.editable[data-day="${day}"]`)];
  let endT = startT, moved = false;
  const paint = () => cells.forEach((c) => { const m = Number(c.dataset.t); c.classList.toggle("picked", m >= Math.min(startT, endT) && m <= Math.max(startT, endT)); });
  const over = (e) => { const c = e.target.closest?.(`.vtl-cell.editable[data-day="${day}"]`); if (c) { const m = Number(c.dataset.t); if (m !== endT) { endT = m; moved = true; paint(); } } };
  const up = () => {
    document.removeEventListener("pointermove", over); document.removeEventListener("pointerup", up);
    cells.forEach((c) => c.classList.remove("picked"));
    if (moved) { done(startT, endT); setTimeout(() => { rangeSuppressClick = false; }, 0); } // a plain click is handled by the click event
  };
  document.addEventListener("pointermove", over); document.addEventListener("pointerup", up);
}

function renderTimeline({ data, days, targets, sets, payroll, openEditor, weekView = false }) {
  // The coverage view shows first names only (plus the last-name initial when two people share a first name).
  const shortOf = shortNames([...new Map(data.shifts.map((x) => [x.staff_id, { id: x.staff_id, name: x.staff_name, first_name: x.first_name, last_name: x.last_name }])).values()]);
  const sel = state.sel;
  const desktop = mqDesktop.matches;
  const zoom = !weekView && !!(desktop && state.zoomDay && days.includes(state.zoomDay));
  const shown = weekView ? days : zoom ? [state.zoomDay] : desktop ? days : [sel.day];

  const perDay = shown.map((day) => {
    // Each department resolves its own layers (base/season/special day); the counts are then added together.
    const dayTargets = {}; let labels = []; const deptTargets = {};
    for (const d of sel.departments) {
      const r = resolveForDate(targets.filter((x) => x.department_id === d), sets, day);
      deptTargets[d] = r.targets;
      for (const [slot, n] of Object.entries(r.targets)) dayTargets[slot] = (dayTargets[slot] ?? 0) + n;
      labels = r.labels;
    }
    const hrs = hoursOn(sel.restaurant, day);
    const openMin = toMin(hrs.open), closeMin = toMin(hrs.close);
    const wins = hrs.closed ? [] : targetWindows(dayTargets, openMin, closeMin, boundsOf(sel.restaurant));
    const items = data.shifts.map((s) => ({ s, span: shiftSpan(s, day) })).filter((x) => x.span.s < 1440 && x.span.e > 0)
      .sort((a, b) => a.span.s - b.span.s || a.s.staff_name.localeCompare(b.s.staff_name, locale()));
    const cost = payroll?.department.days.find((x) => x.date === day) ?? null;
    return { day, wins, items, labels, openMin, closeMin, cost, deptTargets, hrs };
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
  const postLines = [];
  let anyTargets = false;
  const dayCols = perDay.map((d) => {
    if (d.wins.length) anyTargets = true;
    // A shift covering several of the selected departments (main role Delivery + Plonge) meets the requirement of each: it counts once per department.
    const present = d.items.map((x) => x.s).filter((x) => x.status !== "sick_open").flatMap((x) =>
      shiftSlices(x).flatMap((sl) => {
        // roles marked "don't count for targets" do not count toward their department
        const n = new Set(sl.roles.filter((r) => !r.no_count).map((r) => r.department_id).filter((dep) => sel.departments.includes(dep))).size;
        return Array(n).fill({ start_at: sl.a, end_at: sl.b });
      }));
    const buckets = coverage(present, d.day, startMin, endMin);
    // Kitchen posts: every post needs someone competent present (a runner is competent everywhere).
    if (sel.departments.includes("kitchen") && data.any_skills) {
      const kitchenPeople = d.items.filter((x) => x.s.status !== "sick_open").flatMap((x) =>
        shiftSlices(x.s).filter((sl) => sl.roles.some((r) => r.department_id === "kitchen" && !r.no_count)).map((sl) => {
          const sp = shiftSpan({ start_at: sl.a, end_at: sl.b }, d.day);
          // the runner is a competency (competent at every post), not a role
          return { skills: new Set(data.skills?.[x.s.staff_id] ?? []), a: sp.s, b: sp.e };
        }));
      const bfDay = state.restaurants.find((r) => r.id === sel.restaurant)?.breakfast_by_dow?.[dowOf(d.day)];
      const gaps = postGaps(kitchenPeople, state.posts.filter((p) => p.department_id === "kitchen"), Math.max(startMin, d.openMin - 60), Math.min(endMin, d.closeMin), 30,
        (data.delivery_presence ?? []).map((x) => { const sp = shiftSpan(x, d.day); return { a: sp.s, b: sp.e }; }),
        bfDay ? { from: toMin(bfDay.start), until: toMin(bfDay.end) } : null);
      for (const p of state.posts.filter((q) => q.department_id === "kitchen" && !q.all_posts))
        for (const g of gaps[p.id] ?? []) postLines.push(`${shown.length > 1 ? `${fmt(d.day, { weekday: "short", day: "numeric", month: "short" })} · ` : ""}${getLang() === "fr" ? p.name_fr : p.name_en} · ${fromMin(g.from)}–${fromMin(g.to)}`);
    }
    const dayLabel = shown.length > 1 ? `${fmt(d.day, { weekday: "short", day: "numeric", month: "short" })} · ` : "";
    for (const g of shortages(buckets, d.wins)) gapLines.push(`${dayLabel}${fromMin(g.from)}–${fromMin(g.to)} · ${t("missingN")} ${g.missing} ${t("personsShort")}`);
    for (const g of surpluses(buckets, d.wins)) extraLines.push(`${dayLabel}${fromMin(g.from)}–${fromMin(g.to)} · ${g.missing} ${t("personsShort")} ${t("tooMany")}`);

    // Single day: present/required for each department with its icon in front (🍕 3/3 · 🚗 1/1).
    const perDept = shown.length === 1 && sel.departments.length > 0 ? sel.departments.map((dep) => {
      const slices = d.items.map((x) => x.s).filter((x) => x.status !== "sick_open").flatMap((x) =>
        shiftSlices(x).filter((sl) => sl.roles.some((r) => r.department_id === dep && !r.no_count)).map((sl) => ({ start_at: sl.a, end_at: sl.b })));
      return { dep, wins: d.hrs.closed ? [] : targetWindows(d.deptTargets[dep] ?? {}, d.openMin, d.closeMin, boundsOf(sel.restaurant)), buckets: coverage(slices, d.day, startMin, endMin) };
    }) : null;
    const cells = buckets.map((b, bi) => {
      const tg = targetAt(d.wins, b.t);
      const cls = tg === undefined ? "none" : b.count < tg ? "short" : b.count === tg ? "ok" : "over";
      const lines = perDept ? perDept.map((pd) => ({ dep: pd.dep, n: pd.buckets[bi].count, tg: targetAt(pd.wins, b.t) })).filter((l) => l.n > 0 || l.tg !== undefined) : null;
      const title = `${fromMin(b.t)} — ${t("present")} ${b.count}${tg === undefined ? "" : ` / ${t("target")} ${tg}`}${lines ? ` · ${lines.map((l) => `${t(`dept.${l.dep}`)} ${l.n}${l.tg === undefined ? "" : `/${l.tg}`}`).join(" · ")}` : ""}`;
      const content = lines && lines.length ? lines.map((l) => h("span", { class: `dept-count ${l.tg === undefined ? "" : l.n < l.tg ? "short" : l.n > l.tg ? "over" : "ok"}`, "data-dep": l.dep }, `${deptIcon(l.dep)} ${l.n}${l.tg === undefined ? "" : `/${l.tg}`}`))
        : (tg === undefined ? String(b.count) : `${b.count}/${tg}`);
      const cellProps = { class: `vtl-cell ${cls}`, style: `top:${y(b.t)}px;height:${ph / 2}px`, title };
      // administrators: click a cell to change the staffing target of that time (and department)
      if (!(state.me.me.is_admin && data.editable)) return h("div", cellProps, content);
      // drag over several cells (or shift-click) to change the targets of a whole range at once
      const open = (a, z, e) => targetDialog({ day: d.day, minute: Math.min(a, z), endMinute: Math.max(a, z) + 30, dep: e?.target?.closest?.("[data-dep]")?.dataset.dep ?? sel.departments[0], deps: sel.departments, targets, sets, onSaved: render });
      return h("button", { ...cellProps, type: "button", class: `vtl-cell ${cls} editable`, "data-day": d.day, "data-t": b.t, title: `${title} — ${t("editTargetHint")}`,
        onPointerDown: (e) => { if (e.pointerType !== "mouse" || e.button !== 0 || e.shiftKey) return; beginRangeSelect(d.day, b.t, (a, z) => { rangeSuppressClick = true; open(a, z, e); }); },
        onClick: (e) => {
          if (rangeSuppressClick) { rangeSuppressClick = false; return; }
          const last = rangeAnchor?.day === d.day ? rangeAnchor.t : b.t;
          rangeAnchor = { day: d.day, t: b.t };
          open(e.shiftKey ? last : b.t, b.t, e);
        } }, content);
    });

    const clipped = d.items.map((x) => ({ ...x, from: Math.max(x.span.s, startMin), to: Math.min(x.span.e, endMin) }));
    const lanes = assignLanes(clipped);
    const bars = clipped.map((x) => {
      const range = `${hhmm(x.s.start_at)}–${x.s.until_close ? "F" : hhmm(x.s.end_at)}`;
      const height = ((x.to - x.from) / 60) * ph;
      // Week view: always the vertical layout (text read top to bottom, name visible). Horizontal text only when a single day is shown.
      const single = shown.length === 1;
      const wide = single && (zoom || lanes <= 2 || (!desktop && lanes <= 3));
      const color = staffColor(x.s.staff_id, x.s.staff_color);
      const fill = x.s.until_close ? `linear-gradient(to bottom, ${color} 85%, color-mix(in srgb, ${color} 65%, black))` : color;
      const props = {
        class: `vtl-bar ${wide ? "" : "vertical"} ${x.s.status === "sick_open" ? "sick" : ""} ${data.conflicts?.shifts.has(x.s.id) ? "conflict" : ""}`,
        title: `${shiftRoleIcons(x.s)} ${x.s.staff_name} · ${range} · ${shiftRoleLabel(x.s)}${x.s.status === "sick_open" ? ` · ${t("sickOpen")}` : ""}`,
        style: `top:${y(x.from)}px;height:${height}px;left:${(x.lane / lanes) * 100}%;width:${100 / lanes}%;background:${fill};color:${textOn(color)}`,
      };
      // Picture size follows the room available in this lane; skip it on very short bars.
      const size = Math.max(14, Math.min(zoom ? 44 : 30, Math.floor(laneArea / lanes) - 6));
      const pic = height >= size + 14 + (wide ? 0 : 80) ? avatar(x.s.staff_id, x.s.staff_name, x.s.staff_color, x.s.photo_v, size) : null;
      // Role icon (plate = dishwasher, pizza = cook, car = delivery, knife = prep…); the full name is in the tooltip.
      const icon = h("span", { class: "role-icon", "aria-hidden": "true" }, shiftRoleIcons(x.s));
      // different roles during the shift: a marker with the roles' icons where each new range starts
      const marks = x.s.segments?.length ? shiftSlices(x.s).map((sl, i) => {
        const sp = shiftSpan({ start_at: sl.a, end_at: sl.b }, d.day);
        const top = y(Math.max(sp.s, x.from)) - y(x.from);
        return top >= 0 && sp.e > x.from && sp.s < x.to ? h("span", { class: `seg-mark ${i ? "split" : ""}`, style: `top:${top}px`, title: `${hhmm(sl.a)}–${hhmm(sl.b)} ${roleText(sl.roles)}` }, sl.roles.map(roleIcon).join("")) : null;
      }) : [];
      const body = zoom
        ? [h("b", { class: "bar-name" }, pic, shortOf.get(x.s.staff_id), icon), `${range} · ${shiftRoleLabel(x.s)}`, x.s.notes ? h("em", {}, x.s.notes) : null]
        : wide
        ? [h("b", { class: "bar-name" }, pic, shortOf.get(x.s.staff_id), icon), range]
        : [pic, height >= 60 ? icon : null, h("span", { class: "bar-text" }, `${shortOf.get(x.s.staff_id)} ${range}`)];
      return data.editable ? h("button", { ...props, type: "button", onClick: () => openEditor(x.s) }, body, marks) : h("div", props, body, marks);
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
    return h("div", { class: `vtl-day ${hourly ? "with-cost" : ""}` }, shade(startMin, d.openMin - lead), shade(d.openMin - lead, d.openMin, "vtl-setup", t("setupTime")), shade(d.closeMin, endMin), d.hrs.closed ? h("div", { class: "vtl-closed vtl-closed-day", title: d.hrs.note ?? t("closedDay"), style: `top:0;height:${hours * ph}px` }, h("span", {}, `⛔ ${t("closedDay")}`)) : null, h("div", { class: "vtl-cov" }, cells), costCol, h("div", { class: "vtl-lanes" }, bars));
  });

  const heads = perDay.map((d) => {
    const kids = [fmt(d.day, { weekday: "short" }), h("small", {}, fmt(d.day, { day: "numeric", month: "short" })),
      d.labels.length ? h("span", { class: "tag" }, d.labels.join(" · ")) : null,
      d.hrs.closed ? h("span", { class: "tag closed", title: d.hrs.note ?? "" }, `⛔ ${d.hrs.note || t("closedDay")}`) : d.hrs.special ? h("span", { class: "tag special", title: d.hrs.note ?? "" }, `🕒 ${hm(d.hrs.open)}–${hm(d.hrs.close)}`) : null,
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
  // Kitchen posts nobody competent covers (red), or a reminder that competencies were not entered yet.
  const postBox = sel.departments.includes("kitchen")
    ? (!data.any_skills
        ? h("div", { class: "info", role: "status" }, t("postsNotSet"))
        : postLines.length ? h("div", { class: "alert", role: "alert" }, h("strong", {}, `⚠ ${t("postsUncovered")}`), h("ul", {}, postLines.map((l) => h("li", {}, l)))) : null)
    : null;
  const extraBox = anyTargets && extraLines.length
    ? h("div", { class: "info", role: "status" }, h("strong", {}, t("surplusTitle")), h("ul", {}, extraLines.map((l) => h("li", {}, l))))
    : null;

  const dayTabs = h("div", { class: "daytabs tl-days", role: "group" }, days.map((d) =>
    h("button", { type: "button", "aria-pressed": String(d === sel.day), onClick: () => { sel.day = d; render(); } },
      h("span", { class: "dow" }, fmt(d, { weekday: "short" })), h("span", { class: "dom" }, fmt(d, { day: "numeric" })))));

  const tlSection = h("section", { class: "timeline" },
    h("h2", {}, shown.length > 1 ? t("coverageWeek") : `${t("coverage")} — ${fmt(shown[0], { weekday: "long", day: "numeric", month: "long" })}`),
    zoomBar,
    dayTabs,
    // staffing notices are for the people who run the schedule, not for employees
    data.editable ? h("div", { class: "gaps" }, gapBox, extraBox, postBox ? (postBox.classList.add("wide"), postBox) : null) : null,
    shown.length > 1 && desktop ? h("p", { class: "zoom-hint" }, `🔍 ${t("zoomHint")}`) : null,
    h("div", { class: "vtl-scroll" },
      h("div", { class: `vtl ${zoom ? "zoomed" : ""} ${data.editable ? "" : "no-cov"}`, style: `--cols:${shown.length};--hours:${hours};--ph:${ph}px;${shown.length === 1 ? `--cov:${Math.max(58, 14 + sel.departments.length * 56)}px;` : ""}--colmin:${zoom ? 420 : desktop ? (payroll && state.showHourlyCost ? 160 : 118) : 240}px` },
        [h("div", { class: "vtl-corner" }), ...heads, axis, ...dayCols])),
    // the staffing targets and their colours are for the people who run the schedule
    !data.editable ? null : h("div", { class: "tl-legend" },
      h("span", {}, h("i", { style: "background:#86efac" }), t("legendOk")), h("span", {}, h("i", { style: "background:#fca5a5" }), t("legendShort")),
      h("span", {}, h("i", { style: "background:#93c5fd" }), t("legendOver")), h("span", {}, h("i", { style: "background:var(--line)" }), t("legendNone"))));
  tlSection.boxes = { gapBox, extraBox };
  tlSection.lines = { gapLines, extraLines };
  return tlSection;
}

// ---------- shift editor ----------
function openShiftModal({ shift, prefill = {}, roster, data }) {
  const dlg = document.getElementById("modal");
  const sel = state.sel;
  const rolesById = new Map(state.roles.map((r) => [r.id, r]));
  const initial = shift
    ? { staff_id: shift.staff_id, role_id: shift.role_id, date: dayOf(shift.start_at), start: hhmm(shift.start_at), end: hhmm(shift.end_at), notes: shift.notes ?? "", until_close: !!shift.until_close }
    : { staff_id: prefill.staff_id ?? roster[0]?.staff_id, role_id: null, date: prefill.date ?? sel.day, start: "11:00", end: "17:00", notes: "", until_close: false };

  const staffSel = h("select", { required: true }, roster.map((r) => h("option", { value: r.staff_id, selected: r.staff_id === initial.staff_id }, r.name)));
  const roleSel = h("select", { required: true });
  // "Also covers": other roles this person holds, checked when the same shift covers them too (e.g. cook + dishwasher).
  const alsoBox = h("div", { class: "also-roles" });
  let alsoChecked = new Set((shift?.extra_roles ?? []).map((r) => r.id));
  let noCount = new Set((shift?.extra_roles ?? []).filter((r) => r.no_count).map((r) => r.id));
  const drawAlso = () => {
    const person = roster.find((r) => r.staff_id === Number(staffSel.value));
    const main = Number(roleSel.value);
    const others = state.roles.filter((r) => (person?.all_role_ids ?? person?.role_ids ?? []).includes(r.id) && r.id !== main);
    alsoBox.replaceChildren(...(others.length ? [h("span", { class: "meta" }, t("alsoCovers"))] : []), ...others.map((r) =>
      h("div", { class: "also-row" },
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: alsoChecked.has(r.id), onChange: (e) => { e.target.checked ? alsoChecked.add(r.id) : (alsoChecked.delete(r.id), noCount.delete(r.id)); drawAlso(); } }), `${roleIcon(r)} ${roleName(r, person?.sex)}`),
        // when the extra role is only a possibility for the day: list it, but keep it out of the targets (no false surplus)
        alsoChecked.has(r.id) ? h("label", { class: "check sub" }, h("input", { type: "checkbox", checked: noCount.has(r.id), onChange: (e) => { e.target.checked ? noCount.add(r.id) : noCount.delete(r.id); } }), t("dontCountTargets")) : null)));
  };
  const fillRoles = () => {
    const person = roster.find((r) => r.staff_id === Number(staffSel.value));
    const ids = person?.role_ids ?? [];
    const keep = Number(roleSel.value) || initial.role_id;
    // the shift's own main role stays selectable even when its department is not among the displayed ones
    const offered = state.roles.filter((r) => ids.includes(r.id) && (sel.departments.includes(r.department_id) || (shift && r.id === shift.role_id && person?.staff_id === shift.staff_id)));
    roleSel.replaceChildren(...offered.map((r) =>
      h("option", { value: r.id, selected: r.id === keep }, roleName(r, person?.sex))));
    drawAlso();
  };
  roleSel.addEventListener("change", () => { alsoChecked.delete(Number(roleSel.value)); drawAlso(); });
  staffSel.addEventListener("change", () => { alsoChecked = new Set(); noCount = new Set(); segs = []; drawSegs(); fillRoles(); applyPreOpen(); });
  fillRoles();
  const date = h("input", { type: "date", value: initial.date, required: true });
  const start = timeField(initial.start);
  const end = timeField(initial.end);
  const notes = h("textarea", { value: initial.notes, maxLength: 200 });
  const untilClose = h("input", { type: "checkbox", checked: initial.until_close });
  // Different roles at different hours (Prep 10:30-11, Delivery + Dish 11-14, Cook 14-19:30).
  const segBox = h("div", { class: "seg-box" });
  let segs = (shift?.segments ?? []).map((g) => ({ from: timeField(hhmm(g.start_at)), to: timeField(hhmm(g.end_at)), roles: new Set(g.roles.map((r) => r.id)) }));
  const isoOf = (hm) => `${hm >= start.value ? date.value : addDays(date.value, 1)}T${hm}`;
  const drawSegs = () => {
    const person = roster.find((r) => r.staff_id === Number(staffSel.value));
    const mine = state.roles.filter((r) => (person?.all_role_ids ?? person?.role_ids ?? []).includes(r.id));
    segBox.replaceChildren(
      h("div", { class: "seg-head" }, h("b", {}, t("rolesByHour")), h("span", { class: "meta" }, t("rolesByHourHelp"))),
      ...segs.map((g, i) => h("div", { class: "seg-row" },
        h("div", { class: "times" }, h("label", { class: "field" }, h("span", {}, t("from")), g.from), h("label", { class: "field" }, h("span", {}, t("to")), g.to),
          h("button", { class: "btn sm danger", type: "button", onClick: () => { segs.splice(i, 1); drawSegs(); } }, t("delete"))),
        h("div", {}, mine.map((r) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: g.roles.has(r.id), onChange: (e) => { e.target.checked ? g.roles.add(r.id) : g.roles.delete(r.id); } }), `${roleIcon(r)} ${roleName(r, person?.sex)}`))))),
      h("button", { class: "btn sm", type: "button", onClick: () => {
        const lastEnd = segs.length ? segs[segs.length - 1].to.value : start.value;
        segs.push({ from: timeField(lastEnd), to: timeField(untilClose.checked ? hoursOn(sel.restaurant, date.value).close : end.value), roles: new Set() }); drawSegs();
      } }, `+ ${t("addTimeRange")}`));
  };
  drawSegs();
  // New shifts start before opening for roles that must arrive early (cook, waiter: 30 min), unless the start was edited by hand.
  let startTouched = !!shift;
  start.addEventListener("change", () => { startTouched = true; });
  function applyPreOpen() {
    if (startTouched || !date.value) return;
    const role = state.roles.find((r) => r.id === Number(roleSel.value));
    if (!role?.pre_open_minutes) return;
    const dow = (parseYmd(date.value).getDay() + 6) % 7;
    const m = toMin(hoursOn(sel.restaurant, date.value).open) - role.pre_open_minutes;
    if (m >= 0) start.value = fromMin(m);
  }
  roleSel.addEventListener("change", applyPreOpen); date.addEventListener("change", applyPreOpen);
  applyPreOpen();
  const alertBox = h("div");
  // warn (without blocking) when the date is a closed day
  const closedNote = () => { if (hoursOn(sel.restaurant, date.value).closed) alertBox.replaceChildren(h("div", { class: "info", role: "status" }, `⛔ ${t("closedWarning")}`)); else if (alertBox.querySelector(".info")) alertBox.replaceChildren(); };
  date.addEventListener("change", closedNote); closedNote();
  const nextDay = h("span", { class: "meta" });
  const syncNext = () => {
    end.disabled = untilClose.checked;
    nextDay.textContent = !untilClose.checked && end.value && start.value && end.value <= start.value ? t("nextDay") : "";
  };
  start.addEventListener("input", syncNext); end.addEventListener("input", syncNext); untilClose.addEventListener("change", syncNext); syncNext();

  const payload = (force) => {
    const endTime = untilClose.checked ? hoursOn(sel.restaurant, date.value).close : end.value;
    const endDate = endTime <= start.value ? addDays(date.value, 1) : date.value;
    return {
      staff_id: Number(staffSel.value), restaurant_id: sel.restaurant, role_id: Number(roleSel.value),
      segments: segs.filter((g) => g.roles.size).map((g) => ({ start_at: isoOf(g.from.value), end_at: isoOf(g.to.value), role_ids: [...g.roles] })),
      extra_role_ids: [...alsoChecked].filter((id) => id !== Number(roleSel.value)),
      no_count_role_ids: [...noCount].filter((id) => alsoChecked.has(id)),
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
    if (!(await ask(t("confirmDelete")))) return;
    try { await api(`/shifts/${shift.id}`, { method: "DELETE" }); dlg.close(); render(); } catch (e) { alertBox.replaceChildren(h("div", { class: "alert" }, errorText(e))); }
  };

  // Sticky header: title and every button (the form fields scroll underneath). Save submits the form through the form= attribute.
  const actions = h("div", { class: "dlg-actions wrap" },
    shift && shift.status === "ok" && shift.end_at > nowLocal() ? h("button", { class: "btn sm", type: "button", title: t("reportAbsent"), onClick: async () => { const why = await absenceDialog({ forOther: true }); if (why) { try { await api(`/shifts/${shift.id}/sick`, { method: "POST", body: why }); dlg.close(); toast(t("sickStarted")); render(); } catch (e) { alertBox.replaceChildren(h("div", { class: "alert", role: "alert" }, errorText(e))); } } } }, `🤒 ${t("reportSick")}`) : null,
    shift && (state.me.me.is_admin || data.editable) && shift.staff_id !== state.me.me.id ? h("button", { class: "btn sm", type: "button", onClick: async () => {
      const list = await api("/staff").catch(() => []); // administrators: everybody; managers: the people they manage
      dlg.close(); incidentDialog({ staffList: list, staffId: shift.staff_id, date: dayOf(shift.start_at), shift });
    } }, t("recordIncident")) : null,
    shift ? h("button", { class: "btn sm danger", type: "button", onClick: del }, t("delete")) : null,
    h("button", { class: "btn sm", type: "button", onClick: () => dlg.close() }, t("cancel")),
    h("button", { class: "btn sm primary", type: "submit", form: "shift-form" }, t("save")));
  const form = h("form", { id: "shift-form", class: "modal-body shift-dialog", method: "dialog", onSubmit: (e) => { e.preventDefault(); save(false); } },
    h("div", { class: "dlg-top" }, h("div", { class: "dlg-head" }, h("h2", {}, shift ? t("editShift") : t("addShift")), actions), alertBox),
    h("label", { class: "field" }, h("span", {}, t("employee")),
      // administrators: open the employee's file (roles, availability, wages…) without leaving the shift
      state.me.me.is_admin ? h("div", { class: "staff-pick" }, staffSel, h("button", { class: "btn", type: "button", title: t("employeeFile"), "aria-label": t("employeeFile"), onClick: async (e) => {
        e.preventDefault();
        try {
          const ov = await api("/admin/overview");
          const person = ov.staff.find((x) => x.id === Number(staffSel.value));
          if (person) staffCard(person, ov).click();
        } catch (err) { toast(errorText(err)); }
      } }, "👤")) : staffSel),
    h("label", { class: "field" }, h("span", {}, t("role")), roleSel), alsoBox, segBox,
    h("label", { class: "field" }, h("span", {}, t("date")), date),
    h("div", { class: "row2" }, h("label", { class: "field" }, h("span", {}, t("start")), start), h("label", { class: "field" }, h("span", {}, t("end")), end, nextDay)),
    h("label", { class: "check" }, untilClose, t("untilClose")),
    h("label", { class: "field" }, h("span", {}, t("notes")), notes));
  dlg.replaceChildren(form);
  dlg.showModal();
}

// ---------- my shifts ----------
// ---------- time off ----------
// Kitchen competencies of one employee: the posts they can work (a runner can work all of them).
const KITCHEN_SKILL_ROLES = ["chef", "cook"];
function hasKitchenRole(person) {
  return (person.roles ?? []).some((r) => KITCHEN_SKILL_ROLES.includes((state.roles.find((x) => x.id === r.role_id)?.name_en ?? "").toLowerCase()));
}
function skillsBox(person) {
  const box = h("div", { class: "skills-box" });
  const posts = state.posts.filter((p) => p.department_id === "kitchen");
  api(`/staff/${person.id}/skills`).then((have) => {
    const set = new Set(have);
    box.replaceChildren(h("h4", {}, t("kitchenPosts")), h("p", { class: "meta" }, t("kitchenPostsHelp")),
      ...posts.map((p) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: set.has(p.id), onChange: async (e) => {
        e.target.checked ? set.add(p.id) : set.delete(p.id);
        try { await api(`/staff/${person.id}/skills`, { method: "PUT", body: { post_ids: [...set] } }); toast(t("saved")); }
        catch (err) { e.target.checked = !e.target.checked; e.target.checked ? set.add(p.id) : set.delete(p.id); toast(errorText(err)); }
      } }), getLang() === "fr" ? p.name_fr : p.name_en)));
  }).catch(() => {});
  return box;
}

// Which schedules (restaurant x department) this employee may look at: automatic (where they hold a role) or ticked by hand.
function scheduleAccessPane(person, ov) {
  const box = h("div", { class: "sched-access" });
  async function load() {
    const cur = await api(`/staff/${person.id}/view-access`);
    const fromRoles = new Set(person.roles.map((r) => `${r.restaurant_id}|${state.roles.find((x) => x.id === r.role_id)?.department_id}`));
    const ticked = new Set(cur.access.map((x) => `${x.restaurant_id}|${x.department_id}`));
    let custom = cur.custom;
    const start = new Set(custom ? ticked : fromRoles); // when switching to "custom", start from what they see now
    const boxes = new Map();
    const mode = radioGroup(`va-${person.id}`, [["auto", t("vaAuto")], ["custom", t("vaCustom")]], custom ? "custom" : "auto");
    const grid = h("table", { class: "va-grid" },
      h("thead", {}, h("tr", {}, h("th", {}, t("restaurant")), DEPTS.map((d) => h("th", {}, t(`dept.${d}`))), h("th", {}, t("vaAllDepts")))),
      h("tbody", {}, ov.restaurants.map((r) => {
        const cells = DEPTS.map((d) => { const key = `${r.id}|${d}`; const input = h("input", { type: "checkbox", checked: start.has(key), "aria-label": `${r.name} — ${t(`dept.${d}`)}` }); boxes.set(key, input); return h("td", {}, input); });
        const rowAll = h("input", { type: "checkbox", "aria-label": `${r.name}: ${t("vaAllDepts")}`, onChange: (e) => DEPTS.forEach((d) => { boxes.get(`${r.id}|${d}`).checked = e.target.checked; }) });
        return h("tr", {}, h("th", {}, r.name), cells, h("td", {}, rowAll));
      })));
    const sync = () => {
      const isCustom = mode.value === "custom";
      boxes.forEach((input, key) => { input.disabled = !isCustom; if (!isCustom) input.checked = fromRoles.has(key); });
      grid.querySelectorAll("tbody tr td:last-child input").forEach((i) => { i.disabled = !isCustom; });
      note.textContent = isCustom ? t("vaCustomHelp") : t("vaAutoHelp");
    };
    const note = h("p", { class: "meta" });
    mode.addEventListener("change", sync);
    sync();
    box.replaceChildren(h("h4", {}, t("scheduleAccessTab")), h("p", { class: "meta" }, t("vaHelp")), mode, note, h("div", { class: "va-wrap" }, grid),
      h("button", { class: "btn primary", type: "button", onClick: async () => {
        const isCustom = mode.value === "custom";
        const access = isCustom ? [...boxes].filter(([, i]) => i.checked).map(([k]) => { const [r, d] = k.split("|"); return { restaurant_id: Number(r), department_id: d }; }) : [];
        try { await api(`/staff/${person.id}/view-access`, { method: "PUT", body: { custom: isCustom, access } }); toast(t("saved")); load(); } catch (e) { toast(errorText(e)); }
      } }, t("save")));
  }
  load().catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

// One employee's attendance file: absences they announced (or a manager reported) and incidents a manager recorded.
function attendancePane(person, ov) {
  const box = h("div", { class: "attendance" });
  const st = { filter: "all" };
  const when = (ms) => new Date(ms).toLocaleString(getLang() === "fr" ? "fr-CA" : "en-CA", { dateStyle: "medium", timeStyle: "short" });
  async function load() {
    const d = await api(`/staff/${person.id}/attendance`);
    const m = d.last_12_months;
    const chip = (n, label, cls) => h("span", { class: `att-chip ${cls}` }, h("b", {}, String(n)), ` ${label}`);
    const items = [
      ...d.absences.map((a) => ({ type: "absence", date: a.start_at, a })),
      ...d.incidents.map((i) => ({ type: "incident", date: `${i.incident_date}T00:00`, i })),
    ].sort((x, y) => (x.date < y.date ? 1 : -1)).filter((x) => st.filter === "all" || (st.filter === "absences" ? x.type === "absence" : x.type === "incident"));
    const outcome = (a) => ({ open: t("attOutcome.open"), filled: `${t("attOutcome.filled")} ${a.replaced_by_name ?? ""}`, cancelled: t("attOutcome.cancelled"), shift_removed: t("attOutcome.shift_removed") })[a.outcome] ?? "";
    const row = (x) => {
      if (x.type === "absence") {
        const a = x.a, kindCls = { announced: "att-ann", late: "att-late", by_manager: "att-mgr" }[a.kind];
        return h("div", { class: `att-row ${kindCls}` },
          h("div", { class: "att-head" }, h("span", { class: "att-badge" }, `🚫 ${t(`att.${a.kind}`)}`), h("b", {}, fmt(a.start_at.slice(0, 10), { weekday: "short", day: "numeric", month: "long", year: "numeric" }))),
          h("div", {}, `${hhmm(a.start_at)}–${hhmm(a.end_at)} · ${a.restaurant}${a.name_fr ? ` · ${roleIcon(a)} ${roleName(a, person.sex)}` : ""}`),
          a.reason ? h("div", {}, `${t("reasonLabel")} : ${t(`reason.${a.reason}`)}${a.note ? ` — ${a.note}` : ""}`) : null,
          h("div", { class: "meta" }, `${outcome(a)} · ${t("attDeclared")} ${when(a.declared_at)}${a.kind === "by_manager" && a.declared_by_name ? ` ${t("attBy")} ${a.declared_by_name}` : ""}`));
      }
      const i = x.i;
      return h("div", { class: "att-row att-inc avail-row" },
        h("div", { class: "avail-text" },
          h("div", { class: "att-head" }, h("span", { class: "att-badge" }, `⚠ ${incidentLabel(i.kind)}`), h("b", {}, fmt(i.incident_date, { weekday: "short", day: "numeric", month: "long", year: "numeric" }))),
          h("div", {}, [i.restaurant, i.minutes ? `${i.minutes} min` : null].filter(Boolean).join(" · ")),
          i.notes ? h("div", {}, i.notes) : null,
          h("div", { class: "meta" }, `${t("attRecordedBy")} ${i.recorded_by_name ?? "—"}`)),
        h("div", { class: "row-icons" }, h("button", { class: "icon-btn avail-del", type: "button", title: t("delete"), "aria-label": t("delete"), onClick: async () => {
          if (!(await ask(t("confirmDeleteIncident")))) return;
          try { await api(`/admin/incidents/${i.id}`, { method: "DELETE" }); load(); } catch (e) { toast(errorText(e)); }
        } }, "🗑️")));
    };
    box.replaceChildren(
      h("div", { class: "att-summary" }, h("div", { class: "meta" }, t("attLast12")),
        chip(m.announced, t("att.announced"), "att-ann"), chip(m.late, t("att.late"), "att-late"), chip(m.by_manager, t("att.by_manager"), "att-mgr"),
        chip(m.no_show, t("inc.no_call_no_show"), "att-inc"), chip(m.late_arrival, t("inc.late_arrival"), "att-inc"), chip(m.early_departure, t("inc.early_departure"), "att-inc")),
      h("div", { class: "att-tools" },
        h("div", { class: "seg", role: "group" }, [["all", t("attAll")], ["absences", t("attAbsences")], ["incidents", t("attIncidents")]].map(([v, l]) =>
          h("button", { type: "button", "aria-pressed": String(st.filter === v), onClick: () => { st.filter = v; load(); } }, l))),
        h("button", { class: "btn primary", type: "button", onClick: () => incidentDialog({ staffList: ov.staff.map((x) => ({ id: x.id, name: x.name })), staffId: person.id, onSaved: load }) }, `+ ${t("recordIncident")}`)),
      items.length ? h("div", { class: "att-list" }, items.map(row)) : h("p", { class: "meta" }, t("attNone")));
  }
  load().catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

// Hours promised to the employee and notes for the planner (both are given to the AI when it builds a schedule).
function planningForm(person) {
  const hoursIn = h("input", { type: "number", min: 0, max: 168, step: "0.5", inputMode: "decimal", placeholder: "—", value: person.promised_hours ?? "", "aria-label": t("promisedHours") });
  const notes = h("textarea", { rows: 4, maxLength: 1000, placeholder: t("planningNotesPlaceholder") });
  notes.value = person.scheduling_notes ?? "";
  const setHours = (v) => { hoursIn.value = v === null ? "" : String(v); markChips(); };
  const step = (d) => { const cur = Number(hoursIn.value) || 0; setHours(Math.max(0, Math.min(168, cur + d))); };
  const chips = [10, 15, 20, 25, 30, 35, 40].map((n) => h("button", { type: "button", class: "chip-btn", onClick: () => setHours(n) }, `${n} h`));
  const markChips = () => chips.forEach((c, i) => c.setAttribute("aria-pressed", String(Number(hoursIn.value) === [10, 15, 20, 25, 30, 35, 40][i])));
  hoursIn.addEventListener("input", markChips); markChips();
  // Maximum hours per week (e.g. 17 h under 16): never exceeded for replacements, warned when scheduling.
  const maxIn = h("input", { type: "number", min: 1, max: 168, step: "0.5", inputMode: "decimal", placeholder: "—", value: person.max_weekly_hours ?? "", "aria-label": t("maxWeeklyHours") });
  const maxChips = [17, 20, 25, 30, 35, 40].map((n) => h("button", { type: "button", class: "chip-btn", onClick: () => { maxIn.value = String(n); markMax(); } }, `${n} h`));
  const markMax = () => maxChips.forEach((c, i) => c.setAttribute("aria-pressed", String(Number(maxIn.value) === [17, 20, 25, 30, 35, 40][i])));
  maxIn.addEventListener("input", markMax); markMax();
  const form = h("form", { id: `planning-form-${person.id}`, class: "planning-form", onSubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/staff/${person.id}/planning`, { method: "PUT", body: { promised_hours: hoursIn.value, scheduling_notes: notes.value } }); person.promised_hours = r.promised_hours; person.scheduling_notes = notes.value || null;
      const lim = await api(`/staff/${person.id}/limit`, { method: "PUT", body: { max_weekly_hours: maxIn.value } }); person.max_weekly_hours = lim.max_weekly_hours;
      toast(t("saved")); }
    catch (err) { toast(err.body?.error === "invalid_hours" ? t("genericError") : errorText(err)); }
  } },
    h("section", { class: "plan-card" },
      h("h4", {}, `⏱ ${t("promisedHours")}`), h("p", { class: "meta" }, t("promisedHoursHelp")),
      h("div", { class: "hours-stepper" },
        h("button", { type: "button", class: "icon-btn", "aria-label": "−", onClick: () => step(-1) }, "−"), hoursIn, h("span", { class: "unit" }, t("hoursPerWeek")), h("button", { type: "button", class: "icon-btn", "aria-label": "+", onClick: () => step(1) }, "+")),
      h("div", { class: "chip-row" }, chips, h("button", { type: "button", class: "chip-btn", onClick: () => setHours(null) }, t("noPromisedHours")))),
    h("section", { class: "plan-card" },
      h("h4", {}, `🛑 ${t("maxWeeklyHours")}`), h("p", { class: "meta" }, t("maxWeeklyHoursHelp")),
      h("div", { class: "hours-stepper" }, h("button", { type: "button", class: "icon-btn", "aria-label": "−", onClick: () => { maxIn.value = String(Math.max(1, (Number(maxIn.value) || 0) - 1)); markMax(); } }, "−"), maxIn, h("span", { class: "unit" }, t("hoursPerWeek")), h("button", { type: "button", class: "icon-btn", "aria-label": "+", onClick: () => { maxIn.value = String(Math.min(168, (Number(maxIn.value) || 0) + 1)); markMax(); } }, "+")),
      h("div", { class: "chip-row" }, maxChips, h("button", { type: "button", class: "chip-btn", onClick: () => { maxIn.value = ""; markMax(); } }, t("noMaxHours")))),
    h("section", { class: "plan-card" },
      h("h4", {}, `📝 ${t("planningNotes")}`), h("p", { class: "meta" }, t("planningNotesHelp")), notes));
  return form;
}

// ---------- AI: propose next week's schedule ----------
function aiScheduleDialog({ restaurantId, departments, currentWeek }) {
  const dlg = document.getElementById("modal");
  const target = addDays(currentWeek, 7);
  const resto = state.restaurants.find((r) => r.id === restaurantId);
  const extra = h("textarea", { rows: 4, maxLength: 3000, placeholder: t("aiExtraPlaceholder") });
  const body = h("div", { class: "ai-body" });
  const close = h("button", { class: "btn", type: "button", onClick: () => dlg.close() }, t("close"));
  dlg.replaceChildren(h("div", { class: "modal-body ai-dialog" }, h("div", { class: "dlg-top" }, h("div", { class: "dlg-head" }, h("h2", {}, `✨ ${t("aiTitle")}`), h("div", { class: "dlg-actions" }, close))), body));
  const reqBody = (extraText, dry) => ({ restaurant_id: restaurantId, departments, week: target, extra_prompt: extraText, dry_run: dry, lang: getLang() });

  async function setup() {
    body.replaceChildren(h("p", { class: "meta" }, t("loading")));
    let prev;
    try { prev = await api("/admin/ai-schedule", { method: "POST", body: reqBody("", true) }); }
    catch (e) { body.replaceChildren(h("div", { class: "alert" }, e.body?.error === "nothing_to_schedule" ? t("aiNothing") : errorText(e))); return; }
    const sm = prev.summary;
    const pre = h("pre", { class: "ai-prompt", hidden: true }, `${prev.system}\n\n${prev.user}`);
    body.replaceChildren(
      h("p", {}, h("b", {}, `${resto?.name ?? ""} · ${departments.map((d) => t(`dept.${d}`)).join(" · ")}`), h("br"), `${t("aiWeekFor")} ${weekLabel(target)}`),
      h("p", { class: "meta" }, t("aiBasis")),
      h("ul", { class: "ai-included" },
        h("li", {}, `${sm.current_week_shifts} ${t("aiShiftsNow")}`), h("li", {}, `${sm.time_off} ${t("aiTimeOffN")}`), h("li", {}, `${sm.unavailabilities} ${t("aiUnavailN")}`),
        h("li", {}, `${sm.employees} ${t("aiEmployeesN")} (${sm.new_employees} ${t("aiNewN")}, ${sm.with_promised_hours} ${t("aiPromisedN")})`), h("li", {}, t("aiTargetsIncluded"))),
      h("label", { class: "field" }, h("span", {}, t("aiExtra")), extra, h("span", { class: "meta" }, t("aiExtraHelp"))),
      h("button", { class: "btn sm", type: "button", onClick: async () => {
        // show exactly what will be sent, including the instructions typed above
        if (pre.hidden) { try { const pv = await api("/admin/ai-schedule", { method: "POST", body: reqBody(extra.value, true) }); pre.textContent = `${pv.system}\n\n${pv.user}`; } catch (e) { toast(errorText(e)); return; } }
        pre.hidden = !pre.hidden;
      } }, t("aiShowPrompt")), pre,
      h("p", { class: "meta" }, t("aiPrivacy")),
      sm.existing_next_week ? h("p", { class: "alert" }, `${sm.existing_next_week} ${t("aiExistingWarn")}`) : null,
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onClick: generate }, `✨ ${t("aiGenerate")}`)));
  }

  async function generate() {
    body.replaceChildren(h("div", { class: "ai-wait" }, h("div", { class: "spinner" }), h("p", {}, t("aiWorking")), h("p", { class: "meta" }, t("aiWorkingHelp"))));
    try { review(await api("/admin/ai-schedule", { method: "POST", body: reqBody(extra.value, false) })); }
    catch (e) {
      const msg = { no_ai_key: t("aiNoKey"), ai_failed: t("aiFailed"), ai_bad_answer: t("aiBadAnswer"), nothing_to_schedule: t("aiNothing") }[e.body?.error] ?? errorText(e);
      body.replaceChildren(h("div", { class: "alert", role: "alert" }, msg), h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: setup }, t("aiBack"))));
    }
  }

  function review(res) {
    const names = new Map(res.employees.map((x) => [x.id, x]));
    const shifts = [...res.proposal.shifts].sort((a, b) => (a.start_at < b.start_at ? -1 : 1));
    const days = Array.from({ length: 7 }, (_, i) => addDays(target, i));
    const warnByStaffDay = new Set(res.warnings.filter((w) => w.staff_id && w.date).map((w) => `${w.staff_id}|${w.date}`));
    const replace = h("input", { type: "checkbox", checked: res.summary.existing_next_week > 0 });
    const hoursOf = (x) => (Date.parse(`${x.end_at}:00Z`) - Date.parse(`${x.start_at}:00Z`)) / 3_600_000;
    const perPerson = res.employees.map((e) => ({ e, h: shifts.filter((x) => x.staff_id === e.id).reduce((n, x) => n + hoursOf(x), 0) })).filter((x) => x.h > 0 || x.e.promised_hours);
    body.replaceChildren(
      h("p", { class: "ai-summary" }, res.proposal.summary || t("aiNoSummary")),
      res.proposal.concerns.length ? h("div", { class: "alert" }, h("strong", {}, t("aiConcerns")), h("ul", {}, res.proposal.concerns.map((c) => h("li", {}, c)))) : null,
      res.warnings.length ? h("details", { class: "alert", open: true }, h("summary", {}, `⚠ ${res.warnings.length} ${t("aiWarnings")}`), h("ul", {}, res.warnings.slice(0, 60).map((w) => h("li", {}, w.text)))) : h("div", { class: "okmsg" }, t("aiNoWarnings")),
      res.dropped ? h("p", { class: "meta" }, `${res.dropped} ${t("aiDropped")}`) : null,
      h("h3", {}, `${shifts.length} ${t("aiShiftsProposed")}`),
      ...days.map((d) => { const list = shifts.filter((x) => x.start_at.startsWith(d)); return list.length ? h("div", { class: "ai-day" }, h("h4", {}, fmt(d, { weekday: "long", day: "numeric", month: "long" })),
        list.map((x) => { const e = names.get(x.staff_id); const role = state.roles.find((r) => r.id === x.role_id);
          return h("div", { class: `ai-shift ${warnByStaffDay.has(`${x.staff_id}|${d}`) ? "warn" : ""}` }, h("b", {}, e?.first_name ?? x.staff_id), ` ${hhmm(x.start_at)}–${hhmm(x.end_at)} `, role ? roleIcon(role) : "", ` ${role ? roleName(role) : ""}`); })) : null; }),
      h("h4", {}, t("aiHoursPerPerson")),
      h("div", { class: "log" }, perPerson.map(({ e, h: hh }) => h("div", { class: "log-row" }, h("span", {}, e.first_name), h("b", {}, `${Math.round(hh * 10) / 10} h${e.promised_hours != null ? ` / ${e.promised_hours} h` : ""}`)))),
      h("label", { class: "check" }, replace, h("span", {}, t("aiReplace"))),
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "button", onClick: setup }, t("aiBack")),
        h("button", { class: "btn primary", type: "button", onClick: async () => {
          if (!await confirmDialog({ title: t("aiApplyTitle"), message: `${t("aiApplyQuestion")} ${weekLabel(target)} ?${replace.checked ? ` ${t("aiApplyReplace")}` : ""}`, yes: t("yesApply"), no: t("cancel") })) return;
          try {
            const r = await api("/admin/ai-schedule/apply", { method: "POST", body: { restaurant_id: restaurantId, departments, week: target, replace: replace.checked, shifts: shifts.map((x) => ({ staff_id: x.staff_id, role_id: x.role_id, start_at: x.start_at, end_at: x.end_at, until_close: x.until_close, notes: x.notes })) } });
            toast(`${r.created} ${t("aiCreated")}${r.skipped.length ? ` · ${r.skipped.length} ${t("aiSkipped")}` : ""}`);
            state.sel.week = target; state.sel.day = target; dlg.close(); render();
          } catch (e) { toast(errorText(e)); }
        } }, t("aiApply"))));
  }
  dlg.showModal();
  setup();
}

// ---- leave requests, shared by Administration → Demandes de congé and the employee dialog ----
// Dates: desktop "26 octobre" (both years when it spans two), mobile short with the year only on the second date.
function leaveDates(r) {
  const twoYears = r.start_date.slice(0, 4) !== r.end_date.slice(0, 4);
  const tail = r.start_time ? ` · ${r.start_time}–${r.end_time}` : "";
  if (mqDesktop.matches) {
    const d = (x, y) => fmt(x, { day: "numeric", month: "long", ...(y ? { year: "numeric" } : {}) });
    return (r.start_date === r.end_date ? d(r.start_date, false) : `${d(r.start_date, twoYears)} → ${d(r.end_date, twoYears)}`) + tail;
  }
  const m = (x, y) => fmt(x, { weekday: "short", day: "numeric", month: "short", ...(y ? { year: "numeric" } : {}) });
  return (r.start_date === r.end_date ? m(r.start_date, false) : `${m(r.start_date, false)} → ${m(r.end_date, twoYears)}`) + tail;
}
const leaveStatusText = (st) => ({ requested: t("offRequested"), approved: t("offApproved"), denied: t("offDenied") }[st] ?? st);
// One request on one line: [name] dates · status · note, buttons at the right (columns line up from row to row).
function leaveRow(r, { name, actions }) {
  const note = [r.note, r.decision_note].filter(Boolean).join(" · ");
  return h("div", { class: "cov-row leave-row" },
    h("div", { class: `leave-main ${name ? "with-name" : ""}` }, name ? h("b", { class: "lv-name" }, name) : null, h("span", { class: "lv-dates" }, leaveDates(r)),
      h("span", { class: `leave-status ${r.status}` }, leaveStatusText(r.status)), note ? h("span", { class: "meta lv-note" }, note) : null),
    actions);
}
// Sub-cards "À traiter / Accordé / Refusé".
function leaveGroups(rows, makeRow) {
  return [["requested", t("toAnswer")], ["approved", t("grantedWord")], ["denied", t("declinedWord")]].map(([st, title]) => {
    const list = rows.filter((r) => r.status === st);
    return h("div", { class: "leave-group" }, h("h3", {}, `${title} (${list.length})`), list.length ? list.map(makeRow) : h("p", { class: "meta" }, t("nothingToReview")));
  });
}

// Time off of one employee, inside the employee dialog: list with approve / decline / withdraw, and a quick "add leave".
function staffTimeOff(person) {
  const box = h("div", {});
  async function load() {
    const rows = await api(`/time-off/staff/${person.id}`);
    const today = ymd(new Date());
    const from = h("input", { type: "date", value: today }), to = h("input", { type: "date", value: today });
    const allDay = h("input", { type: "checkbox", checked: true });
    const ts = timeField("14:00"), te = timeField("21:00");
    const timeBox = h("div", { class: "time-pair", hidden: true }, h("label", { class: "field" }, h("span", {}, t("start")), ts), h("label", { class: "field" }, h("span", {}, t("end")), te));
    allDay.addEventListener("change", () => { timeBox.hidden = allDay.checked; });
    const act = async (fn) => { try { await fn(); load(); } catch (e) { toast(errorText(e)); } };
    box.replaceChildren(
      // counts on top, then every request in date order
      h("p", { class: "leave-counts" }, [["requested", t("toAnswer")], ["approved", t("grantedWord")], ["denied", t("declinedWord")]].map(([st, label]) => h("span", { class: `leave-status ${st}` }, `${label} (${rows.filter((r) => r.status === st).length})`))),
      ...(rows.length ? [...rows].sort((a, b) => a.start_date.localeCompare(b.start_date) || (a.start_time ?? "").localeCompare(b.start_time ?? "")) : []).map((r) => leaveRow(r, { actions: h("div", { class: "row-icons" },
        r.status !== "approved" ? h("button", { class: "icon-btn avail-del", type: "button", title: t("approve"), "aria-label": t("approve"), onClick: () => act(() => api(`/time-off/${r.id}/decide`, { method: "POST", body: { approve: true } })) }, "✅") : null,
        r.status !== "denied" ? h("button", { class: "icon-btn avail-del", type: "button", title: t("deny"), "aria-label": t("deny"), onClick: () => act(() => api(`/time-off/${r.id}/decide`, { method: "POST", body: { approve: false } })) }, "❌") : null,
        h("button", { class: "icon-btn avail-del", type: "button", title: t("delete"), "aria-label": t("delete"), onClick: async () => { if ((await ask(t("confirmCancelOff")))) act(() => api(`/time-off/${r.id}/withdraw`, { method: "POST" })); } }, "🗑️")) })),
      ...(rows.length ? [] : [h("p", { class: "meta" }, t("noTimeOff"))]),
      h("h4", {}, t("addLeaveFor")),
      h("div", { class: "inline-form", style: "grid-template-columns:1fr" },
        h("label", { class: "check" }, allDay, h("span", {}, t("allDay"))),
        h("div", { class: "inline-form date-time-line" }, h("label", { class: "field" }, h("span", {}, t("fromDate")), from), h("label", { class: "field" }, h("span", {}, t("toDate")), to), timeBox),
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
// Dates last used for an unavailability, per employee: they become the default for the next one.
const availDates = new Map();
function availabilityEditor(staffId, part = "both") {
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
    const lastDates = availDates.get(staffId) ?? {};
    const vf = h("input", { type: "date", value: lastDates.from ?? "" }), vt = h("input", { type: "date", value: lastDates.to ?? "" });
    const list = rows.filter((r) => r.kind !== "day_off");
    const daysPart = [
      h("h4", {}, t("fixedDaysOff")), h("p", { class: "meta" }, t("fixedDaysOffHelp")), days,
      // On each fixed day off: can this person still be asked to cover a sick colleague that day?
      [...dayOffs.entries()].sort((a, b) => a[0] - b[0]).map(([i, r]) => h("label", { class: "check" },
        h("input", { type: "checkbox", checked: !!r.replacement_ok, onChange: async (e) => { try { await api(`/availability/${r.id}`, { method: "PUT", body: { replacement_ok: e.target.checked } }); toast(t("saved")); } catch (err) { e.target.checked = !e.target.checked; toast(errorText(err)); } } }),
        h("span", {}, `${weekdayName(i)} : ${t("replacementOk")}`)))];
    const timesPart = [
      h("h4", {}, t("unavailableTimes")), h("p", { class: "meta" }, t("unavailableHelp")),
      list.length ? h("div", { class: "log" }, list.map((r) => h("div", { class: "log-row avail-row" },
        h("div", { class: "avail-text" },
          h("span", {}, h("b", {}, weekdayName(r.dow)), ` ${r.start_time}–${r.end_time}${r.note ? ` · ${r.note}` : ""}`),
          r.valid_from || r.valid_to ? h("span", { class: "meta" }, `${r.valid_from ? longDate(r.valid_from) : "…"} → ${r.valid_to ? longDate(r.valid_to) : "…"}`) : null),
        h("button", { class: "icon-btn avail-del", type: "button", title: t("delete"), "aria-label": t("delete"), onClick: async () => { await api(`/availability/${r.id}`, { method: "DELETE" }); load(); } }, "🗑️")))) : h("p", { class: "meta" }, t("noUnavailable")),
      h("div", { class: "inline-form", style: "grid-template-columns:1fr" },
        h("div", { class: "inline-form day-time-line" }, h("label", { class: "field" }, h("span", {}, t("weekday")), dow), h("label", { class: "field" }, h("span", {}, t("from")), st), h("label", { class: "field" }, h("span", {}, t("to")), en)),
        h("div", { class: "inline-form", style: "grid-template-columns:1fr 1fr" }, h("label", { class: "field" }, h("span", {}, t("validFrom")), vf), h("label", { class: "field" }, h("span", {}, t("validTo")), vt)),
        h("label", { class: "field" }, h("span", {}, t("note")), note),
        h("button", { class: "btn primary", type: "button", onClick: async () => {
          try { await api("/availability", { method: "POST", body: { staff_id: staffId, dow: Number(dow.value), start_time: st.value, end_time: en.value, note: note.value, valid_from: vf.value || undefined, valid_to: vt.value || undefined } }); availDates.set(staffId, { from: vf.value, to: vt.value }); load(); }
          catch (e) { toast(e.body?.error === "invalid_times" ? t("opensBeforeCloses") : errorText(e)); }
        } }, t("add")))];
    box.replaceChildren(...(part === "daysoff" ? daysPart : part === "times" ? timesPart : [...daysPart, ...timesPart]));
  }
  load().catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

// Time-off requests and decisions, as a list of blocks (shown in Mon compte → Congés).
async function timeOffNodes(part = "mine") {
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
      r.status === "requested" || r.status === "approved" ? h("button", { class: "btn", type: "button", onClick: async () => { if ((await ask(t("confirmCancelOff")))) { await api(`/time-off/${r.id}/cancel`, { method: "POST" }); render(); } } }, t("cancel")) : null))
    : h("p", { class: "meta" }, t("noTimeOff")));
  const decide = async (r, approve) => {
    const asked = await promptDialog({ title: t("decisionNote"), label: t("optional") });
    if (asked === null) return; // cancelled
    const dn = asked;
    try {
      const res = await api(`/time-off/${r.id}/decide`, { method: "POST", body: { approve, note: dn } });
      toast(res.shifts_on_those_days ? `${t("saved")} — ⚠ ${res.shifts_on_those_days} ${t("shiftsOnThoseDays")}` : t("saved")); render();
    } catch (e) { toast(errorText(e)); }
  };
  const reviewRow = (r) => leaveRow(r, { name: r.staff_name, actions: h("div", { class: "actions" },
    r.status !== "approved" ? h("button", { class: "btn primary", type: "button", onClick: () => decide(r, true) }, t("approve")) : null,
    r.status !== "denied" ? h("button", { class: "btn danger", type: "button", onClick: () => decide(r, false) }, t("deny")) : null) });
  const reviewBox = review.length || state.me.managed.length || state.me.me.is_admin ? h("section", { class: "panel" }, h("h2", {}, t("timeOffRequests")),
    ...leaveGroups(review, reviewRow)) : null;
  // administrators decide in Administration → Congés; managers (no Administration access) keep the list here
  if (part === "review") return [reviewBox ?? h("p", { class: "meta" }, t("nothingToReview"))];
  return [form, myList, state.me.me.is_admin ? null : reviewBox].filter(Boolean);
}

// ---------- Communities ----------
// A message board per restaurant and group of departments; people are in the ones matching their roles.
const timeAgo = (iso) => new Date(iso).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
async function renderCommunity() {
  const list = await api("/communities");
  if (!list.length) { $app.replaceChildren(h("div", { class: "account" }, h("h2", {}, t("community")), h("div", { class: "empty" }, t("noCommunity")))); return; }
  if (!list.some((x) => x.id === state.communityId)) state.communityId = (list.find((x) => x.unread) ?? list[0]).id;
  const manyRestos = new Set(list.map((x) => x.restaurant_id)).size > 1;
  const short = (n) => n.split(/-des-|\sdes\s/)[0];
  const feed = h("div", { class: "comm-feed" });
  const pills = h("div", { class: "comm-pills", role: "tablist" }, list.map((x) =>
    h("button", { type: "button", role: "tab", "aria-selected": String(x.id === state.communityId), onClick: () => { state.communityId = x.id; renderCommunity(); } },
      manyRestos ? `${short(x.restaurant)} · ${x.name}` : x.name, x.unread && x.id !== state.communityId ? h("span", { class: "nav-badge" }, String(x.unread)) : null)));
  const id = state.communityId;
  let moderator = false;
  const body = h("textarea", { maxLength: 2000, rows: 2, placeholder: t("writePost"), "aria-label": t("writePost") });
  const compose = h("form", { class: "comm-compose", onSubmit: async (e) => {
    e.preventDefault();
    if (!body.value.trim()) return;
    try { await api(`/communities/${id}/posts`, { method: "POST", body: { body: body.value } }); body.value = ""; await load(); } catch (err) { toast(errorText(err)); }
  } }, body, h("button", { class: "btn primary", type: "submit" }, t("publishPost")));
  const author = (x) => h("div", { class: "post-who" }, avatar(x.staff_id, x.author, x.color, x.photo_v, 34), h("div", {}, h("b", {}, x.first_name || x.author), h("span", { class: "meta" }, ` · ${timeAgo(x.created_at)}`)));
  const del = (x) => x.can_delete ? h("button", { class: "btn sm danger", type: "button", onClick: async () => { if (await ask(t("confirmDeletePost"))) { try { await api(`/community-posts/${x.id}`, { method: "DELETE" }); await load(); } catch (e) { toast(errorText(e)); } } } }, t("delete")) : null;
  const postCard = (x) => {
    const replyBox = h("form", { class: "comm-reply", hidden: true, onSubmit: async (e) => {
      e.preventDefault();
      const input = e.target.querySelector("input"); if (!input.value.trim()) return;
      try { await api(`/communities/${id}/posts`, { method: "POST", body: { body: input.value, parent_id: x.id } }); await load(); } catch (err) { toast(errorText(err)); }
    } }, h("input", { maxLength: 2000, placeholder: t("writeReply"), "aria-label": t("writeReply") }), h("button", { class: "btn sm primary", type: "submit" }, t("send")));
    return h("article", { class: `post ${x.pinned ? "pinned" : ""}` },
      x.pinned ? h("div", { class: "post-pin" }, `📌 ${t("pinned")}`) : null,
      author(x), h("p", { class: "post-body" }, x.body),
      h("div", { class: "post-actions" },
        h("button", { class: "btn sm", type: "button", onClick: () => { replyBox.hidden = !replyBox.hidden; if (!replyBox.hidden) replyBox.querySelector("input").focus(); } }, t("reply")),
        moderator ? h("button", { class: "btn sm", type: "button", onClick: async () => { try { await api(`/community-posts/${x.id}/pin`, { method: "PUT", body: { pinned: !x.pinned } }); await load(); } catch (e) { toast(errorText(e)); } } }, x.pinned ? t("unpin") : t("pin")) : null,
        del(x)),
      x.replies.length ? h("div", { class: "post-replies" }, x.replies.map((r) => h("div", { class: "reply" }, author(r), h("p", { class: "post-body" }, r.body), h("div", { class: "post-actions" }, del(r))))) : null,
      replyBox);
  };
  let posts = [];
  async function load() {
    const d = await api(`/communities/${id}/posts`);
    moderator = d.moderator; posts = d.posts;
    paint(d.more);
    state.communityUnread = Math.max(0, (state.communityUnread ?? 0) - (list.find((x) => x.id === id)?.unread ?? 0)); list.find((x) => x.id === id).unread = 0; renderChrome();
  }
  function paint(more) {
    feed.replaceChildren(...(posts.length ? posts.map(postCard) : [h("div", { class: "empty" }, t("noPosts"))]),
      ...(more ? [h("button", { class: "btn", type: "button", onClick: async () => {
        const older = await api(`/communities/${id}/posts?before=${posts[posts.length - 1].id}`);
        posts = [...posts, ...older.posts]; paint(older.more);
      } }, t("olderPosts"))] : []));
  }
  $app.replaceChildren(h("div", { class: "account community" }, h("h2", {}, t("community")), pills, compose, feed));
  await load();
}

// "Install the app": Chrome, Edge and Android offer a prompt we can trigger; iPhone and Safari need the Share menu, so we explain it.
let installEvent = null;
const installListeners = new Set();
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; installListeners.forEach((f) => f()); });
window.addEventListener("appinstalled", () => { installEvent = null; installListeners.forEach((f) => f()); });
function installControls() {
  const box = h("div", { class: "install-box" });
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const draw = () => {
    if (!box.isConnected && box.dataset.drawn) { installListeners.delete(draw); return; }
    box.dataset.drawn = "1";
    if (standalone()) { box.replaceChildren(h("p", { class: "meta" }, `✓ ${t("installDone")}`)); return; }
    if (installEvent) {
      box.replaceChildren(h("p", { class: "meta" }, t("installHelp")),
        h("div", { class: "actions push-actions" }, h("button", { class: "btn primary", type: "button", onClick: async () => {
          installEvent.prompt();
          try { await installEvent.userChoice; } catch { /* closed */ }
          installEvent = null; draw();
        } }, `⬇ ${t("installApp")}`)));
      return;
    }
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const safariMac = /Macintosh/.test(navigator.userAgent) && /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    box.replaceChildren(h("p", { class: "meta" }, ios ? t("installIos") : safariMac ? t("installSafari") : t("installOther")));
  };
  installListeners.add(draw);
  draw();
  return box;
}

// Notifications on this device (phone, Windows / macOS notification panel).
function pushControls() {
  const box = h("div", { class: "push-box" });
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const iosBrowser = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(navigator.standalone || matchMedia("(display-mode: standalone)").matches);
  const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  async function draw() {
    if (!supported || iosBrowser) { box.replaceChildren(h("p", { class: "meta" }, iosBrowser ? t("pushIos") : t("pushUnsupported"))); return; }
    let reg, sub = null;
    try { reg = await navigator.serviceWorker.ready; sub = await reg.pushManager.getSubscription(); } catch { box.replaceChildren(h("p", { class: "meta" }, t("pushUnsupported"))); return; }
    const on = !!sub && Notification.permission === "granted";
    const status = await api(`/push/status?endpoint=${encodeURIComponent(sub?.endpoint ?? "")}`).catch(() => ({ devices: 0, this_device: false }));
    box.replaceChildren(
      h("p", { class: "meta" }, Notification.permission === "denied" ? t("pushDenied") : on && status.this_device ? t("pushOn") : t("pushOff")),
      h("div", { class: "actions push-actions" },
        on && status.this_device
          ? [h("button", { class: "btn", type: "button", onClick: async () => { try { await api("/push/test", { method: "POST" }); toast(t("pushTestSent")); } catch (e) { toast(errorText(e)); } } }, t("pushTest")),
             h("button", { class: "btn danger", type: "button", onClick: async () => { try { await api("/push/subscribe", { method: "DELETE", body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); } catch (e) { toast(errorText(e)); } draw(); } }, t("pushDisable"))]
          : Notification.permission === "denied" ? [] : [h("button", { class: "btn primary", type: "button", onClick: async () => {
              try {
                if ((await Notification.requestPermission()) !== "granted") { draw(); return; }
                const { publicKey } = await api("/push/key");
                const made = sub ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
                await api("/push/subscribe", { method: "POST", body: made.toJSON() });
                toast(t("saved"));
              } catch (e) { toast(errorText(e)); }
              draw();
            } }, t("pushEnable"))]));
  }
  draw();
  return box;
}

async function renderAccount() {
  const acc = await api("/account");
  const phone = h("input", { type: "tel", value: acc.phone ?? "", autocomplete: "tel" });
  phone.value = formatPhone(acc.phone);
  phone.addEventListener("blur", () => { phone.value = formatPhone(phone.value); });
  const lang = radioGroup("acc-lang", [["fr", "Français"], ["en", "English"]], acc.lang);
  const channel = radioGroup("acc-chan", [["sms", t("sms")], ["email", t("emailCh")]], acc.notify_channel);
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
        h("button", { class: "btn", type: "button", onClick: async () => { if ((await ask(t("confirmNewLink")))) drawCal((await api("/account/calendar-token", { method: "POST" })).calendar_url); } }, t("newLink")),
        h("button", { class: "btn danger", type: "button", onClick: async () => { await api("/account/calendar-token", { method: "DELETE" }); drawCal(null); } }, t("stopSharing"))),
    ] : [h("button", { class: "btn primary", type: "button", onClick: async () => drawCal((await api("/account/calendar-token", { method: "POST" })).calendar_url) }, t("createLink"))]));
  };
  drawCal(acc.calendar_url);
  const slipsBox = h("div", {}, h("p", { class: "meta" }, t("loading")));
  api("/payslips").then((rows) => slipsBox.replaceChildren(rows.length ? h("div", { class: "log" }, rows.map((r) =>
    h("a", { class: "log-row slip-link", href: `/api/payslips/${r.id}/pdf`, target: "_blank", rel: "noopener" }, h("span", {}, r.pay_date ?? r.filename), h("span", { class: "meta" }, `${r.period_label ?? ""} · PDF`)))) : h("p", { class: "meta" }, t("noPayslips"))))
    .catch(() => slipsBox.replaceChildren(h("p", { class: "meta" }, t("genericError"))));
  // Mobile-first, tab-based screen (same tabs as the employee dialog, limited to what the employee may change).
  const profile = h("form", { class: "acc-form", onSubmit: save },
    h("h3", {}, acc.name), h("p", { class: "meta" }, `${t("loginAs")} ${acc.email ?? "—"}`),
    h("label", { class: "field acc-phone" }, h("span", {}, t("phone")), phone, h("span", { class: "meta" }, t("phoneHelp"))),
    h("div", { class: "field" }, h("span", {}, t("language")), lang),
    h("div", { class: "field" }, h("span", {}, t("notifyBy")), channel),
    h("div", { class: "field push-field" }, h("span", {}, t("installTitle")), installControls()),
    h("div", { class: "field push-field" }, h("span", {}, t("pushTitle")), pushControls()),
    h("button", { class: "btn primary", type: "submit" }, t("save")),
    h("button", { class: "btn", type: "button", onClick: async () => { await api("/auth/logout", { method: "POST" }).catch(() => {}); state.me = null; renderLogin(); } }, t("logout")));
  const tabs = [
    ["profile", t("details"), () => [profile]],
    ["daysoff", t("tabDaysOff"), () => [availabilityEditor(state.me.me.id, "daysoff")]],
    ["availability", t("tabAvailability"), () => [availabilityEditor(state.me.me.id, "times")]],
    ["timeoff", t("timeOff"), () => { const box = h("div", { class: "acc-content" }, h("p", { class: "meta" }, t("loading"))); timeOffNodes().then((n) => box.replaceChildren(...n)).catch((e) => box.replaceChildren(h("p", { class: "meta" }, errorText(e)))); return [box]; }],
    ["calendar", t("tabCalendar"), () => [h("p", { class: "meta" }, t("calendarHelp")), calBox]],
    ["payslips", t("tabPayslips"), () => [slipsBox]],
  ];
  state.accountTab = tabs.some(([id]) => id === state.accountTab) ? state.accountTab : "profile";
  const bar = h("div", { class: "dlg-tabs acc-tabs", role: "tablist" });
  const content = h("div", { class: "acc-content" });
  const draw = () => {
    bar.replaceChildren(...tabs.map(([id, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(state.accountTab === id), onClick: () => { state.accountTab = id; draw(); } }, label)));
    content.replaceChildren(...tabs.find(([id]) => id === state.accountTab)[2]());
  };
  draw();
  $app.replaceChildren(h("div", { class: "account" }, h("h2", {}, t("account")), bar, content));
}

async function renderMine() {
  const sel = state.sel;
  const data = await api(`/my-shifts?week=${sel.week}`);
  const nav = h("div", { class: "weeknav", style: "margin-bottom:1rem" },
    h("button", { class: "icon-btn", type: "button", "aria-label": t("prev"), onClick: () => { sel.week = addDays(sel.week, -7); render(); } }, "‹"),
    h("div", { class: "label" }, weekLabel(sel.week)),
    h("button", { class: "icon-btn", type: "button", "aria-label": t("next"), onClick: () => { sel.week = addDays(sel.week, 7); render(); } }, "›"));
  // Hours and gross pay of the week (their own rate; overtime hours are flagged).
  const over = data.total_hours > (data.limits?.overtime_hours ?? 40);
  const myHours = h("div", { class: `payroll my-pay ${over ? "over" : ""}` },
    h("h3", {}, t("myWeekHours")),
    h("div", { class: "row" }, h("span", {}, t("totalHours")), h("b", {}, `${hrs(data.total_hours)} ${t("hoursShort")}${over ? " ⚠" : ""}`)),
    h("div", { class: "row" }, h("span", {}, t("grossSalary")), h("b", {}, data.unrated_hours > 0 && !data.gross_cents ? "—" : money(data.gross_cents ?? 0, true))),
    data.unrated_hours > 0 ? h("div", { class: "meta" }, `${hrs(data.unrated_hours)} ${t("hoursShort")} ${t("noRateForHours")}`) : null);
  const days = Array.from({ length: 7 }, (_, i) => addDays(sel.week, i)).filter((d) => data.shifts.some((s) => dayOf(s.start_at) === d));
  const body = days.length
    ? days.map((d) => h("section", { class: "mine-day" }, h("h2", {}, fmt(d, { weekday: "long", day: "numeric", month: "long" })),
        h("div", { class: "list" }, data.shifts.filter((s) => dayOf(s.start_at) === d).map((s) =>
          // desktop: the date sits on the left, the shift cards on the right, and each card has its "Je serai absent" button on its right
          h("div", { class: "card mine-card" },
            h("div", { class: "mine-info" }, h("span", { class: "time" }, range(s)),
              h("span", { class: "who" }, `${s.restaurant} · ${t(`dept.${s.department_id}`)}`),
              h("span", { class: "meta" }, [`${roleIcon(s)} ${roleName(s)}`, s.notes].filter(Boolean).join(" · ")), s.status === "sick_open" ? h("span", { class: "sick-badge" }, `🚫 ${t("sickOpen")}`) : null),
            s.status === "ok" && s.end_at > nowLocal() ? h("button", { class: "btn sick-btn", type: "button", onClick: async () => {
              const why = await absenceDialog();
              if (!why) return;
              try { await api(`/shifts/${s.id}/sick`, { method: "POST", body: why }); toast(t("sickStarted")); render(); } catch (e) { toast(e.body?.error === "already_sick" ? t("alreadySick") : errorText(e)); }
            } }, `🚫 ${t("imAbsent")}`) : null)))))
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
        h("button", { class: "btn danger", type: "button", onClick: async () => { if ((await ask(t("confirmDeleteIncident")))) { await api(`/admin/incidents/${i.id}`, { method: "DELETE" }); load(); } } }, t("delete"))))) : h("div", { class: "empty" }, t("noIncidents")));
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
          h("button", { class: "btn danger", type: "button", onClick: async () => { if ((await ask(t("confirmDeleteSlip")))) { await api(`/admin/payslips/${r.id}`, { method: "DELETE" }); load(); } } }, t("delete"))));
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

// Webhooks: the CRM is told when something changes. Each delivery is signed; failures are retried.
function webhooksPanel() {
  const box = h("div", {});
  const when = (ms) => new Date(ms).toLocaleString(getLang() === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short" });
  const errMsg = (e) => ({ https_required: t("whInvalidUrl"), invalid_url: t("whInvalidUrl"), ip_not_allowed: t("whInvalidUrl"), host_not_allowed: t("whInvalidUrl"), too_many_endpoints: t("whTooMany") })[e.body?.error] ?? errorText(e);
  const open = new Set();
  async function load(secret) {
    const [rows, events] = await Promise.all([api("/admin/webhooks"), api("/webhooks/events")]);
    const name = h("input", { required: true, maxLength: 60, placeholder: t("whName") });
    const url = h("input", { required: true, type: "url", maxLength: 500, placeholder: "https://crm.exemple.com/webhooks/ams" });
    const all = h("input", { type: "checkbox", checked: true });
    const boxes = events.map((ev) => ({ ev, input: h("input", { type: "checkbox", checked: true }) }));
    all.addEventListener("change", () => boxes.forEach((b) => { b.input.checked = all.checked; }));
    const reveal = secret ? h("div", { class: "panel token-reveal", role: "status" }, h("b", {}, t("whSecretOnce")),
      h("input", { readonly: true, value: secret, onClick: (e) => e.target.select() }),
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onClick: async () => { try { await navigator.clipboard.writeText(secret); toast(t("copied")); } catch { toast(secret); } } }, t("apiCopy")))) : null;
    const logBox = (r) => { const el = h("div", { class: "log" }, h("p", { class: "meta" }, t("loading"))); api(`/admin/webhooks/${r.id}/deliveries`).then((ds) => el.replaceChildren(...(ds.length ? ds.map((d) => h("div", { class: "log-row avail-row" },
      h("div", { class: "avail-text" }, h("span", {}, h("b", {}, d.event), ` · ${d.status}${d.response_code ? ` (${d.response_code})` : ""}${d.error && !d.response_code ? ` · ${d.error}` : ""}`), h("span", { class: "meta" }, `${when(d.created_at)} · ${d.attempts}×`)),
      d.status === "failed" ? h("button", { class: "btn", type: "button", onClick: async () => { await api(`/admin/webhooks/${r.id}/deliveries/${d.id}/retry`, { method: "POST" }).catch((e) => toast(errMsg(e))); load(); } }, t("whRetry")) : null)) : [h("p", { class: "meta" }, "—")]))).catch(() => {}); return el; };
    box.replaceChildren(
      h("section", { class: "panel" }, h("h2", {}, t("adminWebhooks")), h("p", { class: "meta" }, t("whHelp")), reveal,
        rows.length ? rows.map((r) => h("div", { class: "panel", style: "margin:.5rem 0" },
          h("div", { class: "avail-row log-row" },
            h("div", { class: "avail-text" },
              h("div", {}, h("b", {}, r.name), r.active ? null : h("span", { class: "badge", style: "margin-left:.4rem" }, t("whPaused"))),
              h("div", { class: "meta", style: "word-break:break-all" }, r.url),
              h("div", { class: "meta" }, `${r.events.includes("*") ? t("whAll") : r.events.join(", ")} · whsec_${r.secret_hint}`),
              r.failures ? h("div", { class: "meta" }, `⚠ ${r.failures} ${t("whFailures")}${r.active ? "" : ` — ${t("whDisabledAuto")}`}`) : null,
              r.last_delivery ? h("div", { class: "meta" }, `${t("whLastDelivery")} : ${r.last_delivery.status}${r.last_delivery.code ? ` (${r.last_delivery.code})` : ""} · ${when(r.last_delivery.at)}`) : null)),
          h("div", { class: "actions" },
            h("button", { class: "btn", type: "button", onClick: async () => { try { const d = await api(`/admin/webhooks/${r.id}/test`, { method: "POST" }); toast(d.status === "sent" ? `${t("whTestOk")} ${d.response_code ?? 200}` : `${t("whTestFail")} ${d.error ?? d.status}`); load(); } catch (e) { toast(errMsg(e)); } } }, t("whTest")),
            h("button", { class: "btn", type: "button", onClick: () => { open.has(r.id) ? open.delete(r.id) : open.add(r.id); load(); } }, t("whLog")),
            h("button", { class: "btn", type: "button", onClick: async () => { await api(`/admin/webhooks/${r.id}`, { method: "PUT", body: { active: !r.active } }); load(); } }, r.active ? t("whPause") : t("whResume")),
            h("button", { class: "btn", type: "button", onClick: async () => { if (!(await confirmDialog({ title: t("whRotate"), message: t("whRotateConfirm"), yes: t("whRotate"), no: t("cancel") }))) return; const x = await api(`/admin/webhooks/${r.id}`, { method: "PUT", body: { rotate_secret: true } }); load(x.secret); } }, t("whRotate")),
            h("button", { class: "btn danger", type: "button", onClick: async () => { if (!(await confirmDialog({ title: t("whDelete"), message: t("whDeleteConfirm"), yes: t("whDelete"), no: t("cancel") }))) return; await api(`/admin/webhooks/${r.id}`, { method: "DELETE" }); load(); } }, t("whDelete"))),
          open.has(r.id) ? logBox(r) : null)) : h("p", { class: "meta" }, t("whNone"))),
      h("section", { class: "panel" }, h("h3", {}, t("whNew")),
        h("form", { class: "acc-form", onSubmit: async (e) => {
          e.preventDefault();
          try { const x = await api("/admin/webhooks", { method: "POST", body: { name: name.value, url: url.value, events: all.checked ? ["*"] : boxes.filter((b) => b.input.checked).map((b) => b.ev) } }); load(x.secret); }
          catch (err) { toast(errMsg(err)); }
        } }, h("label", { class: "field" }, h("span", {}, t("whName")), name), h("label", { class: "field" }, h("span", {}, t("whUrl")), url),
          h("div", { class: "field" }, h("span", {}, t("whEvents")), h("label", { class: "check" }, all, h("span", {}, t("whAll"))), h("div", { class: "wh-events" }, boxes.map((b) => h("label", { class: "check" }, b.input, h("span", {}, b.ev))))),
          h("button", { class: "btn primary", type: "submit" }, t("whCreate")))));
  }
  load().catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

// API tokens for other systems (the CRM): created here, shown once, revocable.
function apiPanel() {
  const box = h("div", {});
  const when = (ms) => new Date(ms).toLocaleString(getLang() === "fr" ? "fr-CA" : "en-CA", { dateStyle: "medium", timeStyle: "short" });
  async function load(fresh) {
    const rows = await api("/admin/tokens");
    const name = h("input", { required: true, maxLength: 60, placeholder: t("apiName") });
    const scope = radioGroup("api-scope", [["read", t("apiRead")], ["write", t("apiWrite")]], "read");
    const base = location.origin;
    const reveal = fresh ? h("div", { class: "panel token-reveal", role: "status" },
      h("b", {}, t("apiShownOnce")),
      h("input", { readonly: true, value: fresh.token, onClick: (e) => e.target.select(), "aria-label": fresh.name }),
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onClick: async () => { try { await navigator.clipboard.writeText(fresh.token); toast(t("copied")); } catch { toast(fresh.token); } } }, t("apiCopy")))) : null;
    box.replaceChildren(
      h("section", { class: "panel" }, h("h2", {}, t("adminApi")), h("p", { class: "meta" }, t("apiHelp")), reveal,
        rows.length ? rows.map((r) => h("div", { class: `cov-row avail-row ${r.revoked_at ? "inactive" : ""}` },
          h("div", { class: "avail-text" },
            h("div", {}, h("b", {}, r.name), h("span", { class: "badge", style: "margin-left:.4rem" }, r.scope === "read" ? t("apiRead") : t("apiWrite")), r.revoked_at ? h("span", { class: "badge", style: "margin-left:.4rem" }, t("apiRevoked")) : null),
            h("div", { class: "meta" }, `ams_…${r.hint} · ${when(r.created_at)} · ${t("apiLastUsed")} : ${r.last_used_at ? when(r.last_used_at) : t("apiNeverUsed")}`)),
          h("div", { class: "row-icons" }, r.revoked_at ? null : h("button", { class: "btn danger", type: "button", onClick: async () => {
            if (!(await confirmDialog({ title: t("apiRevoke"), message: t("apiRevokeConfirm"), yes: t("apiRevoke"), no: t("cancel") }))) return;
            try { await api(`/admin/tokens/${r.id}`, { method: "DELETE" }); load(); } catch (e) { toast(errorText(e)); }
          } }, t("apiRevoke"))))) : h("p", { class: "meta" }, t("apiNone"))),
      h("section", { class: "panel" }, h("h3", {}, t("apiNew")),
        h("form", { class: "acc-form", onSubmit: async (e) => {
          e.preventDefault();
          try { load(await api("/admin/tokens", { method: "POST", body: { name: name.value, scope: scope.value } })); }
          catch (err) { toast(err.body?.error === "too_many_tokens" ? t("apiTooMany") : errorText(err)); }
        } }, h("label", { class: "field" }, h("span", {}, t("apiName")), name), h("div", { class: "field" }, h("span", {}, t("apiScope")), scope), h("button", { class: "btn primary", type: "submit" }, t("apiCreate")))),
      h("section", { class: "panel" }, h("h3", {}, t("apiUsage")), h("p", { class: "meta" }, t("apiUsageHelp")),
        h("pre", { class: "code" }, `curl -H "Authorization: Bearer ams_..." ${base}/api/admin/overview`)));
  }
  load().catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

// Per-client branding: name, colour, logo, sender name and the texts of the sign-in screen.
function brandingPanel() {
  const b = state.brand;
  const text = (key, max = 80) => h("input", { value: b[key] ?? "", maxLength: max });
  const name = text("name"), sender = text("sender_name");
  const color = h("input", { type: "color", value: b.color, "aria-label": t("brandColor") });
  const country = h("select", {}, [["CA", t("countryCA")], ["US", t("countryUS")], ["FR", t("countryFR")], ["BE", t("countryBE")], ["CH", t("countryCH")], ["OTHER", t("countryOTHER")]].map(([v, l]) => h("option", { value: v, selected: (b.country ?? "CA") === v }, l)));
  const f = { title_fr: text("title_fr"), title_en: text("title_en"), intro_fr: text("intro_fr", 300), intro_en: text("intro_en", 300) };
  const logoBox = h("div", { class: "brand-logo" });
  const drawLogo = () => logoBox.replaceChildren(
    state.brand.logo ? h("img", { src: `/api/auth/logo?v=${state.brand.logo_v}`, alt: "", height: 56 }) : h("span", { class: "meta" }, "—"),
    h("label", { class: "btn" }, t("brandLogoUpload"), h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/svg+xml", hidden: true, onChange: async (e) => {
      const file = e.target.files[0]; if (!file) return;
      if (file.size > 300 * 1024) { toast(t("brandLogoTooBig")); return; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const data = btoa(bin);
      try { state.brand = { ...state.brand, ...(await api("/admin/branding/logo", { method: "PUT", body: { type: file.type, data } })) }; applyBrand(); drawLogo(); toast(t("saved")); } catch (err) { toast(errorText(err)); }
    } })),
    state.brand.logo ? h("button", { class: "btn", type: "button", onClick: async () => { state.brand = { ...state.brand, ...(await api("/admin/branding/logo", { method: "DELETE" })) }; applyBrand(); drawLogo(); } }, t("brandLogoRemove")) : null);
  drawLogo();
  const field = (label, ...inputs) => h("label", { class: "field" }, h("span", {}, label), ...inputs);
  return h("section", { class: "panel" }, h("h2", {}, t("adminBranding")),
    h("form", { class: "acc-form", onSubmit: async (e) => {
      e.preventDefault();
      try {
        state.brand = { ...state.brand, ...(await api("/admin/branding", { method: "PUT", body: { name: name.value, color: color.value, country: country.value, sender_name: sender.value, ...Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])) } })) };
        applyBrand(); state.posts = localizePosts(await api("/posts")); toast(t("saved"));
      } catch (err) { toast(errorText(err)); }
    } },
      field(t("brandName"), name), field(t("brandColor"), color), field(t("brandCountry"), country, h("span", { class: "meta" }, t("brandCountryHelp"))),
      h("div", { class: "field" }, h("span", {}, t("brandLogo")), logoBox, h("span", { class: "meta" }, t("brandLogoHelp"))),
      field(t("brandSender"), sender, h("span", { class: "meta" }, t("brandSenderHelp"))),
      h("h3", {}, t("brandLoginTexts")), h("p", { class: "meta" }, t("brandBlankDefault")),
      h("div", { class: "form-row r2" }, field(`${t("brandTitle")} (FR)`, f.title_fr), field(`${t("brandTitle")} (EN)`, f.title_en)),
      field(`${t("brandIntro")} (FR)`, f.intro_fr), field(`${t("brandIntro")} (EN)`, f.intro_en),
      h("button", { class: "btn primary", type: "submit" }, t("save"))));
}

// Platform owners: all clients, create a new one (with its first administrator, who is an employee of that client) and open any of them.
function clientsPanel() {
  const box = h("div", {});
  const current = () => state.me.client?.id;
  const switchTo = (id) => { try { id === state.me.me.home_client ? localStorage.removeItem("workClient") : localStorage.setItem("workClient", String(id)); } catch {} location.reload(); };
  const errMsg = (e) => ({ email_taken: t("errEmailTaken"), hostname_taken: t("errHostTaken"), invalid_hostname: t("errHostInvalid"), restaurant_name_taken: t("errRestaurantTaken"), invalid_email: t("invalidEmail") })[e.body?.error] ?? errorText(e);
  async function load() {
    const rows = await api("/clients");
    const name = h("input", { required: true, maxLength: 80 }), host = h("input", { maxLength: 200, placeholder: "horaires.exemple.com", autocapitalize: "off" });
    const first = h("input", { required: true, maxLength: 80 }), last = h("input", { maxLength: 80 }), email = h("input", { type: "email", required: true, maxLength: 200 }), rest = h("input", { maxLength: 80 });
    const field = (label, el, help) => h("label", { class: "field" }, h("span", {}, label), el, help ? h("span", { class: "meta" }, help) : null);
    box.replaceChildren(
      h("section", { class: "panel" }, h("h2", {}, t("adminClients")), h("p", { class: "meta" }, t("clientsHelp")),
        rows.map((r) => h("div", { class: `cov-row avail-row ${r.active ? "" : "inactive"}` },
          h("div", { class: "avail-text" },
            h("div", {}, h("b", {}, r.name), r.id === current() ? h("span", { class: "badge", style: "margin-left:.4rem" }, t("clientCurrent")) : null, r.active ? null : h("span", { class: "badge", style: "margin-left:.4rem" }, t("clientInactive"))),
            h("div", { class: "meta" }, `${r.employees} ${t("clientEmployees")} · ${r.restaurants} ${t("clientRestaurants")}${r.hostname ? ` · ${r.hostname}` : ""}`),
            h("div", { class: "meta" }, `${t("clientAdmins")} : ${r.admins.map((a) => `${a.name}${a.email ? ` (${a.email})` : ""}`).join(", ") || "—"}`)),
          h("div", { class: "row-icons" },
            r.active && r.id !== current() ? h("button", { class: "btn", type: "button", onClick: () => switchTo(r.id) }, t("clientOpen")) : null,
            r.id !== 1 ? h("button", { class: "btn", type: "button", onClick: async () => {
              if (r.active && !(await confirmDialog({ title: t("clientDisable"), message: t("clientDisableConfirm"), yes: t("clientDisable"), no: t("cancel") }))) return;
              try { await api(`/clients/${r.id}`, { method: "PUT", body: { active: !r.active } }); load(); } catch (e) { toast(errMsg(e)); }
            } }, r.active ? t("clientDisable") : t("clientEnable")) : null)))),
      h("section", { class: "panel" }, h("h2", {}, t("clientNew")),
        h("form", { class: "acc-form", onSubmit: async (e) => {
          e.preventDefault();
          try {
            await api("/clients", { method: "POST", body: { name: name.value, hostname: host.value, admin_first_name: first.value, admin_last_name: last.value, admin_email: email.value, restaurant_name: rest.value } });
            toast(t("clientCreated")); load();
          } catch (err) { toast(errMsg(err)); }
        } },
          field(t("clientName"), name), field(t("clientHostname"), host, t("clientHostnameHelp")),
          h("h3", {}, t("clientAdmin")),
          h("div", { class: "form-row r2" }, field(t("firstName"), first), field(t("lastName"), last)), field(t("email"), email),
          field(t("clientFirstRestaurant"), rest),
          h("button", { class: "btn primary", type: "submit" }, t("clientCreate")))));
  }
  load().catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

const ADMIN_SECTIONS_MARK = 0;
const ADMIN_SECTIONS = [["restaurants", "adminRestaurants"], ["staff", "adminStaff"], ["timeoff", "adminTimeOff"], ["payslips", "adminPayslips"], ["incidents", "adminIncidents"], ["communities", "adminCommunities"], ["targets", "adminTargets"], ["messaging", "adminMessaging"], ["branding", "adminBranding"], ["api", "adminApi"]];
state.adminSection = "restaurants";
// the old Webhooks tab now lives with the API access
const adminSectionOf = () => (state.adminSection === "webhooks" ? "api" : state.adminSection);

async function renderAdmin() {
  const ov = await api("/admin/overview");

  // Restaurant pills: small franchise logo + name (an owner can have restaurants of several franchises); click to edit the franchise.
  const logoSrc = restaurantLogo;
  const restaurantsPanel = h("section", { class: "panel" },
    h("div", { class: "resto-head" }, h("h2", {}, t("restaurants")), h("p", { class: "meta" }, t("addRestaurantInfo"))),
    h("div", { class: "resto-pills" }, ov.restaurants.map((r) => h("button", { class: "resto-pill", type: "button", title: t("franchiseEdit"), onClick: () => franchiseDialog(r, ov) },
      logoSrc(r) ? h("img", { src: logoSrc(r), alt: "", width: 28, height: 28 }) : h("span", { class: "resto-ico", "aria-hidden": "true" }, "🍽"),
      h("span", { class: "resto-names" }, h("b", {}, r.name), r.franchise?.name ? h("small", {}, r.franchise.name) : null)))));

  // One "+ Add" button; the new employee's name goes in a small dialog.
  const addStaff = h("button", { class: "btn primary", type: "button", onClick: () => {
    const dlg = document.getElementById("modal");
    const first = h("input", { required: true, maxLength: 80, autocomplete: "off" });
    const last = h("input", { maxLength: 80, autocomplete: "off" });
    const sexNew = radioGroup("sex-new", [["M", t("sexMale")], ["F", t("sexFemale")]], "");
    dlg.replaceChildren(h("form", { class: "modal-body", onSubmit: async (e) => {
      e.preventDefault();
      if (!sexNew.value) { toast(t("sexRequired")); return; }
      try { await api("/staff", { method: "POST", body: { first_name: first.value, last_name: last.value, sex: sexNew.value } }); dlg.close(); render(); } catch (err) { toast(errorText(err)); }
    } }, h("h2", {}, t("addStaff")),
      h("label", { class: "field" }, h("span", {}, t("firstName")), first), h("label", { class: "field" }, h("span", {}, t("lastName")), last),
      h("div", { class: "field" }, h("span", {}, t("sexLabel")), sexNew),
      h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: () => dlg.close() }, t("cancel")), h("button", { class: "btn primary", type: "submit" }, t("add")))));
    dlg.showModal(); first.focus();
  } }, `+ ${t("add")}`);
  const staffPanel = h("section", { class: "panel staff-head" }, h("h2", {}, t("staff")), addStaff);
  // Active employees first, then the inactive ones.
  const activeStaff = ov.staff.filter((x) => x.active !== false), inactiveStaff = ov.staff.filter((x) => x.active === false);
  const staffLists = ov.staff.length ? [
    h("h3", { class: "staff-group" }, `${t("activeEmployees")} (${activeStaff.length})`), ...activeStaff.map((x) => staffCard(x, ov)),
    inactiveStaff.length ? h("h3", { class: "staff-group inactive-group" }, `${t("inactiveEmployees")} (${inactiveStaff.length})`) : null,
    ...inactiveStaff.map((x) => staffCard(x, ov)),
  ] : [h("div", { class: "empty" }, t("noStaff"))];

  const sections = {
    restaurants: () => [restaurantsPanel, hoursPanel(ov), specialHoursPanel(ov), preOpenPanel(), defaultRatesPanel(ov)],
    targets: () => [weeklyTargetsPanel(ov), targetsPanel(ov)],
    staff: () => [staffPanel, ...staffLists],
    messaging: () => [messagingPanel(), settingsPanel(), messageLogPanel()],
    branding: () => [brandingPanel()],
    api: () => [apiPanel(), webhooksPanel()],
    clients: () => [clientsPanel()],
    payslips: () => [payslipsAdminPanel(ov)],
    incidents: () => [incidentsPanel(ov)],
    communities: () => [communitiesPanel(ov)],
    timeoff: () => { const box = h("div", {}, h("p", { class: "meta" }, t("loading"))); timeOffNodes("review").then((n) => box.replaceChildren(...n)).catch((e) => box.replaceChildren(h("p", { class: "meta" }, errorText(e)))); return [box]; },
  };
  const nav = h("nav", { class: "admin-nav", "aria-label": t("admin") }, [...ADMIN_SECTIONS, ...(state.me.me.is_super ? [["clients", "adminClients"]] : [])].map(([id, label]) =>
    h("button", { type: "button", "aria-current": adminSectionOf() === id ? "page" : false, onClick: () => { state.adminSection = id; render(); } }, mqDesktop.matches ? t(label) : t(`${label}Short`))));
  $app.replaceChildren(h("div", { class: "admin-layout" }, nav, h("div", { class: "admin-content" }, sections[adminSectionOf()]())));
}

// Franchise of a restaurant: name and logo.
function franchiseDialog(resto, ov) {
  let dlg = document.getElementById("franchise-modal");
  if (!dlg) { dlg = h("dialog", { id: "franchise-modal" }); document.body.append(dlg); }
  const name = h("input", { value: resto.franchise?.name ?? "", maxLength: 80, placeholder: t("franchiseName") });
  const reload = async () => { state.restaurants = await api("/restaurants"); ov.restaurants = await api("/restaurants"); render(); };
  const upload = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/svg+xml", hidden: true, onChange: async (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > 300 * 1024) { toast(t("brandLogoTooBig")); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    try { await api(`/restaurants/${resto.id}/franchise`, { method: "PUT", body: { type: file.type, data: btoa(bin) } }); dlg.close(); await reload(); toast(t("saved")); } catch (err) { toast(errorText(err)); }
  } });
  dlg.replaceChildren(h("form", { class: "modal-body", onSubmit: async (e) => {
    e.preventDefault();
    try { await api(`/restaurants/${resto.id}/franchise`, { method: "PUT", body: { name: name.value } }); dlg.close(); await reload(); toast(t("saved")); } catch (err) { toast(errorText(err)); }
  } }, h("h2", {}, resto.name),
    h("label", { class: "field" }, h("span", {}, t("franchiseName")), name),
    h("div", { class: "field" }, h("span", {}, t("brandLogo")), h("div", { class: "brand-logo" },
      resto.franchise?.logo ? h("img", { src: `/api/restaurants/${resto.id}/logo?v=${resto.franchise.logo_v}`, alt: "", height: 48 }) : h("span", { class: "meta" }, t("franchiseLogoDefault")),
      h("label", { class: "btn" }, t("brandLogoUpload"), upload),
      resto.franchise?.logo ? h("button", { class: "btn", type: "button", onClick: async () => { try { await api(`/restaurants/${resto.id}/franchise`, { method: "PUT", body: { remove_logo: true } }); dlg.close(); await reload(); } catch (err) { toast(errorText(err)); } } }, t("brandLogoRemove")) : null)),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: () => dlg.close() }, t("cancel")), h("button", { class: "btn primary", type: "submit" }, t("save")))));
  dlg.showModal();
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
  const st = { restaurant: ov.restaurants[0]?.id, department: "kitchen", week: mondayOf(new Date()), scope: "always" };
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

    const SLOTS = hoursSlots(st.restaurant, ov.restaurants), slotLabel = (k) => periodLabel(null, k);
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
        // Changes "for every week" reach all future weeks: ask first.
        const anyChange = SLOTS.some((slot) => inputs.some((col) => col[slot] && col[slot].value !== col[slot].dataset.orig && col[slot].value !== ""));
        if (st.scope === "always" && anyChange && !(await confirmDialog({ title: t("confirmFutureTitle"), message: t("confirmFutureTargets"), yes: t("yesApply"), no: t("cancel") }))) return;
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
        h("div", { class: "field" }, h("span", {}, t("restaurant")), restaurantSelect({ list: ov.restaurants, value: st.restaurant, onChange: (id) => { st.restaurant = id; load(); } })),
        h("label", { class: "field" }, h("span", {}, t("department")), sel(DEPTS.map((d) => [d, t(`dept.${d}`)]), st.department, (e) => { st.department = e.target.value; load(); }))),
      h("div", { class: "weeknav", style: "margin:8px 0" },
        h("button", { class: "icon-btn", type: "button", "aria-label": t("prev"), onClick: () => { st.week = addDays(st.week, -7); load(); } }, "‹"),
        h("div", { class: "label" }, weekLabel(st.week)),
        h("button", { class: "icon-btn", type: "button", "aria-label": t("next"), onClick: () => { st.week = addDays(st.week, 7); load(); } }, "›"),
        h("button", { class: "btn", type: "button", onClick: () => { st.week = mondayOf(new Date()); load(); } }, t("today"))),
      h("div", { class: "field" }, h("span", {}, t("applyChangesTo")),
        h("div", { class: "seg" },
          [["always", t("scopeAlways")], ["week", t("scopeWeek")]].map(([v, l]) => h("button", { type: "button", "aria-pressed": String(st.scope === v), onClick: () => { st.scope = v; load(); } }, l))),
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

    const SLOTS2 = hoursSlots(st.restaurant, ov.restaurants), slotLabel2 = (k) => periodLabel(null, k);
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
        h("div", { class: "field" }, h("span", {}, t("restaurant")), restaurantSelect({ list: ov.restaurants, value: st.restaurant, onChange: (id) => { st.restaurant = id; st.setId = 0; reload(); } })),
        h("label", { class: "field" }, h("span", {}, t("department")), sel(DEPTS.map((d) => [d, t(`dept.${d}`)]), st.department, (e) => { st.department = e.target.value; reload(); })),
        h("label", { class: "field" }, h("span", {}, t("period")), sel(periodOpts, st.setId, (e) => { st.setId = Number(e.target.value); reload(); }))),
      h("div", { class: "period-bar" },
        h("button", { class: "btn", type: "button", onClick: () => periodDialog({ restaurantId: st.restaurant, kind: "season", onSaved: reload }) }, t("addSeason")),
        h("button", { class: "btn", type: "button", onClick: () => periodDialog({ restaurantId: st.restaurant, kind: "special", onSaved: reload }) }, t("addSpecial"))),
      set ? h("div", { class: "period-note" }, h("strong", {}, set.name), ` — ${describeRule(set.rule)}`,
        h("div", { class: "period-bar" },
          h("button", { class: "btn", type: "button", onClick: () => periodDialog({ restaurantId: st.restaurant, kind: set.kind, set, onSaved: reload }) }, t("editPeriod")),
          h("button", { class: "btn danger", type: "button", onClick: async () => {
            if (!(await ask(t("confirmDeletePeriod")))) return;
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
          for (const r of own) if (!SLOTS2.includes(r.slot)) slots[r.slot] = r.count; // outside the opening hours: left as it is
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

// Closed days (Christmas…) and special opening hours (Christmas Eve until 17:00, New Year's Day from 10:00).
function specialHoursPanel(ov) {
  const st = { restaurant: ov.restaurants[0]?.id, editing: null };
  const box = h("section", { class: "panel" });
  const reload = async () => { state.restaurants = await api("/restaurants"); ov.restaurants = await api("/restaurants"); draw(); };
  function draw() {
    const resto = ov.restaurants.find((r) => r.id === st.restaurant);
    if (!resto) { box.replaceChildren(); return; }
    const date = h("input", { type: "date", class: "sh-date", required: true, "aria-label": t("date") });
    const endDate = h("input", { type: "date", class: "sh-date", "aria-label": t("toDate") });
    date.addEventListener("change", () => { endDate.min = date.value; if (endDate.value && endDate.value < date.value) endDate.value = date.value; });
    // a whole week (construction, big clean-up): Monday to Sunday of the chosen date
    const wholeWeek = h("button", { class: "btn sh-half", type: "button", onClick: () => { if (!date.value) { date.focus(); return; } const mon = mondayOf(parseYmd(date.value)); date.value = mon; endDate.value = addDays(mon, 6); yearly.checked = false; } }, t("wholeWeek"));
    const yearly = h("input", { type: "checkbox" });
    const closed = h("input", { type: "checkbox", checked: true });
    const open = timeField("10:00"), close = timeField("17:00");
    const hoursRow = h("div", { class: "sh-inline" }, h("label", { class: "field" }, h("span", {}, t("openTime")), open), h("label", { class: "field" }, h("span", {}, t("closeTime")), close));
    const note = h("input", { maxLength: 80, placeholder: t("specialNote"), "aria-label": t("specialNote") });
    const all = h("input", { type: "checkbox" });
    // editing an entry: the form is filled with it, saving replaces it (a changed date removes the old one)
    const cur = st.editing ? (resto.special_hours ?? []).find((x) => x.id === st.editing) ?? null : null;
    if (cur) { date.value = cur.date; yearly.checked = !!cur.yearly; closed.checked = !!cur.closed; note.value = cur.note ?? ""; if (cur.open_time) open.value = cur.open_time; if (cur.close_time) close.value = cur.close_time; }
    const btnClosed = h("button", { type: "button", onClick: () => setMode(true) }, t("closedDay")), btnSpecial = h("button", { type: "button", onClick: () => setMode(false) }, t("specialHoursOption"));
    const sync = () => { hoursRow.hidden = closed.checked; btnClosed.setAttribute("aria-pressed", String(closed.checked)); btnSpecial.setAttribute("aria-pressed", String(!closed.checked)); };
    const setMode = (isClosed) => { closed.checked = isClosed; sync(); };
    sync();
    const add = async (e) => {
      e.preventDefault();
      try {
        if (cur && cur.date !== date.value) await api(`/restaurants/${resto.id}/special-hours/${cur.id}`, { method: "DELETE" });
        st.editing = null;
        for (const r of all.checked ? ov.restaurants : [resto])
          await api(`/restaurants/${r.id}/special-hours`, { method: "POST", body: { date: date.value, end_date: endDate.value || undefined, yearly: yearly.checked && !endDate.value, closed: closed.checked, open_time: open.value, close_time: close.value, note: note.value } });
        toast(t("saved")); await reload();
      } catch (err) { toast(err.body?.error === "invalid_times" ? t("opensBeforeCloses") : errorText(err)); }
    };
    const list = resto.special_hours ?? [];
    box.replaceChildren(h("h2", {}, t("specialHoursTitle")), h("p", { class: "meta" }, t("specialHoursHelp")),
      h("div", { class: "field" }, h("span", {}, t("restaurant")), restaurantSelect({ list: ov.restaurants, value: st.restaurant, onChange: (id) => { st.restaurant = id; st.editing = null; draw(); } })),
      list.length ? h("ul", { class: "sh-list" }, list.map((x) => h("li", {},
        h("span", {}, h("b", {}, fmt(x.date, { weekday: "short", day: "numeric", month: "long", ...(x.yearly ? {} : { year: "numeric" }) })), x.yearly ? ` · ${t("everyYear")}` : "", " — ", x.closed ? `⛔ ${t("closedDay")}` : `🕒 ${hm(x.open_time)}–${hm(x.close_time)}`, x.note ? ` · ${x.note}` : ""),
        h("span", { class: "sh-btns" }, h("button", { class: "btn sm", type: "button", onClick: () => { st.editing = x.id; draw(); box.scrollIntoView({ block: "nearest" }); } }, t("editWord")), h("button", { class: "btn sm danger", type: "button", onClick: async () => { if (!(await ask(t("confirmDeleteSpecial")))) return; try { await api(`/restaurants/${resto.id}/special-hours/${x.id}`, { method: "DELETE" }); if (st.editing === x.id) st.editing = null; await reload(); } catch (err) { toast(errorText(err)); } } }, t("delete")))))) : h("p", { class: "meta" }, t("noSpecialHours")),
      h("form", { class: "td-body sh-form", onSubmit: add },
        // line 1: the dates and Closed
        h("div", { class: "sh-line sh-line1" }, h("label", { class: "field sh-d" }, h("span", {}, t("fromDate")), date), h("label", { class: "field sh-d" }, h("span", {}, `${t("toDate")} (${t("optional").toLowerCase()})`), endDate),
          h("label", { class: "check sh-half" }, yearly, h("span", {}, t("everyYear"))), wholeWeek, h("div", { class: "seg sh-seg" }, btnClosed, btnSpecial)),
        // line 2: special hours, description, all restaurants, Add
        h("div", { class: "sh-line" }, hoursRow, h("label", { class: "field sh-note" }, h("span", {}, t("descriptionWord")), note),
          h("div", { class: "sh-end" }, ov.restaurants.length > 1 ? h("label", { class: "check" }, all, h("span", {}, t("allRestaurants"))) : null,
            cur ? h("button", { class: "btn icon-mobile", type: "button", "aria-label": t("cancel"), title: t("cancel"), onClick: () => { st.editing = null; draw(); } }, h("span", { class: "ic", "aria-hidden": "true" }, "✕"), h("span", { class: "tx" }, t("cancel"))) : null,
            cur ? h("button", { class: "btn primary icon-mobile", type: "submit", "aria-label": t("save"), title: t("save") }, h("span", { class: "ic", "aria-hidden": "true" }, "✓"), h("span", { class: "tx" }, t("save")))
              : h("button", { class: "btn primary", type: "submit" }, t("add"))))));
  }
  draw();
  return box;
}

// Administration: communities of each restaurant and the departments they gather.
function communitiesPanel(ov) {
  const box = h("section", { class: "panel" });
  async function load() {
    const rows = await api("/admin/communities");
    const depBoxes = (selected) => COMM_DEPTS.map((d) => { const input = h("input", { type: "checkbox", checked: selected.includes(d) }); return { d, input, node: h("label", { class: "check" }, input, h("span", {}, t(`dept.${d}`))) }; });
    const rowFor = (c) => {
      const name = h("input", { value: c.name, maxLength: 60, "aria-label": t("communityName") }), deps = depBoxes(c.departments);
      return h("div", { class: "comm-admin-row" }, name, h("div", { class: "comm-deps" }, deps.map((x) => x.node)),
        h("div", { class: "actions" },
          h("button", { class: "btn danger sm", type: "button", onClick: async () => { if (await ask(t("confirmDeleteCommunity"))) { try { await api(`/admin/communities/${c.id}`, { method: "DELETE" }); load(); } catch (e) { toast(errorText(e)); } } } }, t("delete")),
          h("button", { class: "btn primary sm", type: "button", onClick: async () => {
            try { await api(`/admin/communities/${c.id}`, { method: "PUT", body: { name: name.value, departments: deps.filter((x) => x.input.checked).map((x) => x.d) } }); toast(t("saved")); } catch (e) { toast(e.body?.error === "invalid_community" ? t("communityInvalid") : errorText(e)); }
          } }, t("save"))));
    };
    const addFor = (r) => {
      const name = h("input", { maxLength: 60, placeholder: t("communityName"), "aria-label": t("communityName") }), deps = depBoxes([]);
      return h("div", { class: "comm-admin-row add" }, name, h("div", { class: "comm-deps" }, deps.map((x) => x.node)),
        h("div", { class: "actions" }, h("button", { class: "btn sm", type: "button", onClick: async () => {
          try { await api("/admin/communities", { method: "POST", body: { restaurant_id: r.id, name: name.value, departments: deps.filter((x) => x.input.checked).map((x) => x.d) } }); load(); } catch (e) { toast(e.body?.error === "invalid_community" ? t("communityInvalid") : errorText(e)); }
        } }, `+ ${t("add")}`)));
    };
    box.replaceChildren(h("h2", {}, t("adminCommunities")), h("p", { class: "meta" }, t("communitiesHelp")),
      ...ov.restaurants.map((r) => h("div", { class: "comm-resto" }, h("h3", {}, r.name), ...rows.filter((c) => c.restaurant_id === r.id).map(rowFor), addFor(r))));
  }
  load().catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}
const COMM_DEPTS = ["floor", "kitchen", "prep", "delivery", "admin"];

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
      h("div", { class: "pair-grid" }, rows.map(({ r, input }) => h("label", { class: "pair-item" }, h("strong", {}, `${roleIcon(r)} ${roleName(r)}`), input))),
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onClick: async () => {
        try {
          const saved = await api("/admin/default-rates", { method: "PUT", body: { general: general.value, roles: Object.fromEntries(rows.map(({ r, input }) => [r.id, input.value])) } });
          ov.default_rates = saved; toast(t("saved"));
        } catch (e) { toast(e.body?.error === "invalid_rate" ? t("genericError") : errorText(e)); }
      } }, t("save"))));
  }).catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

// Minutes before opening that each role should arrive (default start of new shifts). Waiter and cook first, the other roles on demand.
function preOpenPanel() {
  const box = h("section", { class: "panel" });
  let more = false;
  api("/roles").then((roles) => {
    const inputs = roles.map((r) => ({ r, input: h("input", { type: "number", min: 0, max: 180, step: 5, inputMode: "numeric", value: r.pre_open_minutes ?? 0, "aria-label": `${roleName(r)} — ${t("minutes")}` }) }));
    const main = (x) => /^(Waiter|Cook)\b/.test(x.r.name_en);
    const item = ({ r, input }) => h("label", { class: "pair-item" }, h("strong", {}, `${roleIcon(r)} ${roleName(r)}`), input);
    const draw = () => box.replaceChildren(h("h2", {}, t("preOpenTitle")), h("p", { class: "meta" }, t("preOpenHelp")),
      h("div", { class: "pair-grid" }, inputs.filter(main).map(item)),
      h("button", { class: "btn sm", type: "button", "aria-expanded": String(more), onClick: () => { more = !more; draw(); } }, more ? `− ${t("fewerRoles")}` : `+ ${t("moreRoles")}`),
      more ? h("div", { class: "pair-grid", style: "margin-top:.6rem" }, inputs.filter((x) => !main(x)).map(item)) : null,
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onClick: async () => {
        try {
          for (const { r, input } of inputs) { const m = Number(input.value) || 0; if (m !== (r.pre_open_minutes ?? 0)) { await api(`/roles/${r.id}/pre-open`, { method: "PUT", body: { minutes: m } }); r.pre_open_minutes = m; } }
          state.roles = await api("/roles"); toast(t("saved"));
        } catch (e) { toast(errorText(e)); }
      } }, t("save"))));
    draw();
  }).catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

// Opening hours, breakfast and dinner start for every weekday of one restaurant (one line per day on desktop).
function hoursPanel(ov) {
  const st = { restaurant: ov.restaurants[0]?.id };
  const box = h("section", { class: "panel" });
  function draw() {
    const resto = ov.restaurants.find((r) => r.id === st.restaurant);
    if (!resto) { box.replaceChildren(h("h2", {}, t("hoursTitle")), h("div", { class: "empty" }, t("noSchedules"))); return; }
    const rows = Array.from({ length: 7 }, (_, i) => {
      const bf = resto.breakfast_by_dow?.[i], dn = resto.dinner_by_dow?.[i];
      const open = timeField(resto.open_by_dow?.[i] ?? resto.open_time), close = timeField(resto.close_by_dow?.[i] ?? resto.close_time);
      const bfOn = h("input", { type: "checkbox", checked: !!bf, "aria-label": `${mealWord()} — ${weekdayName(i)}` }), bfEnd = timeField(bf?.end ?? "11:00");
      const dnOn = h("input", { type: "checkbox", checked: !!dn, "aria-label": `${t("dinnerStarts")} — ${weekdayName(i)}` }), dnAt = timeField(dn ?? "17:00");
      const sync = () => { bfEnd.hidden = !bfOn.checked; dnAt.hidden = !dnOn.checked; for (const [el, on] of [[bfEnd, bfOn.checked], [dnAt, dnOn.checked]]) if (el.parentElement) el.parentElement.style.visibility = on ? "" : "hidden"; };
      bfOn.addEventListener("change", sync); dnOn.addEventListener("change", sync); sync();
      return { open, close, bfOn, bfEnd, dnOn, dnAt };
    });
    const copyMonday = () => rows.slice(1).forEach((r) => {
      const m = rows[0]; r.open.value = m.open.value; r.close.value = m.close.value; r.bfOn.checked = m.bfOn.checked; r.bfEnd.value = m.bfEnd.value; r.dnOn.checked = m.dnOn.checked; r.dnAt.value = m.dnAt.value;
      r.bfOn.dispatchEvent(new Event("change")); r.dnOn.dispatchEvent(new Event("change"));
    });
    box.replaceChildren(
      h("h2", {}, t("hoursTitle")),
      h("p", { class: "meta" }, `${t("hoursHelp")} ${mealText(t("breakfastHelpShort"))}`),
      h("div", { class: "field" }, h("span", {}, t("restaurant")), restaurantSelect({ list: ov.restaurants, value: st.restaurant, onChange: (id) => { st.restaurant = id; draw(); } })),
      h("div", { class: "hrs-table" },
        h("div", { class: "hrs-head" }, h("span"), h("span", {}, t("openTime")), h("span", {}, t("closeTime")), h("span", {}, mealWord()), h("span", {}, t("breakfastUntil")), h("span", {}, t("dinnerWord")), h("span", {}, t("startsAt"))),
        rows.map((r, i) => h("div", { class: "hrs-row" }, h("strong", {}, weekdayName(i)),
          h("label", { class: "mini" }, h("span", {}, t("openTime")), r.open),
          h("label", { class: "mini" }, h("span", {}, t("closeTime")), r.close),
          h("label", { class: "check hrs-bf" }, r.bfOn, h("span", { class: "hrs-until" }, mealWord())),
          h("div", { class: "mini" }, h("span", {}, t("breakfastUntil")), r.bfEnd),
          h("label", { class: "check hrs-bf" }, r.dnOn, h("span", { class: "hrs-until" }, t("dinnerWord"))),
          h("div", { class: "mini" }, h("span", {}, t("startsAt")), r.dnAt)))),
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "button", onClick: copyMonday }, t("copyMonday")),
        h("button", { class: "btn primary", type: "button", onClick: async () => {
          try {
            await api(`/restaurants/${st.restaurant}/hours`, { method: "PUT", body: { open_times: rows.map((r) => r.open.value), close_times: rows.map((r) => r.close.value), dinner_times: rows.map((r) => (r.dnOn.checked ? r.dnAt.value : null)) } });
            // breakfast runs from opening time until the chosen time
            await api(`/restaurants/${st.restaurant}/breakfast`, { method: "PUT", body: { days: rows.map((r) => (r.bfOn.checked ? { start: r.open.value, end: r.bfEnd.value } : null)) } });
            state.restaurants = await api("/restaurants"); ov.restaurants = await api("/restaurants"); toast(t("saved")); draw();
          } catch (e) { toast(e.body?.error === "invalid_times" ? t("opensBeforeCloses") : errorText(e)); }
        } }, t("save"))));
    rows.forEach((r) => { r.bfOn.dispatchEvent(new Event("change")); }); // sets the visibility of the "until" cells now they are attached
  }
  draw();
  return box;
}

// Untick a role: if shifts still use it, ask whether to move them to another role or delete them.
async function removeRole(body, role, input, onRemoved, sex) {
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
            `${t("moveShiftsTo")} ${roleName(a, sex)} (${t(`dept.${a.department_id}`)})`))
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
    h("h2", {}, `${roleName(ro, s.sex)} — ${r.name}`),
    h("p", {}, t("roleChoiceBody")),
    date.node,
    others.map((old) => h("button", { class: "btn primary", type: "button", onClick: () => replace(old) },
      `${t("replace")} ${roleName(oldRole(old), s.sex)} → ${roleName(ro, s.sex)}`)),
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
  const phone = h("input", { type: "tel", value: formatPhone(s.phone), autocomplete: "off", placeholder: "+1 (819) 555-1234" });
  phone.addEventListener("blur", () => { phone.value = formatPhone(phone.value); });
  const sex = radioGroup(`sex-${s.id}`, [["M", t("sexMale")], ["F", t("sexFemale")]], s.sex ?? "");
  const lang = radioGroup(`lang-${s.id}`, [["fr", "Français"], ["en", "English"]], s.lang);
  const channel = radioGroup(`chan-${s.id}`, [["sms", t("sms")], ["email", t("emailCh")]], s.notify_channel);
  const rate = h("input", { type: "number", min: 0, max: 1000, step: "0.05", inputMode: "decimal", placeholder: ov.default_rates?.general_cents != null ? `${t("defaultWord")} ${(ov.default_rates.general_cents / 100).toFixed(2)}` : t("noRate"), value: s.hourly_cents != null ? (s.hourly_cents / 100).toFixed(2) : "" });
  // Optional hourly rate per role held (e.g. delivery driver vs cook); blank = use the general rate.
  const heldRoleIds = [...new Set(s.roles.map((r) => r.role_id))];
  const roleRateInputs = heldRoleIds.map((rid) => {
    const ro = state.roles.find((x) => x.id === rid);
    const cents = s.role_rates?.[rid];
    return { rid, ro, input: h("input", { type: "number", min: 0, max: 1000, step: "0.05", inputMode: "decimal", placeholder: (() => { const dr = ov.default_rates?.roles?.[rid] ?? ov.default_rates?.general_cents; return dr != null ? `${t("defaultWord")} ${(dr / 100).toFixed(2)}` : t("sameAsGeneral"); })(), value: cents != null ? (cents / 100).toFixed(2) : "" }) };
  }).filter((x) => x.ro);
  const adminMsg = h("div", { class: "alert", role: "alert" });
  const printOrder = h("input", { type: "number", min: 1, max: 999, inputMode: "numeric", placeholder: t("noPrintOrder"), value: s.print_order ?? "" });
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
      if (!sex.value) { toast(t("sexRequired")); return; }
      await api(`/staff/${s.id}`, { method: "PUT", body: { first_name: first.value, last_name: last.value, sex: sex.value || undefined, print_order: printOrder.value || null, email: email.value, phone: phone.value, lang: lang.value, notify_channel: channel.value, color: chosen } });
      const w = await api(`/staff/${s.id}/wage`, { method: "PUT", body: { hourly_rate: rate.value, role_rates: Object.fromEntries(roleRateInputs.map((x) => [x.rid, x.input.value])) } });
      s.hourly_cents = w.hourly_cents; s.role_rates = w.role_rates;
      if (sinInput.value.trim()) { const r = await api(`/staff/${s.id}/sin`, { method: "PUT", body: { sin: sinInput.value } }); s.sin_last3 = r.sin_last3; sinInput.value = ""; sinInput.placeholder = `••• ••• ${r.sin_last3}`; }
      toast(t("saved"));
    } catch (err) { toast(err.body?.error === "invalid_sin" ? t("invalidSin") : err.body?.error === "sin_already_used" ? t("sinUsed") : err.body?.error === "invalid_rate" ? t("genericError") : errorText(err)); }
  } },
    h("div", { class: "form-row r3" },
      h("label", { class: "field" }, h("span", {}, t("firstName")), first), h("label", { class: "field" }, h("span", {}, t("lastName")), last),
      h("div", { class: "field" }, h("span", {}, t("sexLabel")), sex)),
    h("div", { class: "form-row r2" }, h("label", { class: "field" }, h("span", {}, t("email")), email), h("label", { class: "field" }, h("span", {}, t("phone")), phone)),
    h("div", { class: "form-row r2" }, h("div", { class: "field" }, h("span", {}, t("language")), lang), h("div", { class: "field" }, h("span", {}, t("notifyBy")), channel)),
    h("div", { class: "form-row r2" },
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: s.active !== false, onChange: async (e) => {
      const want = e.target.checked;
      adminMsg.textContent = "";
      try {
        const r = await api(`/staff/${s.id}/active`, { method: "PUT", body: { active: want } });
        s.active = want; rowEl.classList.toggle("inactive", !want); render(); // the list behind the dialog moves the employee to the other group right away
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
    } }), h("span", {}, t("isAdminLabel")))),
    adminMsg,
    h("div", { class: "field" }, h("span", {}, `${t("hourlyRate")} · ${t("adminOnlyField")}`),
      h("div", { class: "rate-line" },
        h("label", { class: "rate-item" }, h("small", {}, roleRateInputs.length > 1 ? t("generalRateShort") : t("hourlyRateShort")), rate),
        roleRateInputs.length > 1 ? roleRateInputs.map((x) => h("label", { class: "rate-item" }, h("small", {}, `${roleIcon(x.ro)} ${roleName(x.ro, s.sex)}`), x.input)) : null)),
    h("div", { class: "form-row r2" },
      h("label", { class: "field" }, h("span", {}, t("printOrderLabel")), printOrder, h("span", { class: "meta" }, t("printOrderHelp"))),
      h("label", { class: "field" }, h("span", {}, t("sinLabel")), sinInput, h("span", { class: "meta" }, t("sinHelp")))),
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
                removeRole(body, ro, input, () => { s.roles = s.roles.filter((x) => !(x.restaurant_id === r.id && x.role_id === ro.id)); }, s.sex);
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
  const iconBlock = h("span", { class: "staff-icons" });
  // redrawn whenever roles or managed departments change, so the list is up to date right away
  const drawIcons = () => {
    const byResto = ov.restaurants.map((r) => {
      const roleIcons = [...new Set(s.roles.filter((x) => x.restaurant_id === r.id).map((x) => roleIcon(state.roles.find((y) => y.id === x.role_id))))];
      const mgr = s.managers.filter((m) => m.restaurant_id === r.id).map((m) => deptIcon(m.department_id));
      return { r, roleIcons, mgr };
    }).filter((x) => x.roleIcons.length || x.mgr.length);
    iconBlock.replaceChildren(...byResto.map(({ r, roleIcons, mgr }) =>
      h("span", { class: "resto-icons", title: r.name }, h("small", {}, shortName(r.name)), ` ${roleIcons.join(" ")}`,
        mgr.length ? h("span", { class: "mgr-icons", title: t("managerOf") }, mgr.map((i) => h("span", {}, `⭐${i}`))) : null)));
  };
  drawIcons();
  const nameEl = h("span", {}, s.name);
  const open = () => {
    let dlg = document.getElementById("staff-modal");
    if (!dlg) { dlg = h("dialog", { id: "staff-modal", class: "wide" }); document.body.append(dlg); }
    // Four tabs: details (the form), roles, availability and requested time off. Save only applies to the details tab.
    // the kitchen tab only exists for Chef, Cook and Assistant cook
    const tabList = () => [["details", t("details")], ["roles", t("rolesTab")], ...(hasKitchenRole(s) ? [["kitchen", t("kitchenTab")]] : []), ["daysoff", mqDesktop.matches ? t("tabDaysOff") : t("fixedDaysOff")], ["availability", mqDesktop.matches ? t("tabAvailability") : t("availability")], ["timeoff", mqDesktop.matches ? t("tabTimeOff") : t("requestedTimeOff")], ["planning", t("planningTab")], ["attendance", t("attendanceTab")], ["scheduleaccess", mqDesktop.matches ? t("tabSchedules") : t("scheduleAccessTab")]];
    let tab = "details";
    const saveBtn = h("button", { class: "btn primary icon-mobile", type: "submit", form: `staff-form-${s.id}`, "aria-label": t("save"), title: t("save") }, h("span", { class: "ic", "aria-hidden": "true" }, "✓"), h("span", { class: "tx" }, t("save")));
    const saveTarget = () => { saveBtn.setAttribute("form", tab === "planning" ? `planning-form-${s.id}` : `staff-form-${s.id}`); saveBtn.hidden = tab !== "details" && tab !== "planning"; };
    const tabBar = h("div", { class: "dlg-tabs", role: "tablist" });
    const content = h("div", { class: "dlg-content" });
    const panes = {
      details: () => [details],
      roles: () => {
        const sideBySide = h("div", { class: "resto-cols" }, blocks);
        return [h("div", { class: "roles-tab" }, sideBySide)];
      },
      kitchen: () => [skillsBox(s)],
      daysoff: () => [availabilityEditor(s.id, "daysoff")],
      availability: () => [availabilityEditor(s.id, "times")],
      timeoff: () => [staffTimeOff(s)],
      planning: () => [planningForm(s)],
      attendance: () => [attendancePane(s, ov)],
      scheduleaccess: () => [scheduleAccessPane(s, ov)],
    };
    const drawTabs = () => {
      if (!tabList().some(([id]) => id === tab)) tab = "roles";
      tabBar.replaceChildren(...tabList().map(([id, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(tab === id), onClick: () => { tab = id; draw(); } }, label)));
    };
    const draw = () => {
      saveTarget();
      drawTabs();
      content.replaceChildren(...panes[tab]());
    };
    // roles are saved as they change: show or hide the kitchen tab
    content.addEventListener("change", () => { if (tab === "roles") setTimeout(drawTabs, 400); });
    content.addEventListener("change", () => setTimeout(drawIcons, 600));
    content.addEventListener("change", () => { if (tab === "roles") setTimeout(() => { if (hasKitchenRole(s) !== tabList().some(([id]) => id === "kitchen")) { const keep = content.firstChild; tabBar.replaceChildren(...tabList().map(([id, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(tab === id), onClick: () => { tab = id; draw(); } }, label))); void keep; } }, 700); });
    dlg.replaceChildren(h("div", { class: "modal-body staff-dialog" },
      // Sticky header: Save submits the details form (form= attribute), Close just closes.
      h("div", { class: "dlg-top" },
        h("div", { class: "dlg-head" }, h("h2", {}, s.name), h("div", { class: "dlg-actions" }, saveBtn, h("button", { class: "btn icon-mobile", type: "button", "aria-label": t("close"), title: t("close"), onClick: () => dlg.close() }, h("span", { class: "ic", "aria-hidden": "true" }, "✕"), h("span", { class: "tx" }, t("close"))))),
        tabBar),
      content));
    draw();
    dlg.addEventListener("close", () => { drawIcons(); s.first_name = first.value.trim() || s.first_name; s.last_name = last.value.trim(); nameEl.textContent = fullName() || s.name; s.name = nameEl.textContent; }, { once: true });
    dlg.showModal();
  };
  const rowEl = h("button", { class: `staff-row ${s.active === false ? "inactive" : ""}`, type: "button", onClick: open },
    h("span", { class: "who-row" }, summaryAvatar, nameEl), iconBlock,
    h("span", { class: "inactive-badge badge" }, t("inactive")),
    s.is_admin ? h("span", { class: "badge" }, t("admin_flag")) : null);
  return rowEl;
}

// ---------- boot ----------
// ---------- Per-client branding (name, colour, logo, texts), set in Administration ----------
const DEFAULT_BRAND = { name: "Mikes", color: "#da291c", sender_name: "", country: "CA", title_fr: "", title_en: "", intro_fr: "", intro_en: "", footer_fr: "", footer_en: "", logo: false, logo_v: 0 };
state.brand = { ...DEFAULT_BRAND };
const darkenHex = (hex, f = 0.78) => { const n = parseInt(hex.slice(1), 16); const c = (sh) => Math.round(((n >> sh) & 255) * f).toString(16).padStart(2, "0"); return `#${c(16)}${c(8)}${c(0)}`; };
const brandText = (key) => state.brand[`${key}_${getLang()}`] || "";
// French word for the first meal: "déjeuner" in Canada and the United States, "petit-déjeuner" in France, Belgium, Switzerland and elsewhere.
const mealWord = () => (getLang() === "en" ? "Breakfast" : ["CA", "US"].includes(state.brand.country) ? "Déjeuner" : "Petit-déjeuner");
const mealText = (str) => str.replaceAll("{meal}", mealWord().toLowerCase()).replaceAll("{Meal}", mealWord());
// the kitchen posts "Déjeuner (œufs)" / "Déjeuner (poste arrière)" follow the same wording
const localizePosts = (posts) => posts.map((p) => (["CA", "US"].includes(state.brand.country) ? p : { ...p, name_fr: p.name_fr.replace(/^Déjeuner/, "Petit-déjeuner") }));
function applyBrand() {
  const b = state.brand, root = document.documentElement.style;
  root.setProperty("--brand", b.color); root.setProperty("--brand-dark", darkenHex(b.color));
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", b.color);
  const logo = document.getElementById("logo"), word = document.getElementById("wordmark");
  const custom = b.logo, isDefault = b.name === DEFAULT_BRAND.name;
  if (custom) { logo.hidden = false; word.hidden = true; logo.onerror = () => { logo.hidden = true; word.hidden = false; }; logo.src = `/api/auth/logo?v=${b.logo_v}`; }
  else if (isDefault) { logo.hidden = false; word.hidden = true; if (!logo.src.endsWith("logo.png")) logo.src = "logo.png"; }
  else { logo.hidden = true; word.hidden = false; }
  logo.alt = b.name; word.textContent = b.name;
  if (state.me || state.brandLoaded) renderChrome();
}
async function loadBrand() {
  try { state.brand = { ...DEFAULT_BRAND, ...(await (await fetch("/api/auth/branding", { headers: clientHeader() })).json()) }; } catch {}
  state.brandLoaded = true;
  applyBrand();
}

// Sign-in screen: email -> 6-digit code sent by email -> session cookie.
function renderLogin(prefill = "") {
  renderChrome();
  document.getElementById("main-tabs").replaceChildren(); // nothing to navigate to before signing in
  const email = h("input", { type: "email", required: true, autocomplete: "email", inputMode: "email", value: prefill, placeholder: "prenom@exemple.com", maxLength: 200 });
  const code = h("input", { required: true, autocomplete: "one-time-code", inputMode: "numeric", pattern: "[0-9]{6}", maxLength: 6, class: "login-code", "aria-label": t("loginCode") });
  const msg = h("div", { class: "alert", role: "alert" });
  const fail = (e, fallback) => { msg.textContent = e?.body?.error === "too_many_requests" ? t("loginTooMany") : e?.body?.error === "email_not_configured" ? t("loginEmailOff") : fallback; };
  const stepEmail = () => {
    msg.textContent = "";
    $app.replaceChildren(h("div", { class: "login-card" }, h("h2", {}, brandText("title") || t("loginTitle")), h("p", { class: "meta" }, brandText("intro") || t("loginIntro")),
      h("form", { class: "acc-form", onSubmit: async (e) => {
        e.preventDefault();
        try { await api("/auth/request", { method: "POST", body: { email: email.value, lang: getLang() } }); stepCode(); }
        catch (err) { fail(err, err.body?.error === "invalid_email" ? t("invalidEmail") : t("genericError")); }
      } }, h("label", { class: "field" }, h("span", {}, t("loginEmail")), email), msg, h("button", { class: "btn primary", type: "submit" }, t("loginSend")))));
    email.focus();
  };
  const stepCode = () => {
    msg.textContent = ""; code.value = "";
    $app.replaceChildren(h("div", { class: "login-card" }, h("h2", {}, brandText("title") || t("loginTitle")), h("p", { class: "meta" }, t("loginCodeSent")), h("p", {}, h("b", {}, email.value.trim())),
      h("form", { class: "acc-form", onSubmit: async (e) => {
        e.preventDefault();
        try { await api("/auth/verify", { method: "POST", body: { email: email.value, code: code.value } }); boot(); }
        catch (err) { fail(err, t("loginBadCode")); code.value = ""; code.focus(); }
      } }, code, msg, h("button", { class: "btn primary", type: "submit" }, t("loginVerify"))),
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "button", onClick: async () => { try { await api("/auth/request", { method: "POST", body: { email: email.value, lang: getLang() } }); toast(t("loginCodeSent").split(":")[0]); } catch (err) { fail(err, t("genericError")); } } }, t("loginResend")),
        h("button", { class: "btn", type: "button", onClick: stepEmail }, t("loginChangeEmail")))));
    code.focus();
  };
  stepEmail();
}

async function boot() {
  await loadBrand();
  try {
    state.me = await api("/me");
  } catch (e) {
    if (e.status === 401) { renderLogin(); return; }
    renderChrome();
    const detail = e.body?.email ? `${t("signedInAs")} ${e.body.email}` : e.body?.reason ?? String(e.message ?? "");
    $app.replaceChildren(h("div", { class: "empty" }, h("h2", {}, t("noAccessTitle")), t("noAccessBody"),
      h("p", { class: "meta" }, detail)));
    return;
  }
  [state.restaurants, state.roles, state.posts] = await Promise.all([api("/restaurants"), api("/roles"), api("/posts").catch(() => [])]);
  state.posts = localizePosts(state.posts);
  openFromLink();
  render();
}
// A notification opens the app on the right screen: /?view=community&c=3, /?view=account&tab=timeoff, /?view=admin&section=timeoff
function openFromLink() {
  const q = new URLSearchParams(location.search);
  const view = q.get("view");
  if (view && ["mine", "schedule", "community", "account", "admin"].includes(view) && (view !== "admin" || state.me?.me.is_admin)) {
    state.view = view;
    if (q.get("c")) state.communityId = Number(q.get("c"));
    if (q.get("tab")) state.accountTab = q.get("tab");
    if (q.get("section")) state.adminSection = q.get("section");
  }
  if (view) history.replaceState(null, "", location.pathname);
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { /* notifications simply stay unavailable */ });
boot();
