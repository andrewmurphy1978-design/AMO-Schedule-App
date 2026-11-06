import { splitName, joinName, shortNames, orderStaff } from "./names.js";
import { compareOffers } from "./pricing.js";
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
  const native = !!attrs?.native;
  if (tag === "input" && attrs?.type === "date" && !native) { attrs = { ...attrs }; delete attrs.type; enhanceDateInput(el); }
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v == null || k === "native") continue;
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
  // the same for append()
  const nativeAppend = Element.prototype.append;
  Element.prototype.append = function (...nodes) {
    return nativeAppend.apply(this, nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
  };
}


// Every dialog keeps its buttons in its header: when one opens, the title and the row of buttons (Save / Cancel / Delete...) that sit at the bottom
// of a form are moved into a sticky header, so they stay in view however long the form is. Small question dialogs keep theirs under the message.
{
  const SKIP = ["confirm-modal", "prompt-modal", "password-modal"];
  const headerize = (dlg) => {
    if (SKIP.includes(dlg.id)) return;
    const body = dlg.querySelector(".modal-body");
    if (!body || body.querySelector(".dlg-head, .sup-head")) return;
    const title = [...body.children].find((c) => c.tagName === "H2");
    const actions = [...body.children].reverse().find((c) => c.classList.contains("actions") && c.querySelector("button"));
    if (!title || !actions) return;
    const alerts = [...body.children].filter((c) => c.classList.contains("form-error") || c.classList.contains("alert"));
    const bar = document.createElement("div"); bar.className = "dlg-actions wrap";
    bar.append(...actions.children);
    const top = document.createElement("div"); top.className = "dlg-top";
    const head = document.createElement("div"); head.className = "dlg-head";
    head.append(title, bar); top.append(head, ...alerts);
    body.prepend(top);
    actions.remove();
  };
  const nativeShow = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function (...a) { try { headerize(this); } catch { /* keep the dialog as it is */ } return nativeShow.apply(this, a); };
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
// With a department, the hours of that department: delivery starts later (and ends at closing time).
const hoursOn = (restaurantId, day, dept = null) => {
  const r = state.restaurants.find((x) => x.id === restaurantId), dow = dowOf(day);
  const h0 = hoursFor(r?.special_hours, day, openOf(restaurantId, dow), closeOf(restaurantId, dow));
  if (dept === "delivery" && !h0.closed) { const d = r?.delivery_by_dow?.[dow]; if (d && d > h0.open && d < h0.close) return { ...h0, open: d }; }
  return h0;
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
  const el = h("div", { class: "toast", role: "status", popover: "manual" }, msg);
  document.body.append(el);
  try { el.showPopover(); } catch { /* old browser: the toast stays in the normal layer */ } // the top layer puts it above an open dialog
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
const TAB_ICONS = { schedule: "📋", mine: "🕐", posts: "📍", checklist: "✅", voice: "📞", community: "💬", account: "👤", admin: "⚙️" };
function renderChrome() {
  renderClientBanner();
  fsLabel();
  document.getElementById("lang-toggle").textContent = mqDesktop.matches ? (getLang() === "fr" ? "English" : "Français") : (getLang() === "fr" ? "EN" : "FR");
  document.title = `${state.brand.name} · ${t("app")}`;
  // Desktop is for managing the schedule; on a phone people mostly look at their own shifts, so that comes first.
  const tabs = mqDesktop.matches
    ? [["schedule", t("schedule")], ["mine", t("myShifts")], ...(state.checklistShifts?.length || state.restock?.length ? [["checklist", t("listsTab")]] : []), ["community", t("messagesNav")], ["account", t("account")]]
    : [["mine", t("myShifts")], ["schedule", t("schedule")], ...(state.checklistShifts?.length || state.restock?.length ? [["checklist", t("listsTab")]] : []), ["community", t("messagesNav")], ["account", t("account")]];
  // the kitchen managers (and administrators) get the screen where posts are put on the day's shifts
  if (state.me?.me.is_admin || state.me?.managed.some((m) => m.department_id === "kitchen")) tabs.splice(tabs.findIndex(([id]) => id === "community"), 0, ["posts", t("postsTab")]);
  // assisted phone calls (the person types, the other hears it read aloud)
  if (state.me?.voice) tabs.splice(tabs.findIndex(([id]) => id === "account"), 0, ["voice", t("voiceTab")]);
  if (state.me?.me.is_admin) tabs.push(["admin", t("admin")]);
  const nav = document.getElementById("main-tabs");
  nav.replaceChildren(
    ...tabs.map(([id, label]) =>
      h("button", { type: "button", "aria-label": label, title: label, "aria-current": state.view === id ? "page" : false, onClick: () => { state.view = id; render(); } },
        h("span", { class: "tab-ic", "aria-hidden": "true" }, TAB_ICONS[id] ?? "•"), h("span", { class: "tab-tx" }, label),
        id === "community" && (state.communityUnread ?? 0) > 0 ? h("span", { class: "nav-badge", "aria-label": `${state.communityUnread} ${t("newPosts")}` }, String(state.communityUnread)) : null,
        id === "checklist" && state.checklistShifts.length ? h("span", { class: "nav-badge" }, String(state.checklistShifts.reduce((n, x) => n + (x.needs_post ? 1 : x.total - x.done), 0) || (state.checklistShifts.length ? "!" : ""))) : null)),
  );
}

// Everything the header needs (tabs, badges) and the shared lists. It is fetched in parallel; screens do not wait for it once
// a copy exists, so changing tab is immediate and the header catches up a moment later.
let prevView = null;
async function loadChromeData() {
  const [me, restaurants, comm, cl, order, dm] = await Promise.all([api("/me"), api("/restaurants"), api("/communities").catch(() => []), api("/my-checklist").catch(() => ({ test: false, shifts: [] })), api("/staff-order").catch(() => []), api("/messages/unread").catch(() => ({ unread: 0 }))]);
  const changed = JSON.stringify([state.me, state.restaurants]) !== JSON.stringify([me, restaurants]);
  state.me = me; state.restaurants = restaurants; setStaffOrder(order);
  state.checklistShifts = cl.shifts; state.checklistTest = cl.test; state.restock = cl.restock ?? [];
  // the tab is hidden outside a shift, except in test mode (administrators always see it then)
  if (cl.test && me.me.is_admin && !cl.shifts.length) state.checklistShifts = [{ id: 0, total: 0, done: 0, preview: true }];
  state.dmUnread = dm.unread || 0;
  state.communityUnread = comm.reduce((n, x) => n + (x.unread || 0), 0) + state.dmUnread; // posts and personal messages share the badge
  return changed;
}
async function render() {
  renderChrome();
  try {
    // Roles and manager scopes can change in Administration at any time: after leaving it (or on the first screen) wait for fresh data;
    // otherwise show the screen at once with the copy we have and update it in the background.
    if (state.view !== "admin") {
      const wait = !state.me || !state.restaurants || prevView === "admin";
      const loading = loadChromeData();
      if (wait) await loading;
      else loading.then((changed) => {
        if (state.view === "checklist" && !state.checklistShifts.length && !state.restock.length) { state.view = "mine"; render(); return; }
        if (changed) render(); else renderChrome();
      }).catch((e) => { if (e.status === 401) { state.me = null; renderLogin(); } });
      if (state.view === "checklist" && wait && !state.checklistShifts.length && !state.restock.length) state.view = "mine";
      renderChrome();
    }
    prevView = state.view;
    if (state.view === "schedule") await renderSchedule();
    else if (state.view === "mine") await renderMine();
    else if (state.view === "timeoff") { state.view = "account"; state.accountTab = "timeoff"; await renderAccount(); }
    else if (state.view === "posts") await renderPostBoard();
    else if (state.view === "checklist") await renderChecklist();
    else if (state.view === "voice") await renderVoice();
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
  const chg = datas.map((d) => d.changes).filter(Boolean);
  const changes = chg.length ? { published_at: Math.max(...chg.map((c) => c.published_at)), by_shift: Object.assign({}, ...chg.map((c) => c.by_shift)), removed: chg.flatMap((c) => c.removed) } : null;
  return { ...datas[0], changes, editable: datas.some((d) => d.editable), shifts, hours, elsewhere, time_off, days_off, skills, any_skills: datas.some((d) => d.any_skills), delivery_presence, limits: { ...datas[0].limits, by_staff } };
}
// The history of a schedule: every publication (the schedule as it was published) and what changed since the last one.
async function scheduleHistoryDialog(deps, sel) {
  let dlg = document.getElementById("history-modal");
  if (!dlg) { dlg = h("dialog", { id: "history-modal", class: "wide" }); document.body.append(dlg); }
  const body = h("div", { class: "hist-body" }, h("p", { class: "meta" }, t("loading")));
  dlg.replaceChildren(h("div", { class: "modal-body" }, h("h2", {}, `🕘 ${t("chgHistoryTitle")}`), body, h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onClick: () => dlg.close() }, t("close")))));
  dlg.showModal();
  const stamp = (ms) => new Date(ms).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short", hourCycle: "h23" });
  const hm = (iso) => iso.slice(11, 16);
  try {
    const parts = [];
    for (const dep of deps) {
      const d = await api(`/schedule/history?restaurant=${sel.restaurant}&department=${dep}&week=${sel.week}`);
      const nm = (id) => d.names[id] ?? `#${id}`, dayName = (iso) => fmt(iso.slice(0, 10), { weekday: "short", day: "numeric", month: "short" });
      const c = d.changes;
      const lines = c ? [
        ...c.replaced.map((r) => `🔁 ${nm(r.to.staff_id)} ${t("chgReplaces")} ${nm(r.from.staff_id)} — ${dayName(r.to.start_at)} ${hm(r.to.start_at)}–${hm(r.to.end_at)}`),
        ...c.changed.map((x) => `✏️ ${nm(x.after.staff_id)} — ${dayName(x.after.start_at)} : ${hm(x.before.start_at)}–${hm(x.before.end_at)} → ${hm(x.after.start_at)}–${hm(x.after.end_at)}`),
        ...c.added.map((a) => `➕ ${nm(a.staff_id)} — ${dayName(a.start_at)} ${hm(a.start_at)}–${hm(a.end_at)}`),
        ...c.removed.map((r) => `❌ ${nm(r.staff_id)} — ${dayName(r.start_at)} ${hm(r.start_at)}–${hm(r.end_at)}`)] : [];
      parts.push(h("section", { class: "card" }, h("h3", {}, t(`dept.${dep}`)),
        h("h4", {}, t("chgChangesSince")), lines.length ? h("ul", { class: "hist-lines" }, lines.map((l) => h("li", {}, l))) : h("p", { class: "meta" }, t("chgNone")),
        h("h4", {}, t("chgPublications")),
        ...d.publications.map((pub, i) => h("details", { class: "hist-pub", open: false }, h("summary", {}, `${i === 0 ? "★ " : ""}${t("chgPublishedOn")} ${stamp(pub.published_at)}${pub.published_by ? ` ${t("chgBy")} ${pub.published_by}` : ""} · ${pub.shifts.length} ${t("chgShifts")}`),
          h("ul", { class: "hist-lines" }, [...pub.shifts].sort((a, b) => a.start_at.localeCompare(b.start_at)).map((x) => h("li", {}, `${dayName(x.start_at)} ${hm(x.start_at)}–${hm(x.end_at)} · ${nm(x.staff_id)}`)))))));
    }
    body.replaceChildren(...parts);
  } catch (e) { body.replaceChildren(h("p", { class: "meta" }, errorText(e))); }
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
      } }, `🖨 ${t("printSchedule")}`),
      h("button", { class: "btn", type: "button", title: t("printSheetHint"), onClick: async () => {
        const prev = state.scheduleTab;
        if (prev !== "table") { state.scheduleTab = "table"; await render(); }
        document.body.classList.add("print-paper");
        window.addEventListener("afterprint", () => { document.body.classList.remove("print-paper"); if (state.scheduleTab !== prev) { state.scheduleTab = prev; render(); } }, { once: true });
        setTimeout(() => window.print(), 150);
      } }, `🧾 ${t("printSheet")}`));
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
  for (const r of data.changes?.removed ?? []) if (!people.has(r.staff_id)) people.set(r.staff_id, r.staff_name);
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
  // The printed sheet (the paper layout used in the restaurants): one row per employee, two stacked boxes per day (start / end, in decimals, F = until closing),
  // a Total column, then empty rows to fill in by hand. Shown only when printing with the "sheet" button.
  const dec = (iso) => { const [hh, mm] = iso.slice(11, 16).split(":").map(Number); const v = Math.round((hh + mm / 60) * 100) / 100; return String(Number.isInteger(v * 10) ? v.toFixed(1) : v).replace(".", ","); };
  const sheetCell = (id, d) => {
    const mine = data.shifts.filter((s) => s.staff_id === id && dayOf(s.start_at) === d && s.status !== "sick_open").sort((x, y) => x.start_at.localeCompare(y.start_at));
    const away = elsewhereAt(id, d);
    const lines = mine.slice(0, 2).map((s) => [dec(s.start_at), s.until_close ? "F" : dec(s.end_at)]);
    if (!lines.length && away.length) lines.push([shortResto(away[0].restaurant).toLowerCase().slice(0, 6), ""]);
    while (lines.length < 2) lines.push(["", ""]);
    return h("td", { class: "ps-day" }, h("div", { class: "ps-box" }, lines.flatMap(([a, b]) => [h("span", {}, a), h("span", {}, b)])));
  };
  const paperSheet = h("div", { class: "paper-sheet" },
    h("div", { class: "ps-title" }, h("b", {}, `${t("sheetTitle")} ${sel.departments.map((d) => t(`dept.${d}`)).join(" · ")}`), h("div", {}, `Mikes ${options.find((r) => r.id === sel.restaurant)?.name ?? ""}`)),
    h("div", { class: "ps-week" }, h("span", {}, t("sheetWeek")), h("span", { class: "ps-range" }, `${fmt(days[0], { day: "2-digit", month: "short" })}  ${fmt(days[6], { day: "2-digit", month: "short" })}`)),
    h("table", {}, h("thead", {}, h("tr", {}, h("th", {}), days.map((d) => h("th", {}, fmt(d, { weekday: "long" }))), h("th", {}, t("total")))),
      h("tbody", {}, [...rows.map(([id, name]) => h("tr", {}, h("td", { class: "ps-name" }, h("b", {}, parts.get(id)?.first ?? name)), days.map((d) => sheetCell(id, d)),
        h("td", { class: "ps-total" }, h("span", {}, data.hours?.[id] ? hrs(data.hours[id].here) : ""), h("span", {}, data.hours?.[id] && data.hours[id].all - data.hours[id].here > 0.01 ? hrs(data.hours[id].all) : "")))),
        ...Array.from({ length: Math.max(3, 18 - rows.length) }, () => h("tr", { class: "ps-blank" }, h("td", { class: "ps-name" }), days.map(() => h("td", { class: "ps-day" }, h("div", { class: "ps-box" }, ["", "", "", ""].map(() => h("span", {}))))), h("td", { class: "ps-total" }, h("span", {}), h("span", {})))) ])));
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
            const body = [h("b", {}, range(s).replace(" – ", "–")), s.segments?.length ? "" : ` ${shiftRoleIcons(s)} `, ...roleLines(s), s.posts?.length ? h("span", { class: "post-tag", title: t("kitchenPosts") }, `📍 ${s.posts.map((p) => (getLang() === "en" ? p.name_en : p.name_fr) + (p.start_at ? ` ${hhmm(p.start_at)}–${hhmm(p.end_at)}` : "")).join(", ")}`) : null, sick ? h("span", { class: "sick-badge" }, `🚫 ${t("sickOpen")}`) : null,
              null];
            const c = staffColor(s.staff_id, s.staff_color);
            const style = `border-left-color:${c};background:color-mix(in srgb, ${c} 16%, var(--card))`;
            // changed since the schedule was published: a replacement, other hours, or a shift added later (each in its own colour)
            const ch = data.changes?.by_shift?.[s.id] ?? (s.replaced_name ? { kind: "replacement", from_name: s.replaced_name } : null);
            if (ch?.kind === "replacement") body.push(h("span", { class: "chg-badge" }, `🔁 ${t("chgReplaces")} ${ch.from_name}`));
            else if (ch?.kind === "changed") body.push(h("span", { class: "chg-badge" }, `✏️ ${t("chgBefore")} ${hhmm(ch.before.start_at)}–${hhmm(ch.before.end_at)}`));
            else if (ch?.kind === "added") body.push(h("span", { class: "chg-badge" }, `➕ ${t("chgAdded")}`));
            const cls = `shift-chip ${sick ? "sick" : ""} ${ch ? `chg-${ch.kind}` : ""} ${data.conflicts.shifts.has(s.id) ? "conflict" : ""}`;
            return data.editable ? h("button", { class: cls, type: "button", style, onClick: () => openEditor(s) }, body) : h("div", { class: cls, style }, body);
          }),
          (data.changes?.removed ?? []).filter((r) => r.staff_id === id && dayOf(r.start_at) === d).map((r) => h("div", { class: "shift-chip chg-removed", title: t("chgRemoved") }, h("b", {}, `${hhmm(r.start_at)}–${hhmm(r.end_at)}`), h("span", { class: "chg-badge" }, `❌ ${t("chgRemoved")}`))),
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
  const when = (ms) => new Date(ms).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const changesBar = data.changes ? h("div", { class: "chg-bar" }, h("span", {}, `${t("chgSince")} ${when(data.changes.published_at)} :`),
    h("span", { class: "chg-key chg-replacement" }, `🔁 ${t("chgReplacement")}`), h("span", { class: "chg-key chg-changed" }, `✏️ ${t("chgChanged")}`), h("span", { class: "chg-key chg-added" }, `➕ ${t("chgAdded")}`), h("span", { class: "chg-key chg-removed" }, `❌ ${t("chgRemoved")}`)) : null;
  const historyBtn = editableDepts.length && datas.some((d) => d.published) ? h("button", { class: "btn", type: "button", onClick: () => scheduleHistoryDialog(editableDepts.filter((d) => datas[depts.indexOf(d)].published), sel) }, `🕘 ${t("chgHistory")}`) : null;
  const publishBar = h("div", { class: `publish-bar ${editableDepts.length ? (draftDepts.length ? "draft" : "live") : allDraft ? "draft" : "live"}` },
    h("span", { class: "pb-text" }, barText), h("div", { class: "pb-tools" },
      draftDepts.length && editableDepts.length ? h("label", { class: "check notify-check" }, h("input", { type: "checkbox", checked: state.notifyOnPublish, onChange: (e) => { state.notifyOnPublish = e.target.checked; try { localStorage.setItem("notifyOnPublish", e.target.checked ? "1" : "0"); } catch { /* ignore */ } } }), h("span", {}, t("notifyEmployees"))) : null,
      historyBtn, barButton, orderField, printField));
  $app.replaceChildren(...[printHead, controls, publishBar, changesBar, subtabs, data.editable ? coveragePanel(render) : null, weekTimeOffPanel(data), ...(onTable ? [daytabs, daily, grid, paperSheet] : state.scheduleTab === "summary" ? [renderSummary({ days, payroll, sel, data, boxes: renderTimeline({ data, days, targets, sets, payroll, openEditor, weekView: true }).boxes })] : [timeline]), fab].filter(Boolean));
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
    const hrs = hoursOn(sel.restaurant, day, sel.departments.length === 1 ? sel.departments[0] : null);
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

    // Single day on a computer: present/required for each department with its icon in front (🍕 3/3 · 🚗 1/1). On a phone only the total is shown (2/3).
    const perDept = shown.length === 1 && desktop && sel.departments.length > 0 ? sel.departments.map((dep) => {
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
  // kitchen shifts: the manager puts the posts worked on the shift (at the start, or while it runs); the employee's end-of-shift list follows
  const postsBox = h("div", { class: "field posts-assign", hidden: true });
  const drawPosts = (d) => {
    postsBox.hidden = !d.posts.length;
    postsBox.replaceChildren(h("span", {}, t("kitchenPosts")), h("div", { class: "cl-posts", role: "group", "aria-label": t("kitchenPosts") }, d.posts.map((p) => h("button", { type: "button", class: `chip-btn ${p.picked ? "on" : ""}`, "aria-pressed": String(p.picked), onClick: async () => {
      try {
        const list = d.lists.find((l) => l.kind === "post" && l.target_id === p.id);
        if (p.picked) { if (list?.items.some((i) => i.done) && !(await ask(t("checklistRemovePostConfirm")))) return; await api(`/shifts/${shift.id}/checklist/posts/${p.id}`, { method: "DELETE" }); }
        else await api(`/shifts/${shift.id}/checklist/posts`, { method: "POST", body: { post_id: p.id } });
        drawPosts(await api(`/shifts/${shift.id}/checklist`)); render();
      } catch (e) { toast(errorText(e)); }
    } }, `${p.picked ? "✓ " : ""}${getLang() === "en" ? p.name_en : p.name_fr}`))), h("span", { class: "meta" }, t("kitchenPostsHelp")));
  };
  if (shift) api(`/shifts/${shift.id}/checklist`).then(drawPosts).catch(() => { /* not a shift with posts */ });
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
    const m = toMin(hoursOn(sel.restaurant, date.value, role.department_id).open) - role.pre_open_minutes;
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
    h("label", { class: "field" }, h("span", {}, t("role")), roleSel), alsoBox, segBox, postsBox,
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
// Which communities one employee sees: those of their roles by default, or exactly the ones ticked here.
function communityAccessPane(person) {
  const box = h("div", { class: "sched-access" });
  async function load() {
    const d = await api(`/staff/${person.id}/community-access`);
    const boxes = new Map();
    const start = new Set(d.custom ? d.ids : d.auto); // switching to "custom" starts from what they see now
    const mode = radioGroup(`ca-${person.id}`, [["auto", t("caAuto")], ["custom", t("caCustom")]], d.custom ? "custom" : "auto");
    const restos = [...new Set(d.communities.map((c) => c.restaurant_id))];
    const list = h("div", { class: "ca-list" }, restos.map((rid) => h("div", { class: "ca-resto" }, h("h5", {}, d.communities.find((c) => c.restaurant_id === rid).restaurant),
      d.communities.filter((c) => c.restaurant_id === rid).map((c) => { const input = h("input", { type: "checkbox", checked: start.has(c.id) }); boxes.set(c.id, input); return h("label", { class: "check" }, input, h("span", {}, c.name)); }))));
    const sync = () => { const custom = mode.value === "custom"; boxes.forEach((input, id) => { input.disabled = !custom; if (!custom) input.checked = d.auto.includes(id); }); };
    mode.addEventListener("change", sync); sync();
    box.replaceChildren(h("h4", {}, t("community")), h("p", { class: "meta" }, t("caHelp")), mode, list,
      h("button", { class: "btn primary", type: "button", onClick: async () => {
        const custom = mode.value === "custom";
        try { await api(`/staff/${person.id}/community-access`, { method: "PUT", body: { custom, ids: custom ? [...boxes].filter(([, i]) => i.checked).map(([id]) => id) : [] } }); toast(t("saved")); load(); } catch (e) { toast(errorText(e)); }
      } }, t("save")));
  }
  load().catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

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
  const when = (ms) => new Date(ms).toLocaleString(getLang() === "fr" ? "fr-CA" : "en-CA", { dateStyle: "medium", timeStyle: "short", hourCycle: "h23" });
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
    const touch = matchMedia("(pointer: coarse)").matches; // a phone: the native date picker (reliable when the fields are pre-filled with the last dates)
    const vf = h("input", { type: "date", native: touch, value: lastDates.from ?? "" }), vt = h("input", { type: "date", native: touch, value: lastDates.to ?? "" });
    const list = rows.filter((r) => r.kind !== "day_off");
    const daysPart = [
      h("h4", {}, t("fixedDaysOff")), h("p", { class: "meta" }, t("fixedDaysOffHelp")), days,
      // On each fixed day off: can this person still be asked to cover a sick colleague that day?
      [...dayOffs.entries()].sort((a, b) => a[0] - b[0]).map(([i, r]) => h("label", { class: "check repl-row" },
        h("input", { type: "checkbox", checked: !!r.replacement_ok, onChange: async (e) => { try { await api(`/availability/${r.id}`, { method: "PUT", body: { replacement_ok: e.target.checked } }); toast(t("saved")); } catch (err) { e.target.checked = !e.target.checked; toast(errorText(err)); } } }),
        h("span", { class: "repl-text" }, h("b", {}, weekdayName(i)), h("small", {}, t("replacementOk")))))];
    const timesPart = [
      h("h4", {}, t("unavailableTimes")), h("p", { class: "meta" }, t("unavailableHelp")),
      list.length ? h("div", { class: "log" }, list.map((r) => h("div", { class: "log-row avail-row" },
        h("div", { class: "avail-text" },
          h("span", {}, h("b", {}, weekdayName(r.dow)), ` ${r.start_time}–${r.end_time}${r.note ? ` · ${r.note}` : ""}`),
          r.valid_from || r.valid_to ? h("span", { class: "meta" }, `${r.valid_from ? longDate(r.valid_from) : "…"} → ${r.valid_to ? longDate(r.valid_to) : "…"}`) : null),
        h("button", { class: "icon-btn avail-del", type: "button", title: t("delete"), "aria-label": t("delete"), onClick: async () => { await api(`/availability/${r.id}`, { method: "DELETE" }); load(); } }, "🗑️")))) : h("p", { class: "meta" }, t("noUnavailable")),
      h("div", { class: "inline-form", style: "grid-template-columns:1fr" },
        h("div", { class: "avail-line" },
          h("div", { class: "inline-form day-time-line" }, h("label", { class: "field" }, h("span", {}, t("weekday")), dow), h("label", { class: "field" }, h("span", {}, t("from")), st), h("label", { class: "field" }, h("span", {}, t("to")), en)),
          h("div", { class: "inline-form avail-valid" }, h("label", { class: "field" }, h("span", {}, t("validFrom")), vf), h("label", { class: "field" }, h("span", {}, t("validTo")), vt))),
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
// Change a leave request: allowed until its dates are over. An approved leave goes back to "requested" when the employee changes it.
function timeOffEditDialog(r, onSaved) {
  const today = ymd(new Date());
  const dlg = h("dialog", { class: "modal" });
  const from = h("input", { type: "date", required: true, value: r.start_date, min: r.start_date < today ? r.start_date : today });
  const to = h("input", { type: "date", value: r.end_date, min: r.start_date });
  from.addEventListener("change", () => { to.min = from.value; if (to.value < from.value) to.value = from.value; });
  const allDay = h("input", { type: "checkbox", checked: !r.start_time });
  const tStart = timeField(r.start_time ?? "14:00"), tEnd = timeField(r.end_time ?? "21:00");
  const timeBox = h("div", { class: "inline-form", style: "grid-template-columns:1fr 1fr", hidden: !r.start_time }, h("label", { class: "field" }, h("span", {}, t("start")), tStart), h("label", { class: "field" }, h("span", {}, t("end")), tEnd));
  allDay.addEventListener("change", () => { timeBox.hidden = allDay.checked; });
  const note = h("input", { maxLength: 300, value: r.note ?? "", placeholder: t("optional") });
  const done = () => { dlg.close(); dlg.remove(); };
  dlg.append(h("form", { class: "modal-body", onSubmit: async (e) => {
    e.preventDefault();
    try {
      const body = { start_date: from.value, end_date: to.value || from.value, note: note.value };
      if (!allDay.checked) { body.start_time = tStart.value; body.end_time = tEnd.value; }
      const res = await api(`/time-off/${r.id}`, { method: "PUT", body });
      toast(res.status === "requested" && r.status === "approved" ? t("leaveUpdatedAgain") : t("leaveUpdated")); done(); onSaved?.();
    } catch (err) {
      const k = err.body?.error;
      toast(k === "already_requested" ? t("alreadyRequested") : k === "invalid_times" ? t("opensBeforeCloses") : k === "in_the_past" ? t("leaveInThePast") : errorText(err));
    }
  } }, h("h2", {}, t("editLeaveTitle")),
    r.status === "approved" ? h("p", { class: "alert" }, t("editApprovedWarn")) : null,
    h("label", { class: "field" }, h("span", {}, t("fromDate")), from), h("label", { class: "field" }, h("span", {}, t("toDate")), to),
    h("label", { class: "check" }, allDay, h("span", {}, t("allDay"))), timeBox,
    h("label", { class: "field" }, h("span", {}, t("note")), note),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: done }, t("cancel")), h("button", { class: "btn primary", type: "submit" }, t("save")))));
  dlg.addEventListener("close", () => dlg.remove(), { once: true });
  document.body.append(dlg); dlg.showModal();
}

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
      r.status === "requested" || r.status === "approved" ? h("div", { class: "actions" },
        // editable until the dates are over
        r.end_date >= today ? h("button", { class: "btn", type: "button", onClick: () => timeOffEditDialog(r, () => render()) }, `✎ ${t("editLeave")}`) : null,
        h("button", { class: "btn", type: "button", onClick: async () => { if ((await ask(t("confirmCancelOff")))) { await api(`/time-off/${r.id}/cancel`, { method: "POST" }); render(); } } }, t("cancel"))) : null))
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
  return [h("div", { class: "leave-cols" }, form, myList), state.me.me.is_admin ? null : reviewBox].filter(Boolean);
}

// Photos are shrunk in the browser before they are sent; videos go as they are (20 MB at most).
async function shrinkImage(file) {
  if (file.type === "image/png" && file.size < 400 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas"); canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("invalid_media"))), "image/jpeg", 0.82));
  } catch { return file; }
}
const uploadCommunityMedia = (communityId, file) => uploadMedia(`/api/communities/${communityId}/media`, file);
async function uploadMedia(url, file) {
  const isVideo = file.type.startsWith("video/"), isAudio = file.type.startsWith("audio/");
  if (!isVideo && !isAudio && !file.type.startsWith("image/")) throw new Error("invalid_type");
  if (isVideo && file.size > 20 * 1024 * 1024) throw new Error("too_large");
  if (isAudio && file.size > 6 * 1024 * 1024) throw new Error("too_large");
  const blob = isVideo || isAudio ? file : await shrinkImage(file);
  const res = await fetch(url, { method: "POST", headers: { "content-type": blob.type || file.type, ...clientHeader() }, body: blob });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error ?? "error"), { body: j });
  return { id: j.id, kind: j.kind, url: URL.createObjectURL(blob), transcript: j.transcript ?? null };
}
// the pictures and videos of a post (tap a picture to see it full size); voice messages, and a transcript under each voice or video message
function mediaGrid(list = [], base = "/api/community-media/") {
  if (!list.length) return null;
  const visual = list.filter((m) => m.kind !== "audio");
  const transcript = (m) => {
    if (!m.transcript) return state.me?.deaf_mute ? h("p", { class: "meta tr-none" }, `📝 ${t("transcriptNone")}`) : null;
    return h("details", { class: "post-transcript", open: true }, h("summary", {}, `📝 ${t("transcriptTitle")}`), h("p", {}, m.transcript));
  };
  return h("div", { class: "post-media-wrap" },
    visual.length ? h("div", { class: `post-media n${Math.min(visual.length, 4)}` }, visual.map((m) => m.kind === "video"
      ? h("video", { src: `${base}${m.id}`, controls: true, preload: "metadata", playsinline: true })
      : h("a", { href: `${base}${m.id}`, target: "_blank", rel: "noopener" }, h("img", { src: `${base}${m.id}`, alt: "", loading: "lazy" })))) : null,
    list.filter((m) => m.kind === "audio").map((m) => h("div", { class: "post-voice" }, h("b", {}, `🎤 ${t("voiceMsg")}`), h("audio", { src: `${base}${m.id}`, controls: true, preload: "metadata" }), transcript(m))),
    visual.filter((m) => m.kind === "video").map(transcript));
}

// ---------- Messenger-style actions on a message or a post: a small toolbar on hover (computer), a sheet on a long press (phone) ----------
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
/** actions: { react(emoji), reply(), pin: { label, run } | null, del() | null }. Adds the toolbar to `host` and the long-press sheet. */
function msgActions(host, actions) {
  host.classList.add("has-tools");
  const quick = (anchor, done) => {
    document.querySelector(".react-quick")?.remove();
    const pop = h("div", { class: "react-quick", role: "dialog", "aria-label": t("react") });
    const close = () => { pop.remove(); document.removeEventListener("pointerdown", outside, true); };
    const outside = (ev) => { if (!pop.contains(ev.target)) close(); };
    pop.append(...QUICK_REACTIONS.map((e) => h("button", { type: "button", class: "round", onClick: () => { close(); done?.(); actions.react(e); } }, e)),
      h("button", { type: "button", class: "round", "aria-label": t("emojis"), title: t("emojis"), onClick: (ev) => { close(); done?.(); emojiPopover(ev.currentTarget.isConnected ? ev.currentTarget : anchor, (em) => actions.react(em)); } }, "＋"));
    (anchor.parentElement ?? document.body).append(pop); pop.parentElement.style.position ||= "relative";
    setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  };
  const btn = (icon, label, onClick, danger = false) => h("button", { type: "button", class: `round ${danger ? "danger" : ""}`, "aria-label": label, title: label, onClick }, icon);
  const tools = h("div", { class: "msg-tools" },
    actions.react ? btn("😊", t("react"), (e) => quick(e.currentTarget)) : null, actions.reply ? btn("↩", t("reply"), () => actions.reply()) : null,
    actions.pin ? btn("📌", actions.pin.label, () => actions.pin.run()) : null, actions.del ? btn("🗑", t("delete"), () => actions.del(), true) : null);
  host.append(tools);
  // phone: long press (or the context-menu key / right click) opens a sheet with the reactions and the actions
  const sheet = () => {
    document.querySelector(".msg-sheet-wrap")?.remove();
    const close = () => wrap.remove();
    const row = (icon, label, run, danger) => h("button", { type: "button", class: `sheet-row ${danger ? "danger" : ""}`, onClick: () => { close(); run(); } }, h("span", { "aria-hidden": "true" }, icon), ` ${label}`);
    const wrap = h("div", { class: "msg-sheet-wrap", onClick: (e) => { if (e.target === wrap) close(); } }, h("div", { class: "msg-sheet", role: "dialog" },
      actions.react ? h("div", { class: "sheet-reacts" }, ...QUICK_REACTIONS.map((e) => h("button", { type: "button", class: "round", onClick: () => { close(); actions.react(e); } }, e)),
        h("button", { type: "button", class: "round", "aria-label": t("emojis"), onClick: () => { close(); emojiPopover(host, (em) => actions.react(em)); } }, "＋")) : null,
      actions.reply ? row("↩", t("reply"), () => actions.reply()) : null, actions.pin ? row("📌", actions.pin.label, () => actions.pin.run()) : null, actions.del ? row("🗑", t("delete"), () => actions.del(), true) : null,
      h("button", { type: "button", class: "sheet-row cancel", onClick: close }, t("cancel"))));
    document.body.append(wrap);
    if (navigator.vibrate) try { navigator.vibrate(15); } catch { /* not everywhere */ }
  };
  let timer = null, x0 = 0, y0 = 0;
  const stop = () => { clearTimeout(timer); timer = null; };
  host.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse" || e.target.closest("a,button,audio,video,input,textarea")) return; x0 = e.clientX; y0 = e.clientY; timer = setTimeout(() => { timer = null; sheet(); }, 450); });
  host.addEventListener("pointermove", (e) => { if (timer && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) stop(); });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) host.addEventListener(ev, stop);
  host.addEventListener("contextmenu", (e) => { if (e.target.closest("a,audio,video,input,textarea")) return; if (e.pointerType === "touch" || matchMedia("(pointer: coarse)").matches) { e.preventDefault(); sheet(); } });
}

// Records a voice or a video message with the microphone / camera. Resolves to a File, or null when cancelled.
function recordMessage(withVideo) {
  return new Promise(async (resolve) => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { toast(t("recUnsupported")); resolve(null); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia(withVideo ? { audio: true, video: { facingMode: "user", width: { ideal: 640 } } } : { audio: true }); }
    catch { toast(t("recDenied")); resolve(null); return; }
    const maxSec = withVideo ? 60 : 300;
    const mime = (withVideo ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"] : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]).find((m) => MediaRecorder.isTypeSupported?.(m));
    let rec, chunks = [], timer = null, started = 0, finished = false;
    let dlg = document.getElementById("rec-modal"); if (!dlg) { dlg = h("dialog", { id: "rec-modal" }); document.body.append(dlg); }
    const clock = h("b", { class: "rec-clock" }, "0:00");
    const preview = withVideo ? h("video", { class: "rec-preview", muted: true, autoplay: true, playsinline: true }) : h("div", { class: "rec-mic", "aria-hidden": "true" }, "🎤");
    if (withVideo) preview.srcObject = stream;
    const finish = (file) => { if (finished) return; finished = true; clearInterval(timer); stream.getTracks().forEach((tr) => tr.stop()); if (dlg.open) dlg.close(); resolve(file); };
    const startBtn = h("button", { class: "btn primary big", type: "button", onClick: () => {
      try { rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), ...(withVideo ? { videoBitsPerSecond: 1_000_000 } : { audioBitsPerSecond: 64_000 }) }); } catch { toast(t("recUnsupported")); finish(null); return; }
      rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      rec.onstop = () => { const type = (rec.mimeType || mime || (withVideo ? "video/webm" : "audio/webm")).split(";")[0]; finish(chunks.length ? new File(chunks, `${withVideo ? "video" : "voice"}.${type.split("/")[1].replace("x-", "")}`, { type }) : null); };
      rec.start(1000); started = Date.now(); startBtn.hidden = true; stopBtn.hidden = false; status.textContent = `🔴 ${t("recRecording")}`;
      timer = setInterval(() => { const s = Math.floor((Date.now() - started) / 1000); clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; if (s >= maxSec && rec.state === "recording") rec.stop(); }, 250);
    } }, `● ${t("recStart")}`);
    const stopBtn = h("button", { class: "btn primary big", type: "button", hidden: true, onClick: () => { if (rec?.state === "recording") rec.stop(); } }, `■ ${t("recStop")} · ${t("recAttach").toLowerCase()}`);
    const status = h("p", { class: "meta" }, `${t("recMax")} : ${Math.floor(maxSec / 60)}:${String(maxSec % 60).padStart(2, "0")}`);
    dlg.replaceChildren(h("div", { class: "modal-body rec-body" }, h("h2", {}, withVideo ? `🎥 ${t("recVideo")}` : `🎤 ${t("recVoice")}`), preview, clock, status,
      h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: () => { chunks = []; if (rec?.state === "recording") { rec.onstop = () => finish(null); rec.stop(); } else finish(null); } }, t("recCancel")), startBtn, stopBtn)));
    dlg.addEventListener("close", () => finish(null), { once: true });
    dlg.showModal();
  });
}

// ---- emojis: a picker with categories (like Messenger) for messages and reactions on posts ----
const EMOJI_CATS = [
  ["😀", "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 ☺️ 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👹 👺 👻 👽 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾"],
  ["👋", "👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦵 🦶 👂 👃 🧠 👀 👁️ 👅 👄 👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 🙍 🙎 🙅 🙆 💁 🙋 🧏 🙇 🤦 🤷 👮 💂 👷 🤴 👸 👳"],
  ["❤️", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 💯 💢 💥 💫 💦 💨 💬 🗨️ 💭 💤 ✅ ❌ ❓ ❗ ⚠️ 🚫 ⭕ 🔥 ⭐ 🌟 ✨ ⚡ 🎉 🎊 🏆 🥇 🥈 🥉 ➕ ➖ ➡️ ⬅️ ⬆️ ⬇️ 🔔 🔕 📌 📍"],
  ["🐶", "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦉 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🐢 🐍 🐙 🦀 🐠 🐟 🐬 🐳 🦈 🐊 🐘 🦒 🌸 🌹 🌻 🌼 🌷 🌱 🌲 🌳 🍀 🍁 🍂 🌈 ☀️ 🌤️ ⛅ ☁️ 🌧️ ⛈️ ❄️ ☃️ 🌊"],
  ["🍕", "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🥕 🌽 🌶️ 🥔 🍞 🥐 🥖 🥨 🧀 🥚 🍳 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍦 🍧 🍨 🍩 🍪 🎂 🍰 🧁 🥧 🍫 🍬 🍭 ☕ 🍵 🥤 🧃 🍺 🍻 🥂 🍷 🥃 🍸 🍹"],
  ["⚽", "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏒 🥊 🎯 🎳 🎮 🎲 🎵 🎶 🎤 🎧 🎸 🎹 🎬 🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚚 🚜 🏍️ 🛵 🚲 ✈️ 🚀 🚁 ⛵ 🚢 🏠 🏡 🏢 🏪 🏫 ⛪ 🌍 🗺️ 🏖️ ⛰️ 🏕️"],
  ["💡", "⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 📷 📹 🎥 📞 ☎️ 📺 📻 ⏰ ⏱️ 🕐 🕑 🕒 🔋 🔌 💡 🔦 💰 💵 💳 🧾 📅 📆 🗓️ 📋 📝 ✏️ 📎 🖇️ 📏 ✂️ 🗂️ 📁 📦 🧰 🔧 🔨 🔑 🔒 🔓 🧹 🧺 🛒 🎁 🎈 🧯 🩹 💊 🩺"],
].map(([icon, list]) => [icon, list.split(" ")]);
const recentEmojis = () => { try { return JSON.parse(localStorage.getItem("emojiRecent") ?? "[]"); } catch { return []; } };
const rememberEmoji = (e) => { try { localStorage.setItem("emojiRecent", JSON.stringify([e, ...recentEmojis().filter((x) => x !== e)].slice(0, 24))); } catch { /* ignore */ } };
function emojiPopover(anchor, onPick) {
  document.querySelector(".emoji-pop")?.remove();
  const recents = recentEmojis();
  const cats = recents.length ? [["🕘", recents], ...EMOJI_CATS] : EMOJI_CATS;
  let current = 0;
  const grid = h("div", { class: "emoji-grid" });
  const tabs = h("div", { class: "emoji-tabs", role: "tablist" });
  const pick = (e) => { rememberEmoji(e); close(); onPick(e); };
  const draw = () => {
    tabs.replaceChildren(...cats.map(([icon], i) => h("button", { type: "button", role: "tab", "aria-selected": String(i === current), onClick: () => { current = i; draw(); } }, icon)));
    grid.replaceChildren(...cats[current][1].map((e) => h("button", { type: "button", class: "emoji-btn", onClick: () => pick(e) }, e)));
    grid.scrollTop = 0;
  };
  const pop = h("div", { class: "emoji-pop", role: "dialog", "aria-label": t("emojis") }, tabs, grid);
  const close = () => { pop.remove(); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", esc, true); };
  const outside = (ev) => { if (!pop.contains(ev.target) && ev.target !== anchor) close(); };
  const esc = (ev) => { if (ev.key === "Escape") close(); };
  draw();
  (anchor.offsetParent ? anchor.parentElement : document.body).append(pop);
  pop.parentElement.style.position ||= "relative";
  document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", esc, true);
}
const insertAtCursor = (input, text) => {
  const a = input.selectionStart ?? input.value.length, z = input.selectionEnd ?? a;
  input.value = input.value.slice(0, a) + text + input.value.slice(z);
  input.focus(); input.selectionStart = input.selectionEnd = a + text.length;
};

// Put a post on someone for part of the shift only (or take it off). Resolves to { start_at, end_at } (whole shift = both null), { remove: true } or null.
function postRangeDialog(shift, post, current, marks = []) {
  return new Promise((resolve) => {
    let dlg = document.getElementById("post-range-modal");
    if (!dlg) { dlg = h("dialog", { id: "post-range-modal" }); document.body.append(dlg); }
    let done = false; const finish = (v) => { if (done) return; done = true; resolve(v); dlg.close(); };
    const day = dayOf(shift.start_at);
    const iso = (hm) => `${hm >= hhmm(shift.start_at) ? day : addDays(day, 1)}T${hm}`;
    const from = timeField(hhmm(current?.start_at ?? shift.start_at)), to = timeField(hhmm(current?.end_at ?? shift.end_at));
    dlg.replaceChildren(h("form", { class: "modal-body", onSubmit: (e) => { e.preventDefault(); const a = iso(from.value), z = iso(to.value); if (a >= z || a < shift.start_at || z > shift.end_at) { toast(t("postsRangeInvalid")); return; } finish({ start_at: a, end_at: z }); } },
      h("h2", {}, post), h("p", { class: "meta" }, `${shift.first_name || shift.staff_name} · ${hhmm(shift.start_at)}–${hhmm(shift.end_at)}`),
      h("div", { class: "td-times" }, h("label", { class: "field" }, h("span", {}, t("from")), from), h("label", { class: "field" }, h("span", {}, t("to")), to)),
      // times when other people arrive or leave: one tap to hand the post over then
      marks.length ? h("div", { class: "pr-marks" }, marks.flatMap((m) => [
        h("button", { class: "chip-btn", type: "button", onClick: () => { to.value = hhmm(m); } }, `${t("postsUntilMark")} ${hhmm(m)}`),
        h("button", { class: "chip-btn", type: "button", onClick: () => { from.value = hhmm(m); } }, `${t("postsFromMark")} ${hhmm(m)}`)])) : null,
      h("button", { class: "btn", type: "button", onClick: () => finish({ start_at: shift.start_at, end_at: shift.end_at }) }, t("postsWholeShift")),
      h("div", { class: "actions" },
        current ? h("button", { class: "btn danger", type: "button", onClick: () => finish({ remove: true }) }, t("postsRemove")) : null,
        h("button", { class: "btn", type: "button", onClick: () => finish(null) }, t("cancel")),
        h("button", { class: "btn primary", type: "submit" }, t("save")))));
    dlg.addEventListener("close", () => { if (!done) { done = true; resolve(null); } }, { once: true });
    dlg.showModal();
  });
}

// The prep tasks a manager gives to someone on a shift, with the time they are due. The person ticks them in his or her checklist.
async function prepDialog(shift) {
  let dlg = document.getElementById("prep-modal");
  if (!dlg) { dlg = h("dialog", { id: "prep-modal" }); document.body.append(dlg); }
  const day = dayOf(shift.start_at);
  const iso = (hm) => `${hm >= hhmm(shift.start_at) ? day : addDays(day, 1)}T${hm}`;
  const text = h("input", { maxLength: 200, placeholder: t("prepText"), "aria-label": t("prepText") });
  const due = timeField(hhmm(shift.end_at));
  const list = h("div", { class: "prep-list" });
  const load = async () => {
    const rows = await api(`/shifts/${shift.id}/prep`);
    list.replaceChildren(...(rows.length ? rows.map((r) => h("div", { class: `prep-row ${r.done_at ? "done" : ""}` },
      h("span", {}, `${r.done_at ? "✓ " : ""}${r.text}`), h("small", { class: "meta" }, `${t("prepDueBy")} ${hhmm(r.due_at ?? shift.end_at)}`),
      h("button", { class: "icon-btn", type: "button", "aria-label": t("postsRemove"), onClick: async () => { if (!(await ask(t("prepRemoveConfirm")))) return; await api(`/shifts/${shift.id}/prep/${r.id}`, { method: "DELETE" }); load(); } }, "✕"))) : [h("p", { class: "meta" }, t("prepNone"))]));
  };
  await load();
  dlg.replaceChildren(h("form", { class: "modal-body", onSubmit: async (e) => {
      e.preventDefault();
      if (!text.value.trim()) return;
      try { await api(`/shifts/${shift.id}/prep`, { method: "POST", body: { text: text.value.trim(), due_at: iso(due.value) } }); text.value = ""; await load(); } catch (err) { toast(errorText(err)); }
    } },
    h("h2", {}, `📝 ${t("prepTitle")}`), h("p", { class: "meta" }, `${shift.first_name || shift.staff_name} · ${hhmm(shift.start_at)}–${hhmm(shift.end_at)}`), list,
    h("div", { class: "prep-add" }, text, h("label", { class: "field" }, h("span", {}, t("prepDueBy")), due), h("button", { class: "btn primary", type: "submit" }, t("prepAdd"))),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: () => dlg.close() }, t("close")))));
  await new Promise((res) => { dlg.addEventListener("close", res, { once: true }); dlg.showModal(); });
}

// ---------- Postes du jour: put the kitchen posts on the day's shifts ----------
state.postBoard = { restaurant: null, date: ymd(new Date()) };
async function renderPostBoard() {
  const pb = state.postBoard;
  const restos = state.restaurants.filter((r) => state.me.me.is_admin || state.me.managed.some((m) => m.restaurant_id === r.id && m.department_id === "kitchen"));
  if (!restos.some((r) => r.id === pb.restaurant)) pb.restaurant = (restos.find((r) => r.id === state.sel.restaurant) ?? restos[0])?.id ?? null;
  if (!pb.restaurant) { $app.replaceChildren(h("div", { class: "empty" }, t("noSchedules"))); return; }
  const data = await api(`/post-board?restaurant=${pb.restaurant}&date=${pb.date}`);
  const lang = getLang(), nm = (o) => (lang === "en" ? o.name_en : o.name_fr);
  const nowIso = `${ymd(new Date())}T${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;
  const live = (sh) => sh.start_at <= nowIso && sh.end_at >= nowIso;
  // periods of the day (Matin / Après-midi / Soir…): -1 = the whole day. On today's date start with the period we are in.
  const periods = data.periods ?? [];
  if (pb.period === undefined || pb.period >= periods.length) pb.period = periods.findIndex((x) => pb.date === ymd(new Date()) && `${pb.date}T${x.start}` <= nowIso && nowIso < `${pb.date}T${x.end}`);
  const per = () => (pb.period >= 0 ? { a: `${pb.date}T${periods[pb.period].start}`, z: `${pb.date}T${periods[pb.period].end}` } : null);
  const inPeriod = (sh) => { const q = per(); return !q || (sh.start_at < q.z && sh.end_at > q.a); };
  // is this person on the post during the selected period (any part of it)?
  const onIn = (sh, post) => { if (!sh.posts.includes(post.id)) return false; const q = per(), r = sh.ranges?.[post.id]; if (!q) return true; return (r?.start_at ?? sh.start_at) < q.z && (r?.end_at ?? sh.end_at) > q.a; };
  // arrival / departure times of the other shifts that fall inside this one: where a post can be handed over
  const marksOf = (sh) => [...new Set([...data.shifts.filter((x) => x !== sh).flatMap((x) => [x.start_at, x.end_at]), ...periods.flatMap((x) => [`${pb.date}T${x.start}`, `${pb.date}T${x.end}`])].filter((m) => m > sh.start_at && m < sh.end_at))].sort();
  const toggle = async (sh, post, cell) => {
    cell.disabled = true;
    try {
      const marks = marksOf(sh), q = per();
      if (!sh.posts.includes(post.id) && q) {
        // a period is selected: the post is put on the person for that period (within their shift)
        const a = q.a > sh.start_at ? q.a : sh.start_at, z = q.z < sh.end_at ? q.z : sh.end_at;
        await api(`/shifts/${sh.id}/checklist/posts`, { method: "POST", body: { post_id: post.id, start_at: a, end_at: z } });
        sh.posts = [...sh.posts, post.id];
        if (a !== sh.start_at || z !== sh.end_at) sh.ranges = { ...(sh.ranges ?? {}), [post.id]: { start_at: a, end_at: z } };
      } else if (!sh.posts.includes(post.id) && !marks.length) {
        await api(`/shifts/${sh.id}/checklist/posts`, { method: "POST", body: { post_id: post.id } });
        sh.posts = [...sh.posts, post.id];
      } else {
        // set the hours of the post within the shift (offered at once when people arrive or leave during the shift), or take the post off
        const was = sh.posts.includes(post.id);
        const r = await postRangeDialog(sh, nm(post), was ? sh.ranges?.[post.id] ?? { start_at: sh.start_at, end_at: sh.end_at } : null, marks);
        if (!r || (r.remove && !was)) { cell.disabled = false; return; }
        if (r.remove) { await api(`/shifts/${sh.id}/checklist/posts/${post.id}`, { method: "DELETE" }); sh.posts = sh.posts.filter((x) => x !== post.id); delete sh.ranges?.[post.id]; }
        else {
          await api(`/shifts/${sh.id}/checklist/posts`, { method: "POST", body: { post_id: post.id, start_at: r.start_at, end_at: r.end_at } });
          if (!was) sh.posts = [...sh.posts, post.id];
          sh.ranges = { ...(sh.ranges ?? {}) };
          if (r.start_at === sh.start_at && r.end_at === sh.end_at) delete sh.ranges[post.id]; else sh.ranges[post.id] = r;
        }
      }
      paint();
    } catch (e) { toast(errorText(e)); cell.disabled = false; }
  };
  // who is on which post, hour by hour: one row per post, a bar per assigned shift, hatched where nobody is on the post
  const postTimeline = () => {
    const toM = (iso, day) => Math.round((Date.parse(`${iso}:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 60000);
    const hrs = hoursOn(pb.restaurant, pb.date);
    let from = Math.min(toM(`${pb.date}T${hrs.open}`, pb.date), ...data.shifts.map((x) => toM(x.start_at, pb.date)));
    let to = Math.max(toM(`${pb.date}T${hrs.close}`, pb.date), ...data.shifts.map((x) => toM(x.end_at, pb.date)));
    from = Math.floor(from / 60) * 60; to = Math.ceil(to / 60) * 60;
    const pct = (m) => ((m - from) / (to - from)) * 100;
    const open = toM(`${pb.date}T${hrs.open}`, pb.date), close = toM(`${pb.date}T${hrs.close}`, pb.date);
    const hoursAxis = h("div", { class: "pt-axis" }, Array.from({ length: (to - from) / 60 + 1 }, (_, i) => h("span", { style: `left:${pct(from + i * 60)}%` }, `${((from + i * 60) / 60) % 24}h`)));
    const rows = data.posts.map((p) => {
      const mine = data.shifts.filter((x) => x.posts.includes(p.id)).map((x) => { const r = x.ranges?.[p.id]; return { x, a: toM(r?.start_at ?? x.start_at, pb.date), b: toM(r?.end_at ?? x.end_at, pb.date), r }; }).sort((u, v) => u.a - v.a);
      // lanes for people on the same post at the same time
      const laneEnd = [];
      for (const it of mine) { let l = laneEnd.findIndex((e) => e <= it.a); if (l < 0) l = laneEnd.length; laneEnd[l] = it.b; it.lane = l; }
      const lanes = Math.max(1, laneEnd.length);
      // uncovered stretches inside opening hours (breakfast posts: only while someone is assigned, they are not needed all day)
      const gaps = []; if (p.kind !== "breakfast") { let cur = open; for (const it of [...mine].sort((u, v) => u.a - v.a)) { if (it.a > cur) gaps.push([cur, Math.min(it.a, close)]); cur = Math.max(cur, it.b); } if (cur < close) gaps.push([cur, close]); }
      return h("div", { class: "pt-row" }, h("div", { class: "pt-label" }, nm(p)),
        h("div", { class: "pt-track", style: `height:${lanes * 30 + 6}px` },
          ...gaps.filter(([a, b]) => b > a).map(([a, b]) => h("div", { class: "pt-gap", title: `${t("postsNobody")} ${fromMin(((a % 1440) + 1440) % 1440)}–${fromMin(((b % 1440) + 1440) % 1440)}`, style: `left:${pct(a)}%;width:${pct(b) - pct(a)}%` })),
          ...mine.map((it) => { const c = staffColor(it.x.staff_id, it.x.staff_color); return h("div", { class: "pt-bar", title: `${it.x.staff_name} · ${hhmm(it.r?.start_at ?? it.x.start_at)}–${hhmm(it.r?.end_at ?? it.x.end_at)}`, style: `left:${pct(it.a)}%;width:${pct(it.b) - pct(it.a)}%;top:${it.lane * 30 + 3}px;background:${c};color:${textOn(c)}` }, `${it.x.first_name || it.x.staff_name} ${hhmm(it.r?.start_at ?? it.x.start_at)}–${hhmm(it.r?.end_at ?? it.x.end_at)}`); })));
    });
    return h("section", { class: "pt" }, h("h3", {}, t("postsTimeline")), h("div", { class: "pt-scroll" }, h("div", { class: "pt-grid" }, h("div", { class: "pt-row pt-head" }, h("div", { class: "pt-label" }), hoursAxis), ...rows)), h("p", { class: "meta" }, `▨ ${t("postsNobody")}`));
  };
  const prepButton = (sh) => h("button", { type: "button", class: "pb-prep", title: t("prepTitle"), "aria-label": `${t("prepTitle")} · ${sh.first_name || sh.staff_name}`, onClick: async () => { await prepDialog(sh); try { sh.prep = (await api(`/shifts/${sh.id}/prep`)).length; } catch { /* keep */ } paint(); } }, `📝${sh.prep ? ` ${sh.prep}` : ""}`);
  // who arrives / leaves a post at each time someone starts: the posts nobody holds from then on are to be covered
  const handovers = () => {
    const covered = (p, at) => data.shifts.some((x) => x.posts.includes(p.id) && (x.ranges?.[p.id]?.start_at ?? x.start_at) <= at && at < (x.ranges?.[p.id]?.end_at ?? x.end_at));
    const first = data.shifts.reduce((m, x) => (x.start_at < m ? x.start_at : m), "9");
    const times = [...new Set(data.shifts.map((x) => x.start_at))].filter((a) => a > first).sort();
    if (!times.length) return null;
    return h("section", { class: "pb-handover" }, h("h3", {}, t("postsHandover")), h("p", { class: "meta" }, t("postsHandoverHelp")),
      times.map((at) => {
        const arriving = data.shifts.filter((x) => x.start_at === at), leaving = data.posts.filter((p) => data.shifts.some((x) => x.posts.includes(p.id) && (x.ranges?.[p.id]?.end_at ?? x.end_at) === at));
        const open = data.posts.filter((p) => (p.kind !== "breakfast") && !covered(p, at));
        return h("div", { class: `pb-ho ${open.length ? "warn" : "ok"}` }, h("b", {}, hhmm(at)),
          h("span", {}, `${arriving.map((x) => x.first_name || x.staff_name).join(", ")} ${t("postsArrive")}`),
          leaving.length ? h("small", {}, `${leaving.map(nm).join(", ")} : ${t("postsLeave")}`) : null,
          open.length ? h("small", { class: "pb-ho-open" }, `⚠ ${open.map(nm).join(", ")} ${t("postsUncovered")}`) : h("small", {}, "✓"));
      }));
  };
  // the closing task of the day (mop…) and who has it; a manager can give it to someone else who works that day
  const closingBar = () => (data.closing ?? []).map((ct) => {
    const people = [...new Map(data.shifts.map((x) => [x.staff_id, x.first_name || x.staff_name])).entries()];
    const sel = h("select", { "aria-label": t("closingChange"), onChange: async (e) => { try { await api("/closing-assignments", { method: "PUT", body: { restaurant_id: pb.restaurant, date: pb.date, task_id: ct.task_id, staff_id: Number(e.target.value) } }); toast(t("saved")); render(); } catch (err) { toast(errorText(err)); } } },
      people.map(([id, nm2]) => h("option", { value: id, selected: id === ct.staff_id }, nm2)));
    return h("div", { class: "pb-closing" }, h("span", {}, `🧹 ${lang === "en" ? ct.text_en : ct.text_fr}`), ct.staff_id ? h("b", {}, ct.staff_name ?? "") : h("span", { class: "meta" }, t("closingNobody")), people.length ? h("label", { class: "pb-closing-change" }, h("small", {}, t("closingChange")), sel) : null);
  });
  const holder = h("div", {});
  const paint = () => {
    const shown = data.shifts.filter(inPeriod);
    const count = (post) => shown.filter((sh) => onIn(sh, post)).length;
    const row = (sh) => h("tr", { class: live(sh) ? "live" : "" },
      h("th", { class: "pb-who", scope: "row" }, avatar(sh.staff_id, sh.staff_name, sh.staff_color, sh.photo_v, 30), h("span", {}, h("b", {}, sh.first_name || sh.staff_name), h("small", {}, `${hhmm(sh.start_at)}–${sh.until_close ? "F" : hhmm(sh.end_at)}${live(sh) ? ` · ${t("postsNow")}` : ""}`)), prepButton(sh)),
      data.posts.map((p) => {
        const on = onIn(sh, p);
        if (p.kind === "breakfast" && !sh.breakfast && !on) return h("td", {}, h("span", { class: "pb-na", title: t("postsBreakfastClosed") }, "–"));
        const cell = h("button", { type: "button", class: `pb-cell ${on ? "on" : ""}`, "aria-pressed": String(on), title: `${sh.staff_name} · ${nm(p)}`, onClick: () => toggle(sh, p, cell) }, on ? (sh.ranges?.[p.id] ? h("span", { class: "pb-part" }, `${hhmm(sh.ranges[p.id].start_at).replace(/^0/, "").replace(":00", "h")}–${hhmm(sh.ranges[p.id].end_at).replace(/^0/, "").replace(":00", "h")}`) : "✓") : sh.skills.includes(p.id) ? h("span", { class: "pb-skill", title: t("postsSkilled") }, "★") : "");
        return h("td", {}, cell);
      }));
    const table = shown.length ? h("div", { class: "pb-scroll" }, h("table", { class: "pb" },
      h("thead", {}, h("tr", {}, h("th", {}), data.posts.map((p) => h("th", { class: count(p) ? "" : "empty" }, h("span", { class: "pb-post" }, nm(p)), h("small", {}, count(p) ? `${count(p)} ✓` : `⚠ 0`))))),
      h("tbody", {}, shown.map(row)))) : h("div", { class: "empty" }, t("postsNoShifts"));
    // phone: one card per shift with the posts as chips
    const cards = h("div", { class: "pb-cards" }, shown.map((sh) => h("div", { class: `card pb-card ${live(sh) ? "live" : ""}` },
      h("div", { class: "pb-who" }, avatar(sh.staff_id, sh.staff_name, sh.staff_color, sh.photo_v, 34), h("span", {}, h("b", {}, sh.first_name || sh.staff_name), h("small", {}, `${hhmm(sh.start_at)}–${sh.until_close ? "F" : hhmm(sh.end_at)}${live(sh) ? ` · ${t("postsNow")}` : ""}`)), prepButton(sh)),
      h("div", { class: "cl-posts" }, data.posts.filter((p) => p.kind !== "breakfast" || sh.breakfast || sh.posts.includes(p.id)).map((p) => { const on = onIn(sh, p); const b = h("button", { type: "button", class: `chip-btn ${on ? "on" : ""}`, "aria-pressed": String(on), onClick: () => toggle(sh, p, b) }, `${on ? "✓ " : sh.skills.includes(p.id) ? "★ " : ""}${nm(p)}${on && sh.ranges?.[p.id] ? ` ${hhmm(sh.ranges[p.id].start_at)}–${hhmm(sh.ranges[p.id].end_at)}` : ""}`); return b; })))));
    const chips = periods.length ? h("div", { class: "pb-periods", role: "group", "aria-label": t("postsTitle") }, [[-1, t("periodWholeDay")], ...periods.map((x, i) => [i, `${lang === "en" ? x.en : x.fr} ${x.start.replace(/^0/, "").replace(":00", "h")}–${x.end.replace(/^0/, "").replace(":00", "h")}`])].map(([i, label]) =>
      h("button", { type: "button", class: `chip-btn ${pb.period === i ? "on" : ""}`, "aria-pressed": String(pb.period === i), onClick: () => { pb.period = i; paint(); } }, label))) : null;
    holder.replaceChildren(chips, ...closingBar(), table, ...(data.shifts.length ? [cards] : []), data.shifts.length ? h("p", { class: "meta" }, `★ ${t("postsSkilled")} · ${t("postsHelp")}`) : null, data.shifts.length ? handovers() : null, data.shifts.length ? postTimeline() : null);
  };
  const dayNav = h("div", { class: "weeknav" },
    h("button", { class: "icon-btn", type: "button", "aria-label": t("prevDay"), onClick: () => { pb.date = addDays(pb.date, -1); render(); } }, "‹"),
    h("div", { class: "label" }, fmt(pb.date, { weekday: "long", day: "numeric", month: "long" })),
    h("button", { class: "icon-btn", type: "button", "aria-label": t("nextDay"), onClick: () => { pb.date = addDays(pb.date, 1); render(); } }, "›"),
    h("button", { class: "btn", type: "button", onClick: () => { pb.date = ymd(new Date()); render(); } }, t("today")));
  paint();
  $app.replaceChildren(h("div", { class: "account postboard" }, h("h2", {}, t("postsTitle")), h("p", { class: "meta" }, t("postsIntro")),
    restos.length > 1 ? h("div", { class: "field", style: "max-width:320px" }, h("span", {}, t("restaurant")), restaurantSelect({ list: restos, value: pb.restaurant, onChange: (id) => { pb.restaurant = id; render(); } })) : null,
    dayNav, holder));
}

// "I could not complete this task": why, and which ingredients are missing. Resolves to { reason, note }, { remove: true } or null.
function issueDialog(taskText, current) {
  return new Promise((resolve) => {
    let dlg = document.getElementById("issue-modal");
    if (!dlg) { dlg = h("dialog", { id: "issue-modal" }); document.body.append(dlg); }
    let done = false; const finish = (v) => { if (done) return; done = true; resolve(v); dlg.close(); };
    let reason = current?.reason ?? "missing_ingredient";
    const note = h("input", { maxLength: 200, value: current?.note ?? "", required: true, autocomplete: "off" });
    const label = h("span", {});
    const sync = () => { label.textContent = reason === "missing_ingredient" ? t("checklistWhichIng") : t("checklistWhy"); note.placeholder = reason === "missing_ingredient" ? t("checklistIngExample") : ""; };
    const radios = [["missing_ingredient", t("checklistMissingIng")], ["other", t("checklistOtherReason")]].map(([v, l]) =>
      h("label", { class: "reason" }, h("input", { type: "radio", name: "issue-reason", value: v, checked: v === reason, onChange: () => { reason = v; sync(); } }), h("span", {}, l)));
    sync();
    dlg.replaceChildren(h("form", { class: "modal-body", onSubmit: (e) => { e.preventDefault(); if (note.value.trim()) finish({ reason, note: note.value.trim() }); } },
      h("h2", {}, t("checklistCannot")), h("p", { class: "meta" }, taskText),
      h("div", { class: "reason-list", role: "radiogroup" }, radios),
      h("label", { class: "field" }, label, note),
      h("div", { class: "actions" },
        current ? h("button", { class: "btn danger", type: "button", onClick: () => finish({ remove: true }) }, t("checklistRemoveIssue")) : null,
        h("button", { class: "btn", type: "button", onClick: () => finish(null) }, t("cancel")),
        h("button", { class: "btn primary", type: "submit" }, t("save")))));
    dlg.addEventListener("close", () => { if (!done) { done = true; resolve(null); } }, { once: true });
    dlg.showModal(); note.focus();
  });
}

// ---------- End-of-shift checklist ----------
// The tab exists while the person is on a shift (and up to an hour after it) and their lists are not all ticked.
const INGREDIENT_CATEGORIES = [["pasta", "catPasta"], ["meats", "catMeats"], ["vegetables", "catVegetables"], ["fruits", "catFruits"], ["dairy", "catDairy"], ["sauces", "catSauces"], ["cheeses", "catCheeses"], ["breads", "catBreads"], ["pizza_dough", "catPizzaDough"], ["salads", "catSalads"], ["mixes", "catMixes"], ["boxes", "catBoxes"], ["seafood", "catSeafood"], ["beers", "catBeers"], ["wines", "catWines"], ["spirits", "catSpirits"]];
// "5 kg Oignons": a component with its quantity when one is given
const compText = (item) => (item.components ?? []).map((c) => { const q = item.component_qty?.[c]; return q?.qty ? `${q.qty} ${q.unit ?? ""} ${c}`.replace(/\s+/g, " ").trim() : c; });
const portionText = (e) => [e.portion_qty && e.portion_unit ? `${Math.round(e.portion_qty * 100) / 100} ${e.portion_unit}` : null, e.portion_g ? `${Math.round(e.portion_g * 10) / 10} g / ${Math.round((e.portion_g / 28.3495) * 10) / 10} oz` : null].filter(Boolean).join(" · ");
// Alphabetical order, with each home-made ingredient right under the ingredient it is made from (indented one level more).
function ingredientTree(list) {
  const key = (e) => e.name.trim().toLowerCase(), cmp = (a, b) => a.name.localeCompare(b.name, getLang());
  const byName = new Map(list.map((e) => [key(e), e]));
  const parentOf = (e) => (e.homemade ? (e.components ?? []).map((c) => byName.get(c.trim().toLowerCase())).find((p) => p && p !== e) : null);
  const kids = new Map();
  const tops = [];
  for (const e of list) { const p = parentOf(e); if (p) kids.set(p, [...(kids.get(p) ?? []), e]); else tops.push(e); }
  const out = [], seen = new Set();
  const walk = (e, depth) => { if (seen.has(e)) return; seen.add(e); out.push({ item: e, depth }); for (const k of (kids.get(e) ?? []).sort(cmp)) walk(k, depth + 1); };
  for (const e of tops.sort(cmp)) walk(e, 0);
  for (const e of list) walk(e, 0); // a loop of home-made ingredients (A from B, B from A): nothing is lost
  return out;
}
// the categories in alphabetical order of their names (for the drop-down lists)
const categoriesAlpha = () => [...INGREDIENT_CATEGORIES].sort((a, b) => t(a[1]).localeCompare(t(b[1]), getLang()));
const LOCATION_INFO = { fridge: ["🧊", "locFridge"], freezer: ["❄️", "locFreezer"], backstore: ["📦", "locBackstore"], basement: ["🪜", "locBasement"], cellar: ["🍷", "locCellar"] };
async function renderChecklist() {
  const { test, shifts, restock, vehicle_restaurants: vehicleIds = [] } = await api("/my-checklist");
  state.restock = restock;
  const hasEnd = shifts.length > 0 || (test && state.me.me.is_admin);
  let sub = state.listsSub ?? (hasEnd ? "end" : "restock");
  if ((sub === "restock" || sub === "prep" || sub === "orders" || sub === "inventory") && !restock.length) sub = "end";
  if (sub === "vehicles" && !vehicleIds.length) sub = "end";
  const box = h("div", { class: "account checklist-view" }, h("h2", {}, t("listsTab")));
  $app.replaceChildren(box);
  // on a phone the tabs are icons only, so all of them show on the screen (the name stays as tooltip and for screen readers)
  if (restock.length || vehicleIds.length) box.append(h("div", { class: "subtabs lists-tabs", role: "tablist" }, [["end", t("listsEndOfShift"), "✅"], ...(restock.length ? [["restock", t("listsRestock"), "📦"], ["prep", t("listsPrep"), "🥣"], ["orders", t("listsOrders"), "🛒"], ["inventory", t("listsInventory"), "🧮"]] : []), ...(vehicleIds.length ? [["vehicles", t("vehTab"), "🚗"]] : [])].map(([id, label, icon]) =>
    h("button", { type: "button", role: "tab", title: label, "aria-label": label, "aria-selected": String(sub === id), onClick: () => { state.listsSub = id; render(); } }, h("span", { class: "tab-ic", "aria-hidden": "true" }, icon), h("span", { class: "tab-tx" }, label)))));
  if (sub === "vehicles") { await renderVehicles(box, vehicleIds); return; }
  if (sub === "orders") { await renderOrders(box, restock); return; }
  if (sub === "inventory") { await renderInventory(box, restock); return; }
  if (sub === "restock" || sub === "prep") { await renderRestock(box, restock, sub); return; }
  if (test) box.append(h("div", { class: "info test-banner", role: "status" }, `🧪 ${t("checklistTestBanner")}`));
  if (!shifts.length) {
    // Opened on purpose from the sub-tabs: say why there is nothing to fill in, instead of jumping to another list.
    box.append(h("div", { class: "info", role: "status" }, t("checklistNoneNow")), state.me.me.is_admin ? h("p", { class: "meta" }, t(test ? "checklistTestNoShift" : "checklistAdminHint")) : null);
    return;
  }
  for (const sh of shifts) box.append(await checklistCard(sh.id, sh, test));
}
// ---------- Delivery vehicles: tires, problems, reminders ----------
const VEH_CATS = ["tires", "brakes", "engine", "lights", "body", "cleanliness", "other"];
const vehDate = (ymd) => { const x = new Date(`${ymd}T12:00:00Z`).toLocaleDateString(locale(), { day: "numeric", month: "long", timeZone: "UTC" }); return getLang() === "fr" ? x.replace(/^1 /, "1er ") : x; };
const vehName = (v) => (v.plate ? `${v.name} · ${v.plate}` : v.name);

/** A driver reports a problem with a vehicle: which one, what kind, how serious, what is wrong. */
async function vehicleIssueDialog({ restaurantId, vehicleId, onSaved }) {
  let d;
  try { d = await api(`/vehicles?restaurant=${restaurantId}`); } catch (e) { toast(errorText(e)); return; }
  const list = d.vehicles.filter((v) => v.active);
  if (!list.length) { toast(t("vehNoneToReport")); return; }
  const dlg = h("dialog", { class: "modal veh-dialog" });
  const vehicle = h("select", { required: true, "aria-label": t("vehVehicle") }, list.map((v) => h("option", { value: v.id, selected: v.id === vehicleId }, vehName(v))));
  const category = h("select", { required: true, "aria-label": t("vehCategory") }, VEH_CATS.map((c) => h("option", { value: c }, t(`vehCat_${c}`))));
  const severity = radioGroup("veh-sev", [["normal", t("vehSevNormal")], ["urgent", t("vehSevUrgent")]], "normal");
  const text = h("textarea", { rows: 4, maxLength: 1000, required: true, minLength: 3, placeholder: t("vehDescribe"), "aria-label": t("vehDescribe") });
  const done = () => { dlg.close(); dlg.remove(); };
  dlg.append(h("form", { class: "modal-body", onSubmit: async (e) => {
    e.preventDefault();
    try { await api(`/vehicles/${vehicle.value}/issues`, { method: "POST", body: { severity: severity.value, category: category.value, description: text.value } }); toast(t("vehReported")); done(); onSaved?.(); }
    catch (err) { toast(err.body?.error === "too_many_requests" ? t("loginTooMany") : errorText(err)); }
  } }, h("h2", {}, `🚗 ${t("vehReport")}`),
    h("label", { class: "field" }, h("span", {}, t("vehVehicle")), vehicle), h("label", { class: "field" }, h("span", {}, t("vehCategory")), category),
    h("div", { class: "field" }, h("span", {}, t("vehSeverity")), severity, h("span", { class: "meta" }, t("vehSevHelp"))), h("label", { class: "field" }, h("span", {}, t("vehDescribe")), text),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: done }, t("cancel")), h("button", { class: "btn primary", type: "submit" }, t("vehSend")))));
  dlg.addEventListener("close", () => dlg.remove(), { once: true });
  document.body.append(dlg); dlg.showModal(); text.focus();
}

async function renderVehicles(box, restaurantIds) {
  if (!restaurantIds.includes(state.vehicleRestaurant)) state.vehicleRestaurant = restaurantIds.includes(state.sel?.restaurant) ? state.sel.restaurant : restaurantIds[0];
  const reload = () => renderChecklist();
  const d = await api(`/vehicles?restaurant=${state.vehicleRestaurant}`);
  const fmtTime = (ms) => new Date(ms).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const picker = d.restaurants.length > 1 ? h("label", { class: "field veh-resto" }, h("span", {}, t("restaurant")), h("select", { "aria-label": t("restaurant"), onChange: (e) => { state.vehicleRestaurant = Number(e.target.value); reload(); } }, d.restaurants.map((r) => h("option", { value: r.id, selected: r.id === d.restaurant_id }, r.name)))) : null;
  // the next tire deadline, in words
  const sn = d.season, winter = sn.target === "winter";
  const urgentSoon = sn.in_window && sn.days_left <= 14 && sn.pending > 0;
  const banner = h("div", { class: `info veh-season ${urgentSoon ? "soon" : ""}`, role: "status" },
    h("b", {}, winter ? `❄️ ${t("vehFallTitle")}` : `☀️ ${t("vehSpringTitle")}`), " ",
    sn.in_window ? (winter ? t("vehFallLine") : t("vehSpringLine")).replace("{date}", vehDate(sn.deadline)).replace("{n}", String(Math.max(0, sn.days_left))) : t("vehSpringWait").replace("{date}", vehDate(sn.opens)),
    sn.in_window && sn.pending ? h("div", {}, `⚠ ${sn.pending} ${t("vehToChange")}`) : null, h("div", { class: "meta" }, winter ? t("vehLawWinter") : t("vehLawSpring")));
  const issueRow = (i, canManage) => h("div", { class: `veh-issue ${i.severity} ${i.status}` },
    h("div", {}, h("span", { class: "badge" }, i.severity === "urgent" ? `🚨 ${t("vehSevUrgentShort")}` : t("vehSevNormalShort")), " ", h("b", {}, t(`vehCat_${i.category}`)), " · ", h("span", { class: "meta" }, `${i.by} · ${fmtTime(i.created_at)}`), " · ", h("span", { class: "badge" }, t(`vehSt_${i.status}`))),
    h("p", { class: "veh-desc" }, i.description), i.resolution_note ? h("p", { class: "meta" }, `${t("vehNote")} : ${i.resolution_note}`) : null,
    canManage && i.status !== "resolved" ? h("div", { class: "actions" },
      i.status === "open" ? h("button", { class: "btn sm", type: "button", onClick: async () => { try { await api(`/vehicle-issues/${i.id}`, { method: "PUT", body: { status: "in_progress" } }); reload(); } catch (e) { toast(errorText(e)); } } }, t("vehStart")) : null,
      h("button", { class: "btn sm primary", type: "button", onClick: async () => { const note = await promptDialog({ title: t("vehResolve"), label: t("vehNoteOptional") }); if (note === null) return; try { await api(`/vehicle-issues/${i.id}`, { method: "PUT", body: { status: "resolved", note } }); reload(); } catch (e) { toast(errorText(e)); } } }, `✓ ${t("vehResolve")}`)) : null);
  const card = (v) => {
    const open = v.issues.filter((i) => i.status !== "resolved"), closed = v.issues.filter((i) => i.status === "resolved");
    const out = open.some((i) => i.severity === "urgent");
    const toTires = v.tires === "winter" ? "summer" : "winter";
    return h("section", { class: `card veh-card ${out ? "out" : ""} ${v.active ? "" : "inactive"}` },
      h("div", { class: "veh-head" }, h("h3", {}, `🚗 ${vehName(v)}`), h("span", { class: `badge tires-${v.tires}` }, v.tires === "winter" ? `❄️ ${t("vehWinter")}` : `☀️ ${t("vehSummer")}`), out ? h("span", { class: "badge veh-out" }, `🚨 ${t("vehOut")}`) : null, v.active ? null : h("span", { class: "badge" }, t("inactive"))),
      v.notes ? h("p", { class: "meta" }, v.notes) : null,
      h("p", { class: "meta" }, v.tires_changed_on ? `${t("vehTiresChanged")} ${vehDate(v.tires_changed_on)}` : t("vehTiresUnknown")),
      open.length ? h("div", { class: "veh-issues" }, open.map((i) => issueRow(i, d.can_manage))) : h("p", { class: "meta" }, `✓ ${t("vehNoIssue")}`),
      h("div", { class: "actions" },
        v.active ? h("button", { class: "btn", type: "button", onClick: () => vehicleIssueDialog({ restaurantId: d.restaurant_id, vehicleId: v.id, onSaved: reload }) }, `⚠ ${t("vehReport")}`) : null,
        d.can_manage && v.active ? h("button", { class: `btn ${v.tires !== sn.target ? "primary" : ""}`, type: "button", onClick: async () => { if (await ask(t(toTires === "winter" ? "vehConfirmWinter" : "vehConfirmSummer").replace("{v}", vehName(v)))) { try { await api(`/vehicles/${v.id}/tires`, { method: "POST", body: { to: toTires } }); reload(); } catch (e) { toast(errorText(e)); } } } }, `🔧 ${t(toTires === "winter" ? "vehToWinter" : "vehToSummer")}`) : null,
        d.can_manage ? h("button", { class: "btn", type: "button", onClick: () => vehicleEditDialog(d, v, reload) }, t("edit")) : null),
      closed.length ? h("details", { class: "veh-closed" }, h("summary", {}, `${t("vehHistory")} (${closed.length})`), closed.map((i) => issueRow(i, false))) : null);
  };
  box.append(
    h("h3", {}, `🚗 ${t("vehTab")}`), picker, banner,
    h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onClick: () => vehicleIssueDialog({ restaurantId: d.restaurant_id, onSaved: reload }) }, `⚠ ${t("vehReport")}`),
      d.can_manage ? h("button", { class: "btn", type: "button", onClick: () => vehicleEditDialog(d, null, reload) }, `＋ ${t("vehAdd")}`) : null),
    ...(d.vehicles.length ? d.vehicles.map(card) : [h("div", { class: "empty" }, d.can_manage ? t("vehNoneManage") : t("vehNone"))]),
    d.can_configure ? h("p", { class: "meta" }, `⚙ ${t("vehAdminHint")}`) : null);
}

function vehicleEditDialog(d, v, reload) {
  const dlg = h("dialog", { class: "modal veh-dialog" });
  const name = h("input", { required: true, maxLength: 80, value: v?.name ?? "", placeholder: "Toyota Corolla 2019", "aria-label": t("vehName") });
  const plate = h("input", { maxLength: 20, value: v?.plate ?? "", placeholder: "ABC 123", "aria-label": t("vehPlate") });
  const notes = h("input", { maxLength: 300, value: v?.notes ?? "", "aria-label": t("vehNotes") });
  const restoPick = !v && d.restaurants?.length > 1 ? h("select", { "aria-label": t("restaurant") }, d.restaurants.map((r) => h("option", { value: r.id, selected: r.id === d.restaurant_id }, r.name))) : null;
  const month = new Date().getMonth() + 1;
  const tires = radioGroup("veh-tires", [["summer", `☀️ ${t("vehSummer")}`], ["winter", `❄️ ${t("vehWinter")}`]], v?.tires ?? (month >= 11 || month <= 3 ? "winter" : "summer"));
  const active = h("input", { type: "checkbox", checked: v ? v.active : true });
  const done = () => { dlg.close(); dlg.remove(); };
  dlg.append(h("form", { class: "modal-body", onSubmit: async (e) => {
    e.preventDefault();
    try {
      if (v) await api(`/vehicles/${v.id}`, { method: "PUT", body: { name: name.value, plate: plate.value, notes: notes.value, active: active.checked } });
      else await api("/vehicles", { method: "POST", body: { restaurant_id: restoPick ? Number(restoPick.value) : d.restaurant_id, name: name.value, plate: plate.value, notes: notes.value, tires: tires.value } });
      done(); reload();
    } catch (err) { toast(errorText(err)); }
  } }, h("h2", {}, v ? t("vehEdit") : t("vehAdd")),
    restoPick ? h("label", { class: "field" }, h("span", {}, t("restaurant")), restoPick) : null,
    h("label", { class: "field" }, h("span", {}, t("vehName")), name), h("label", { class: "field" }, h("span", {}, t("vehPlate")), plate), h("label", { class: "field" }, h("span", {}, t("vehNotes")), notes),
    v ? h("label", { class: "check" }, active, h("span", {}, t("vehActive"))) : h("div", { class: "field" }, h("span", {}, t("vehTiresNow")), tires),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: done }, t("cancel")), h("button", { class: "btn primary", type: "submit" }, t("save")))));
  dlg.addEventListener("close", () => dlg.remove(), { once: true });
  document.body.append(dlg); dlg.showModal(); name.focus();
}

/** Administration → Véhicules: all the tasks and problems of every vehicle, and its whole history, in one place. */
function vehiclesAdminPanel() {
  const box = h("section", { class: "panel veh-admin" });
  const st = { restaurant: "all", filter: "all" };
  const fmtDay = (ms) => new Date(ms).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" });
  async function load() {
    const d = await api("/admin/vehicles");
    const reload = () => load().catch((e) => box.replaceChildren(h("p", { class: "meta" }, errorText(e))));
    const open = (v) => v.issues.filter((i) => i.status !== "resolved");
    const all = d.vehicles.filter((v) => st.restaurant === "all" || String(v.restaurant_id) === st.restaurant);
    const shown = all.filter((v) => st.filter === "all" || (st.filter === "issues" ? open(v).length > 0 : v.tasks.length > 0));
    const nIssues = all.reduce((n, v) => n + open(v).length, 0), nTires = all.filter((v) => v.tasks.length).length;
    const sn = d.season, winter = sn.target === "winter";
    const restoSel = h("select", { "aria-label": t("restaurant"), onChange: (e) => { st.restaurant = e.target.value; reload(); } }, [h("option", { value: "all" }, t("vehAllRestaurants")), ...d.restaurants.map((r) => h("option", { value: r.id, selected: String(r.id) === st.restaurant }, r.name))]);
    restoSel.value = st.restaurant;
    const chip = (id, label) => h("button", { type: "button", class: `chip-btn ${st.filter === id ? "on" : ""}`, "aria-pressed": String(st.filter === id), onClick: () => { st.filter = id; reload(); } }, label);
    const issueLine = (i, manage) => h("div", { class: `veh-issue ${i.severity} ${i.status}` },
      h("div", {}, h("span", { class: "badge" }, i.severity === "urgent" ? `🚨 ${t("vehSevUrgentShort")}` : t("vehSevNormalShort")), " ", h("b", {}, t(`vehCat_${i.category}`)), " · ", h("span", { class: "meta" }, `${i.by} · ${fmtDay(i.created_at)}`), " · ", h("span", { class: "badge" }, t(`vehSt_${i.status}`))),
      h("p", { class: "veh-desc" }, i.description),
      manage ? h("div", { class: "actions" },
        i.status === "open" ? h("button", { class: "btn sm", type: "button", onClick: async () => { try { await api(`/vehicle-issues/${i.id}`, { method: "PUT", body: { status: "in_progress" } }); reload(); } catch (e) { toast(errorText(e)); } } }, t("vehStart")) : null,
        h("button", { class: "btn sm primary", type: "button", onClick: async () => { const note = await promptDialog({ title: t("vehResolve"), label: t("vehNoteOptional") }); if (note === null) return; try { await api(`/vehicle-issues/${i.id}`, { method: "PUT", body: { status: "resolved", note } }); reload(); } catch (e) { toast(errorText(e)); } } }, `✓ ${t("vehResolve")}`)) : null);
    // the history of a vehicle: problems reported, fixes, tire changes, newest first
    const events = (v) => [
      ...v.issues.map((i) => ({ at: i.created_at, icon: i.severity === "urgent" ? "🚨" : "⚠", title: `${t("vehEvIssue")} : ${t(`vehCat_${i.category}`)}`, text: i.description, who: i.by })),
      ...v.issues.filter((i) => i.resolved_at).map((i) => ({ at: i.resolved_at, icon: "✓", title: `${t("vehEvFixed")} : ${t(`vehCat_${i.category}`)}`, text: i.resolution_note || "", who: i.resolved_by })),
      ...v.tire_changes.map((c) => ({ at: c.created_at, icon: c.to_tires === "winter" ? "❄️" : "☀️", title: t(c.to_tires === "winter" ? "vehEvWinter" : "vehEvSummer"), text: c.note || "", who: c.by, day: c.changed_on })),
    ].sort((a, b) => b.at - a.at);
    const card = (v) => {
      const o = open(v), out = o.some((i) => i.severity === "urgent"), toTires = v.tires === "winter" ? "summer" : "winter";
      const todo = [
        ...v.tasks.map((k) => h("div", { class: `veh-task ${k.in_window && k.days_left <= 14 ? "soon" : ""}` }, h("span", {}, `🔧 ${(k.target === "winter" ? t("vehTaskWinter") : t("vehTaskSummer")).replace("{date}", vehDate(k.deadline)).replace("{n}", String(Math.max(0, k.days_left)))}`),
          k.in_window ? h("button", { class: "btn sm primary", type: "button", onClick: async () => { if (await ask(t(k.target === "winter" ? "vehConfirmWinter" : "vehConfirmSummer").replace("{v}", vehName(v)))) { try { await api(`/vehicles/${v.id}/tires`, { method: "POST", body: { to: k.target } }); reload(); } catch (e) { toast(errorText(e)); } } } }, `🔧 ${t(k.target === "winter" ? "vehToWinter" : "vehToSummer")}`) : h("span", { class: "meta" }, t("vehSpringWait").replace("{date}", vehDate(k.opens))))),
        ...o.map((i) => issueLine(i, true))];
      const ev = events(v);
      return h("details", { class: `card veh-card ${out ? "out" : ""} ${v.active ? "" : "inactive"}`, open: todo.length > 0 },
        h("summary", { class: "veh-sum" }, h("b", {}, `🚗 ${vehName(v)}`), h("span", { class: "meta" }, ` · ${v.restaurant}`), " ",
          h("span", { class: `badge tires-${v.tires}` }, v.tires === "winter" ? `❄️ ${t("vehWinter")}` : `☀️ ${t("vehSummer")}`),
          out ? h("span", { class: "badge veh-out" }, `🚨 ${t("vehOut")}`) : null, o.length ? h("span", { class: "badge" }, `⚠ ${o.length}`) : null, v.tasks.length ? h("span", { class: "badge" }, `🔧 ${t("vehTireTask")}`) : null, v.active ? null : h("span", { class: "badge" }, t("inactive"))),
        v.notes ? h("p", { class: "meta" }, v.notes) : null, h("p", { class: "meta" }, v.tires_changed_on ? `${t("vehTiresChanged")} ${vehDate(v.tires_changed_on)}` : t("vehTiresUnknown")),
        h("h4", {}, t("vehTodo")), todo.length ? h("div", { class: "veh-todo" }, todo) : h("p", { class: "meta" }, `✓ ${t("vehNothingTodo")}`),
        h("div", { class: "actions" },
          v.active ? h("button", { class: "btn", type: "button", onClick: () => vehicleIssueDialog({ restaurantId: v.restaurant_id, vehicleId: v.id, onSaved: reload }) }, `⚠ ${t("vehReport")}`) : null,
          v.active ? h("button", { class: "btn", type: "button", onClick: async () => { if (await ask(t(toTires === "winter" ? "vehConfirmWinter" : "vehConfirmSummer").replace("{v}", vehName(v)))) { try { await api(`/vehicles/${v.id}/tires`, { method: "POST", body: { to: toTires } }); reload(); } catch (e) { toast(errorText(e)); } } } }, `🔧 ${t(toTires === "winter" ? "vehToWinter" : "vehToSummer")}`) : null,
          h("button", { class: "btn", type: "button", onClick: () => vehicleEditDialog({ restaurant_id: v.restaurant_id, restaurants: d.restaurants }, v, reload) }, t("edit"))),
        h("h4", {}, `${t("vehHistoryTitle")} (${ev.length})`),
        ev.length ? h("ol", { class: "veh-history" }, ev.map((e) => h("li", {}, h("span", { class: "veh-ev-ic", "aria-hidden": "true" }, e.icon), h("div", {}, h("b", {}, e.title), e.text ? h("div", { class: "veh-desc" }, e.text) : null, h("div", { class: "meta" }, `${e.who ?? ""} · ${e.day ? vehDate(e.day) : fmtDay(e.at)}`))))) : h("p", { class: "meta" }, t("vehNoHistory")));
    };
    box.replaceChildren(h("h2", {}, `🚗 ${t("adminVehicles")}`), h("p", { class: "meta" }, t("vehAdminHelp")),
      h("div", { class: `info veh-season ${sn.in_window && sn.days_left <= 14 && nTires ? "soon" : ""}`, role: "status" }, h("b", {}, winter ? `❄️ ${t("vehFallTitle")}` : `☀️ ${t("vehSpringTitle")}`), " ",
        sn.in_window ? (winter ? t("vehFallLine") : t("vehSpringLine")).replace("{date}", vehDate(sn.deadline)).replace("{n}", String(Math.max(0, sn.days_left))) : t("vehSpringWait").replace("{date}", vehDate(sn.opens)), h("div", { class: "meta" }, winter ? t("vehLawWinter") : t("vehLawSpring"))),
      h("div", { class: "veh-toolbar" }, restoSel, chip("all", `${t("vehFilterAll")} (${all.length})`), chip("issues", `⚠ ${t("vehFilterIssues")} (${nIssues})`), chip("tires", `🔧 ${t("vehFilterTires")} (${nTires})`),
        h("button", { class: "btn primary", type: "button", onClick: () => vehicleEditDialog({ restaurant_id: st.restaurant === "all" ? d.restaurants[0]?.id : Number(st.restaurant), restaurants: st.restaurant === "all" ? d.restaurants : [] }, null, reload) }, `＋ ${t("vehAdd")}`)),
      ...(shown.length ? shown.map(card) : [h("div", { class: "empty" }, d.vehicles.length ? t("vehNoMatch") : t("vehNoneManage"))]),
      vehicleSettingsPanel());
  }
  load().catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}

/** Administrators: the legal dates and the reminders for the tire changes. */
function vehicleSettingsPanel() {
  const box = h("details", { class: "veh-settings" }, h("summary", {}, `⚙ ${t("vehSettings")}`), h("p", { class: "meta" }, t("loading")));
  let loaded = false;
  box.addEventListener("toggle", async () => {
    if (!box.open || loaded) return; loaded = true;
    try {
      const d = await api("/admin/vehicle-settings"); const s = d.settings;
      const md = (v) => { const i = h("input", { type: "text", pattern: "(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])", value: v, maxLength: 5, placeholder: "MM-JJ", style: "max-width:6rem", required: true }); return i; };
      const enabled = h("input", { type: "checkbox", checked: s.enabled });
      const fall = md(s.fall_deadline), springStart = md(s.spring_start), springEnd = md(s.spring_deadline);
      const offsets = [45, 30, 21, 14, 7, 3, 1, 0].map((n) => [n, h("input", { type: "checkbox", checked: s.offsets.includes(n), "aria-label": String(n) })]);
      const hourSel = h("select", { "aria-label": t("autoRemindHour") }, Array.from({ length: 24 }, (_, i) => h("option", { value: i, selected: i === s.hour }, getLang() === "en" ? `${i % 12 || 12} ${i < 12 ? "AM" : "PM"}` : `${i} h`)));
      const email = h("input", { type: "checkbox", checked: s.email }), sms = h("input", { type: "checkbox", checked: s.sms });
      const same = h("input", { type: "checkbox", checked: s.recipients === null });
      const picks = d.candidates.map((p) => [p, h("input", { type: "checkbox", checked: d.recipients_now.includes(p.id), disabled: s.recipients === null, "aria-label": p.name })]);
      same.addEventListener("change", () => picks.forEach(([, cb]) => { cb.disabled = same.checked; }));
      box.replaceChildren(h("summary", {}, `⚙ ${t("vehSettings")}`), h("p", { class: "meta" }, t("vehSettingsHelp")),
        h("form", { class: "acc-form", onSubmit: async (e) => {
          e.preventDefault();
          try {
            await api("/admin/vehicle-settings", { method: "PUT", body: { enabled: enabled.checked, fall_deadline: fall.value, spring_start: springStart.value, spring_deadline: springEnd.value, offsets: offsets.filter(([, cb]) => cb.checked).map(([n]) => n), hour: Number(hourSel.value), recipients: same.checked ? null : picks.filter(([, cb]) => cb.checked).map(([p]) => p.id), email: email.checked, sms: sms.checked } });
            toast(t("saved"));
          } catch (err) { toast(err.body?.field === "spring_dates" ? t("vehSpringDatesBad") : errorText(err)); }
        } },
          h("label", { class: "check" }, enabled, h("span", {}, t("vehRemindersOn"))),
          h("div", { class: "form-row r3" }, h("label", { class: "field" }, h("span", {}, t("vehFallDeadline")), fall), h("label", { class: "field" }, h("span", {}, t("vehSpringStart")), springStart), h("label", { class: "field" }, h("span", {}, t("vehSpringDeadline")), springEnd)),
          h("div", { class: "field" }, h("span", {}, t("vehOffsets")), h("div", { class: "auto-days" }, offsets.map(([n, cb]) => h("label", { class: "check" }, cb, h("span", {}, n === 0 ? t("vehOnTheDay") : `${n} ${t("autoDayShort")}`))))),
          h("div", { class: "form-row r2" }, h("label", { class: "field" }, h("span", {}, t("autoRemindHour")), hourSel), h("div", { class: "field" }, h("span", {}, t("autoNoticeBy")), h("label", { class: "check" }, email, h("span", {}, t("autoNoticeEmail"))), h("label", { class: "check" }, sms, h("span", {}, t("autoNoticeSms"))))),
          h("div", { class: "field" }, h("span", {}, t("autoRecipients")), h("label", { class: "check" }, same, h("span", {}, t("vehRecipientsDefault"))),
            h("div", { class: "auto-people" }, picks.map(([p, cb]) => h("label", { class: "check auto-person" }, cb, h("span", {}, p.name, " ", h("small", { class: "meta" }, `${p.is_admin ? t("autoAdminTag") : t("autoManagerTag")} · ${p.email ?? t("autoNoEmail")} · ${p.phone ?? t("autoNoPhone")}`)))))),
          h("button", { class: "btn primary", type: "submit" }, t("save"))));
    } catch (e) { loaded = false; box.replaceChildren(h("summary", {}, `⚙ ${t("vehSettings")}`), h("p", { class: "meta" }, errorText(e))); }
  });
  return box;
}

// Stock taking: count what is in each place (fridge, freezer, back store...); the count is saved as you type and kept in the history.
async function renderInventory(box, restaurantIds) {
  const restos = state.restaurants.filter((r) => restaurantIds.includes(r.id));
  if (!restos.some((r) => r.id === state.restockRestaurant)) state.restockRestaurant = (restos.find((r) => r.id === state.sel.restaurant) ?? restos[0])?.id ?? null;
  const rid = state.restockRestaurant;
  if (!rid) { box.append(h("div", { class: "empty" }, t("noSchedules"))); return; }
  const d = await api(`/inventory?restaurant=${rid}`);
  const stamp = (ts) => new Date(ts).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short", hourCycle: "h23" });
  const fmt = (l) => (l ? `${l.qty}${l.unit ? ` ${l.unit}` : ""}` : "");
  const head = [h("p", { class: "meta" }, t("invHelp")),
    restos.length > 1 ? h("div", { class: "field", style: "max-width:320px" }, h("span", {}, t("restaurant")), restaurantSelect({ list: restos, value: rid, onChange: (id) => { state.restockRestaurant = id; state.invLoc = null; render(); } })) : null];
  const hist = d.history.length ? [h("h3", { class: "restock-title" }, t("invHistory")), ...d.history.map((n) => {
    const body = h("div", { class: "inv-detail" });
    return h("details", { class: "card inv-hist", onToggle: async (e) => {
      if (!e.currentTarget.open || body.dataset.loaded) return; body.dataset.loaded = "1";
      try {
        const x = await api(`/inventory/${n.id}`);
        body.replaceChildren(...(x.note ? [h("p", { class: "meta" }, x.note)] : []), ...x.lines.map((l) => h("div", { class: "inv-hrow" }, h("span", {}, `${LOCATION_INFO[l.location]?.[0] ?? ""} ${l.name}`), h("b", {}, l.parts?.length && (l.parts.length > 1 || l.parts[0].u !== "unit") ? `${l.parts.map((p) => `${p.q} ${p.label ?? ""}`.trim()).join(" + ")} = ${fmt(l)}` : fmt(l)))));
      } catch (err) { body.textContent = errorText(err); }
    } }, h("summary", {}, `${stamp(n.completed_at)} · ${n.counted} ${t("invCounted")}${n.completed_by ? ` · ${n.completed_by}` : ""}`), body);
  })] : [];
  box.append(...head);
  if (!d.items.length) { box.append(h("div", { class: "empty" }, t("invNoItems")), ...hist); return; }
  if (!d.open) {
    box.append(h("section", { class: "card" }, h("p", {}, d.last ? `${t("invLast")} : ${stamp(d.last.completed_at)}` : t("invNever")),
      h("button", { class: "btn primary big", type: "button", onClick: async (e) => { e.currentTarget.disabled = true; try { await api("/inventory/start", { method: "POST", body: { restaurant_id: rid } }); render(); } catch (err) { e.currentTarget.disabled = false; toast(errorText(err)); } } }, `🧮 ${t("invStart")}`)), ...hist);
    return;
  }
  // ---- a count in progress ----
  // a product's count is a list of quantities: { q, u: "pack" | "unit" | "other", label }  (3 bundles + 40 boxes)
  const specOf = (it) => it.inv ?? {};
  const baseLabel = (it) => specOf(it).base_unit || t("invUnitPiece");
  const hasPack = (it) => !!(specOf(it).pack_unit && specOf(it).pack_qty);
  const totalOf = (it, parts) => Math.round(parts.reduce((a, p) => a + (p.u === "pack" ? (Number(p.q) || 0) * (specOf(it).pack_qty || 1) : p.u === "unit" ? Number(p.q) || 0 : 0), 0) * 1000) / 1000;
  const weightOf = (it, parts) => { const sp = specOf(it), per = sp.unit_weight ?? (sp.pack_weight && sp.pack_qty ? sp.pack_weight / sp.pack_qty : null); let w = 0, k = false;
    for (const p of parts) { const q = Number(p.q) || 0; if (p.u === "pack" && sp.pack_weight) { w += q * sp.pack_weight; k = true; } else if (p.u === "pack" && per && sp.pack_qty) { w += q * sp.pack_qty * per; k = true; } else if (p.u === "unit" && per) { w += q * per; k = true; } }
    return k ? Math.round(w * 100) / 100 : null; };
  const labelOf = (it, p) => (p.u === "pack" ? specOf(it).pack_unit : p.u === "other" ? p.label || "?" : baseLabel(it));
  const fmtParts = (it, parts) => parts.map((p) => `${p.q} ${labelOf(it, p)}`).join(" + ");
  const filled = (parts) => parts.filter((p) => p.q !== "" && p.q !== null && Number.isFinite(Number(p.q)) && Number(p.q) >= 0).map((p) => ({ q: Number(p.q), u: p.u, ...(p.u === "other" && p.label ? { label: p.label } : {}) }));
  const counted = new Map(d.open.lines.map((l) => [l.key, l.parts]));
  const lastBy = new Map((d.last?.lines ?? []).map((l) => [l.key, l]));
  const progress = h("strong", {});
  const paintProgress = () => { progress.textContent = `${counted.size} / ${d.items.length} ${t("invCounted")}`; };
  const locs = [...new Set(d.items.map((i) => i.location))];
  if (state.invLoc !== "all" && !locs.includes(state.invLoc)) state.invLoc = locs[0];
  const chips = h("div", { class: "cl-posts inv-locs", role: "group", "aria-label": t("invWhere") });
  const rows = h("div", { class: "inv-rows" });
  const q = h("input", { type: "search", placeholder: t("invSearch"), "aria-label": t("invSearch"), onInput: () => paintRows() });
  const timers = new Map();
  const lineOf = (it) => ({ key: it.key, name: it.name, location: it.location, category: it.category, parts: counted.get(it.key) ?? [] });
  const save = (it) => {
    clearTimeout(timers.get(it.key));
    timers.set(it.key, setTimeout(async () => { try { await api(`/inventory/${d.open.id}/lines`, { method: "PUT", body: { lines: [lineOf(it)] } }); } catch (err) { toast(errorText(err)); } }, 500));
  };
  const paintChips = () => chips.replaceChildren(...[["all", "📋", t("invAll")], ...locs.map((l) => [l, LOCATION_INFO[l]?.[0] ?? "📍", LOCATION_INFO[l] ? t(LOCATION_INFO[l][1]) : l])].map(([id, ic, label]) => {
    const n = d.items.filter((i) => id === "all" || i.location === id), done = n.filter((i) => counted.has(i.key)).length;
    return h("button", { type: "button", class: `chip-btn${state.invLoc === id ? " on" : ""}`, "aria-pressed": String(state.invLoc === id), onClick: () => { state.invLoc = id; paintChips(); paintRows(); } }, `${ic} ${label} ${done}/${n.length}`);
  }));
  const productRow = (it) => {
    const prev = lastBy.get(it.key), sp = specOf(it);
    let parts = (counted.get(it.key) ?? []).map((p) => ({ ...p }));
    if (!parts.length) parts = [{ q: "", u: hasPack(it) ? "pack" : "unit" }];
    const row = h("div", { class: "inv-row" }), list = h("div", { class: "inv-parts" }), total = h("div", { class: "inv-total" });
    const commit = () => { const f = filled(parts); if (f.length) counted.set(it.key, f); else counted.delete(it.key); paintTotal(); paintProgress(); paintChips(); save(it); };
    const paintTotal = () => {
      const f = filled(parts), tot = totalOf(it, f), w = weightOf(it, f);
      row.classList.toggle("done", f.length > 0);
      row.classList.toggle("low", f.length > 0 && !!sp.min_qty && tot < sp.min_qty);
      total.replaceChildren(...(f.length ? [h("b", {}, `= ${tot} ${baseLabel(it)}`), w !== null ? h("span", { class: "meta" }, ` · ≈ ${w} kg`) : null, sp.min_qty && tot < sp.min_qty ? h("span", { class: "inv-low" }, ` ⚠ ${t("invBelowMin")} (${sp.min_qty})`) : null] : []));
    };
    const paintParts = () => list.replaceChildren(...parts.map((p, idx) => {
      const qty = h("input", { type: "number", inputmode: "decimal", min: "0", step: "any", value: p.q === "" ? "" : String(p.q), placeholder: "—", "aria-label": `${it.name} — ${t("invQty")}`, onInput: () => { p.q = qty.value.trim() === "" ? "" : Number(qty.value); commit(); } });
      const step = (dx) => { p.q = Math.max(0, Math.round(((Number(p.q) || 0) + dx) * 100) / 100); qty.value = String(p.q); commit(); };
      const kinds = [...(hasPack(it) ? [["pack", sp.pack_unit]] : []), ["unit", baseLabel(it)], ["other", t("invOther")]];
      const sel = h("select", { "aria-label": t("invUnit"), onChange: () => { p.u = sel.value; if (p.u !== "other") delete p.label; paintParts(); commit(); } }, kinds.map(([v, l]) => h("option", { value: v, selected: p.u === v }, l)));
      const other = p.u === "other" ? h("input", { class: "inv-unit", maxLength: 20, value: p.label ?? "", placeholder: t("invOtherLabel"), "aria-label": t("invOtherLabel"), onInput: () => { p.label = other.value; commit(); } }) : null;
      return h("div", { class: "inv-part" }, h("button", { type: "button", class: "icon-btn", "aria-label": "−", onClick: () => step(-1) }, "−"), qty, h("button", { type: "button", class: "icon-btn", "aria-label": "+", onClick: () => step(1) }, "+"), sel,
        parts.length > 1 ? h("button", { type: "button", class: "icon-btn", "aria-label": t("invRemovePart"), title: t("invRemovePart"), onClick: () => { parts.splice(idx, 1); paintParts(); commit(); } }, "✕") : h("span", {}), other);
    }));
    const add = h("button", { type: "button", class: "btn small", onClick: () => { const used = new Set(parts.map((x) => x.u)); parts.push({ q: "", u: hasPack(it) && !used.has("pack") ? "pack" : !used.has("unit") ? "unit" : "other" }); paintParts(); list.querySelector(".inv-part:last-child input")?.focus(); } }, `+ ${t("invAddQty")}`);
    row.append(h("div", { class: "inv-name" }, h("b", {}, it.name), hasPack(it) ? h("small", { class: "meta" }, `1 ${sp.pack_unit} = ${sp.pack_qty} ${baseLabel(it)}`) : null,
      prev ? h("small", { class: "meta" }, `${t("invPrev")} : ${prev.parts?.length ? fmtParts(it, prev.parts) : `${prev.qty} ${prev.unit ?? ""}`}${prev.parts?.length > 1 || (prev.parts?.[0] && prev.parts[0].u !== "unit") ? ` (= ${prev.qty} ${prev.unit ?? baseLabel(it)})` : ""}`) : null), list, add, total);
    paintParts(); paintTotal();
    return row;
  };
  const paintRows = () => {
    const term = q.value.trim().toLowerCase();
    const list = d.items.filter((i) => (state.invLoc === "all" || i.location === state.invLoc) && (!term || i.name.toLowerCase().includes(term) || (i.inv?.family ?? "").toLowerCase().includes(term)))
      .sort((a, b) => (a.inv?.family ?? "").localeCompare(b.inv?.family ?? "", getLang()) || a.name.localeCompare(b.name, getLang()));
    const out = []; let fam = null;
    for (const it of list) { const f = it.inv?.family ?? null; if (f && f !== fam) out.push(h("h4", { class: "inv-family" }, f)); fam = f; out.push(productRow(it)); }
    rows.replaceChildren(...out);
    if (!rows.children.length) rows.append(h("p", { class: "meta" }, t("invNoMatch")));
  };
  const finish = h("button", { class: "btn primary", type: "button", onClick: async () => {
    if (!counted.size) { toast(t("invEmptyCount")); return; }
    const left = d.items.length - counted.size;
    if (!(await ask(left > 0 ? t("invFinishMissing").replace("{n}", left) : t("invFinishConfirm"), t("invFinish")))) return;
    timers.forEach((tm) => clearTimeout(tm));
    try {
      await api(`/inventory/${d.open.id}/lines`, { method: "PUT", body: { lines: d.items.filter((i) => counted.has(i.key)).map(lineOf) } });
      await api(`/inventory/${d.open.id}/complete`, { method: "POST", body: {} }); toast(t("invDone")); render();
    } catch (err) { toast(errorText(err)); }
  } }, `✔ ${t("invFinish")}`);
  const cancel = h("button", { class: "btn danger", type: "button", onClick: async () => { if (!(await ask(t("invCancelConfirm")))) return; try { await api(`/inventory/${d.open.id}`, { method: "DELETE" }); render(); } catch (err) { toast(errorText(err)); } } }, t("invCancel"));
  box.append(h("section", { class: "card inv-head" }, h("div", {}, h("b", {}, `🧮 ${t("invInProgress")}`), h("small", { class: "meta", style: "display:block" }, `${d.open.started_by ?? "—"} · ${stamp(d.open.started_at)}`)), progress),
    chips, q, rows, h("div", { class: "actions" }, finish, cancel), ...hist);
  paintProgress(); paintChips(); paintRows();
}

// ---- ordering from a supplier: the ways it takes orders, and the buttons for them ----
/** The fields of one supplier's product data for an ingredient, as typed (strings). */
const codeInit = (c = {}) => ({ p: c.p ?? "", alt: (c.alt ?? []).join(", "), price: c.price ?? "", unit: c.unit ?? "", pack_qty: c.pack_qty ?? "", pack_weight: c.pack_weight ?? "", yield_pct: c.yield_pct ?? "", prep: c.prep ?? "", prep_min: c.prep_min ?? "" });
/** The inputs of one supplier's product data for an ingredient: product numbers, price and the package it is sold in, and the preparation it needs here. `c` is edited in place. */
function productCodeFields(c, onChange = () => {}) {
  const inp = (key, props) => h("input", { value: c[key] ?? "", autocomplete: "off", ...props, onInput: (e) => { c[key] = e.target.value; onChange(); } });
  const dec = (key, step = "any") => inp(key, { type: "number", min: "0", step, inputmode: "decimal" });
  const two = (a, b) => h("div", { class: "ing-two" }, a, b);
  const f = (label, el) => h("label", { class: "field" }, h("span", {}, label), el);
  return h("div", { class: "ing-code-fields" },
    two(f(t("ingCodePreferred"), inp("p", { maxLength: 40 })), f(t("ingCodeAlternates"), inp("alt", { maxLength: 200, placeholder: t("ingCodeAltPh") }))),
    two(f(t("ingPrice"), dec("price", "0.01")), f(t("ingPriceUnit"), inp("unit", { maxLength: 20, list: "ing-units", placeholder: t("ingPriceUnitPh") }))),
    two(f(t("ingPackWeight"), dec("pack_weight")), f(t("ingPackQty"), dec("pack_qty"))),
    two(f(t("ingYield"), dec("yield_pct")), f(t("ingPrepMin"), dec("prep_min"))),
    f(t("ingPrepTask"), inp("prep", { maxLength: 60, placeholder: t("ingPrepPh") })));
}
/** The saved form of the fields above. */
const numOrNull = (v) => { const n = Number(String(v ?? "").replace(",", ".")); return Number.isFinite(n) && n > 0 ? n : null; };
const codeValue = (c) => ({ p: (c.p ?? "").trim(), alt: (c.alt ?? "").split(/[,;]/).map((x) => x.trim()).filter(Boolean), price: numOrNull(c.price), unit: (c.unit ?? "").trim(), pack_qty: numOrNull(c.pack_qty), pack_weight: numOrNull(c.pack_weight), yield_pct: numOrNull(c.yield_pct), prep: (c.prep ?? "").trim(), prep_min: numOrNull(c.prep_min) });
const codeFilled = (v) => !!(v.p || v.alt.length || v.price || v.pack_weight || v.pack_qty || v.prep);
const ORDER_METHOD_ICON = { call: "📞", email: "✉️", portal: "🔐", website: "🌐", api: "🔌" };
const orderMethodLabel = (m) => `${ORDER_METHOD_ICON[m] ?? ""} ${t(`ordMeth_${m}`)}`;
const supplierMethods = (sp) => (sp?.order_methods?.length ? sp.order_methods : sp?.order_method ? [sp.order_method] : []);
const fmtDay = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "short" });
const codeLine = (c) => (c && (c.p || c.alt?.length || c.price || c.prep) ? [c.p ? `#${c.p}` : null, c.alt?.length ? `${t("ordSubstitutes")} ${c.alt.map((a) => `#${a}`).join(", ")}` : null, c.price ? `${Number(c.price).toFixed(2)} $${c.unit ? ` / ${c.unit}` : ""}${c.pack_weight ? ` (${c.pack_weight} kg)` : ""}` : null, c.prep ? `🔪 ${c.prep}` : null].filter(Boolean).join(" · ") : "");
/** "Next order: Thursday before 2:00 pm · delivery Friday" for a supplier, from the window the server worked out. */
function windowNode(sp) {
  const w = sp.window;
  if (!sp.order_settings?.order_days?.length) return h("p", { class: "meta" }, `📅 ${t("ordNoSchedule")}`);
  if (!w) return null;
  return h("p", { class: "ord-window" }, `📅 ${t("ordNext")} : ${fmtDay(w.order_date)}${w.deadline ? ` ${t("ordBefore")} ${w.deadline}` : ""}${w.delivery_date ? ` · 🚚 ${t("ordDelivery")} ${fmtDay(w.delivery_date)}` : ""}`,
    w.missed_today ? h("span", { class: "inv-low" }, ` ⚠ ${t("ordMissedToday")}`) : null);
}
/** The buttons to place the open order of a supplier: e-mail, assisted call, portal, web site, and "mark as ordered". */
function orderActions({ sp, items, rid, canOrder, reload }) {
  const methods = supplierMethods(sp), out = [];
  const lines = () => items.map((o) => `${o.name}${o.codes?.[sp.id]?.p ? ` ${t("ordNumber")} ${o.codes[sp.id].p}` : ""}${o.note ? ` (${o.note})` : ""}`).join(", ");
  if (sp.email && canOrder && (methods.includes("email") || !methods.length)) out.push(h("button", { class: "btn small", type: "button", onClick: async (e) => {
    if (!(await ask(t("orderEmailConfirm").replace("{n}", items.length).replace("{s}", sp.name)))) return;
    const b = e.currentTarget; b.disabled = true;
    try { await api("/orders/email", { method: "POST", body: { restaurant_id: rid, supplier_id: sp.id } }); toast(t("orderEmailSent")); reload(); }
    catch (err) { b.disabled = false; toast(err.body?.error === "email_not_configured" ? t("orderEmailNotConfigured") : err.body?.error === "send_failed" ? `${t("orderEmailFailed")}${err.body.detail ? ` : ${err.body.detail}` : ""}` : errorText(err)); }
  } }, `✉️ ${t("orderEmailBtn")}`));
  if (methods.includes("call") && sp.phone && state.me?.voice) out.push(h("button", { class: "btn small", type: "button", onClick: () => {
    state.voicePrefill = { name: sp.name, phone: sp.phone, text: `${t("orderCallIntro").replace("{n}", sp.customer_number || "—")} ${lines()}.` }; state.voiceTab = "call"; state.voiceCall = null; state.view = "voice"; render();
  } }, `📞 ${t("orderCallAssist")}`));
  if (methods.includes("portal") && sp.portal_url) out.push(h("a", { class: "btn small", href: sp.portal_url, target: "_blank", rel: "noopener noreferrer" }, `🔐 ${t("ordOpenPortal")}`));
  if (methods.includes("website") && sp.website_url) out.push(h("a", { class: "btn small", href: sp.website_url, target: "_blank", rel: "noopener noreferrer" }, `🌐 ${t("ordOpenSite")}`));
  if (canOrder && items.length) {
    const how = h("select", { "aria-label": t("ordHow") }, [...new Set([...methods, "call", "email", "portal", "website"])].map((m) => h("option", { value: m }, orderMethodLabel(m))));
    out.push(h("span", { class: "ord-mark" }, how, h("button", { class: "btn small primary", type: "button", onClick: async () => {
      if (!(await ask(t("ordMarkConfirm").replace("{n}", items.length).replace("{s}", sp.name)))) return;
      try { await api("/orders/place", { method: "POST", body: { restaurant_id: rid, supplier_id: sp.id, method: how.value, item_ids: items.map((o) => o.id) } }); toast(t("ordMarked")); reload(); } catch (err) { toast(errorText(err)); }
    } }, `✔ ${t("ordMark")}`)));
  }
  return out;
}

// ---- receiving an order: the supplier's invoice (photo or PDF) is read by Claude and compared with the order ----
const INVOICE_MAX = 1_400_000;
/** A photo as a JPEG small enough to send (the text must stay readable: up to 2000 px, quality lowered only when needed). */
async function shrinkInvoice(file) {
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  for (let attempt = 0; attempt < 5; attempt++) {
    const cv = document.createElement("canvas"); cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", Math.max(0.55, 0.85 - attempt * 0.08)));
    if (blob && blob.size <= INVOICE_MAX - 20_000) return blob;
    scale *= 0.8;
  }
  throw new Error("too_large");
}
const money2 = (n) => (n === null || n === undefined ? "—" : `${Number(n).toFixed(2)} $`);
/** What came out of one invoice: the totals, how each line compares with the order, what is missing, and the price changes. */
function invoiceResult(inv, onChange) {
  const cmp = inv.comparison, box = h("div", { class: "inv-result" });
  box.append(h("div", { class: "inv-res-head" }, h("b", {}, `🧾 ${t("invcTitle")}${inv.invoice_number ? ` ${inv.invoice_number}` : ""}`),
    h("span", { class: "meta" }, `${inv.invoice_date ? ` · ${fmtDay(inv.invoice_date)}` : ""}${inv.total != null ? ` · ${money2(inv.total)}` : ""}`),
    h("a", { class: "btn small", href: `/api/invoices/${inv.id}/file`, target: "_blank", rel: "noopener noreferrer" }, `🔍 ${t("invcView")}`)));
  if (!inv.read_by_ai || !cmp) { box.append(h("p", { class: "meta" }, `⚠ ${t("invcNotRead")}`)); return box; }
  const n = (st) => cmp.rows.filter((r) => r.status === st).length;
  box.append(h("p", { class: "inv-counts" }, `✅ ${n("ok")} · 🔁 ${n("substitute")} · ➕ ${n("extra")} · ❓ ${n("unknown")} · ❌ ${cmp.missing.length}`));
  if (!cmp.had_order) box.append(h("p", { class: "meta" }, t("invcNoOrder")));
  const toPrep = cmp.rows.filter((r) => r.prep && (r.status === "ok" || r.status === "substitute" || r.status === "extra"));
  if (toPrep.length) box.append(h("div", { class: "inv-prep" }, h("b", {}, `🔪 ${t("invcToPrep")}`), h("ul", {}, toPrep.map((r) => h("li", {}, `${r.ingredient} — ${r.prep}`)))));
  const icon = { ok: "✅", substitute: "🔁", extra: "➕", unknown: "❓" };
  box.append(h("ul", { class: "inv-lines" },
    ...cmp.missing.map((m) => h("li", { class: "bad" }, `❌ ${m.name}${m.note ? ` (${m.note})` : ""} — ${t("invcMissing")}`)),
    ...cmp.rows.map((r) => h("li", { class: r.status }, `${icon[r.status]} ${r.line.description}`,
      h("small", { class: "meta" }, ` ${r.line.code ? `#${r.line.code} · ` : ""}${r.line.qty != null ? `${r.line.qty}${r.line.unit ? ` ${r.line.unit}` : ""}` : ""}${r.line.unit_price != null ? ` × ${money2(r.line.unit_price)}` : ""}`),
      r.status === "substitute" ? h("div", { class: "meta" }, `${t("invcReplaces")} ${r.ingredient}`) : r.status === "extra" ? h("div", { class: "meta" }, t("invcNotOrdered")) : r.status === "unknown" ? h("div", { class: "meta" }, t("invcUnknown")) : null))));
  if (cmp.price_changes.length) {
    const reverted = inv.prices_reverted === 1;
    box.append(h("h4", {}, `💲 ${t("invcPrices")}`), h("ul", { class: "inv-lines" }, cmp.price_changes.map((c) => h("li", {}, `${c.ingredient} : ${c.old != null ? `${money2(c.old)} → ` : ""}${money2(c.new)}${c.unit ? ` / ${c.unit}` : ""}`))),
      reverted ? h("p", { class: "meta" }, t("invcPricesReverted")) : h("button", { class: "btn small", type: "button", onClick: async (e) => {
        if (!(await ask(t("invcRevertConfirm")))) return; e.currentTarget.disabled = true;
        try { await api(`/invoices/${inv.id}/revert-prices`, { method: "POST" }); toast(t("invcPricesReverted")); onChange?.(); } catch (err) { e.currentTarget.disabled = false; toast(errorText(err)); }
      } }, t("invcRevert")));
  }
  return box;
}
/** Drop a file (or take a photo) of the invoice; the answer is shown in place. `order` is the order received (or null). */
function invoiceDropZone({ sp, rid, order, onDone }) {
  const out = h("div", { class: "inv-out" });
  const zone = h("div", { class: "drop-zone", tabindex: "0" });
  async function send(file) {
    if (!file) return;
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name), isImg = file.type.startsWith("image/");
    if (!isPdf && !isImg) { toast(t("invcBadType")); return; }
    out.replaceChildren(h("p", { class: "meta" }, `⏳ ${t("invcReading")}`));
    try {
      let blob = file;
      if (isImg) blob = await shrinkInvoice(file);
      else if (file.size > INVOICE_MAX) throw new Error("too_large");
      const res = await fetch(`/api/suppliers/${sp.id}/invoices?restaurant=${rid}${order ? `&order=${order.id}` : ""}`, { method: "POST", headers: { "content-type": isPdf ? "application/pdf" : "image/jpeg", "X-Filename": encodeURIComponent(file.name || "invoice"), ...clientHeader() }, body: blob });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(j.error ?? "error"), { body: j });
      const inv = await api(`/invoices/${j.id}`);
      out.replaceChildren(invoiceResult(inv, () => onDone?.()));
      onDone?.(true);
    } catch (err) { out.replaceChildren(h("p", { class: "inv-err" }, `⚠ ${err.message === "too_large" || err.body?.error === "file_too_large" ? t("invcTooBig") : err.body?.error === "unsupported_file" ? t("invcBadType") : errorText(err)}`)); }
  }
  const pick = (accept, capture) => { const i = h("input", { type: "file", accept, hidden: true, ...(capture ? { capture: "environment" } : {}), onChange: (e) => { const f = e.target.files[0]; e.target.value = ""; send(f); } }); return i; };
  const photo = pick("image/*", true), file = pick("image/*,application/pdf", false);
  zone.append(h("p", {}, `🧾 ${t("invcDrop")}`), h("div", { class: "ord-actions" },
    h("button", { class: "btn small", type: "button", onClick: () => photo.click() }, `📷 ${t("invcPhoto")}`), h("button", { class: "btn small", type: "button", onClick: () => file.click() }, `📁 ${t("invcChoose")}`)), photo, file);
  for (const ev of ["dragenter", "dragover"]) zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("over"); });
  for (const ev of ["dragleave", "drop"]) zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("over"); });
  zone.addEventListener("drop", (e) => send(e.dataTransfer?.files?.[0]));
  return h("div", { class: "inv-drop" }, zone, out);
}

// "À commander": ingredients reported as missing, grouped by supplier; managers mark them as ordered.
async function renderOrders(box, restaurantIds) {
  const restos = state.restaurants.filter((r) => restaurantIds.includes(r.id));
  if (!restos.some((r) => r.id === state.restockRestaurant)) state.restockRestaurant = (restos.find((r) => r.id === state.sel.restaurant) ?? restos[0])?.id ?? null;
  const rid = state.restockRestaurant;
  if (!rid) { box.append(h("div", { class: "empty" }, t("noSchedules"))); return; }
  const d = await api(`/orders?restaurant=${rid}`);
  const reload = () => render();
  // a drop-down with a search box: the ingredients by category (not the home-made ones), or any other item typed in the box
  let chosen = "";
  const label = h("span", { class: "oc-label" }, t("orderSearch"));
  const panel = h("div", { class: "oc-panel", hidden: true });
  const search = h("input", { type: "search", class: "oc-search", placeholder: t("orderSearchBox"), "aria-label": t("orderSearchBox"), autocomplete: "off" });
  const listBox = h("div", { class: "oc-list", role: "listbox" });
  const pick = (name) => { chosen = name; label.textContent = name; label.classList.toggle("set", !!name); closePanel(); };
  const drawList = () => {
    const norm = (x) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); // accents do not matter when searching
    const q = norm(search.value.trim());
    const hits = d.ingredients.filter((x) => !q || norm(x.name).includes(q));
    const cats = [...INGREDIENT_CATEGORIES.map(([v, key]) => [v, t(key)]), [null, t("ingNoCategory")]];
    const rows = cats.flatMap(([cat, name]) => { const g = hits.filter((x) => (x.category || null) === cat || (cat === null && !INGREDIENT_CATEGORIES.some(([v]) => v === x.category))); return g.length ? [h("div", { class: "oc-cat" }, name), ...g.map((x) => h("button", { type: "button", role: "option", class: "oc-opt", onClick: () => pick(x.name) }, x.name))] : []; });
    const exact = d.ingredients.some((x) => norm(x.name) === q);
    listBox.replaceChildren(...rows, q && !exact ? h("button", { type: "button", role: "option", class: "oc-opt other", onClick: () => pick(search.value.trim()) }, `+ « ${search.value.trim()} » (${t("orderOther")})`) : null, !rows.length && !q ? h("p", { class: "meta" }, t("orderEmpty")) : null);
  };
  const outside = (ev) => { if (!combo.contains(ev.target)) closePanel(); };
  function closePanel() { panel.hidden = true; document.removeEventListener("pointerdown", outside, true); }
  const toggle = () => { if (!panel.hidden) { closePanel(); return; } panel.hidden = false; search.value = ""; drawList(); search.focus(); document.addEventListener("pointerdown", outside, true); };
  search.addEventListener("input", drawList);
  search.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); if (e.key === "Enter") { e.preventDefault(); const first = listBox.querySelector(".oc-opt"); if (first) first.click(); } });
  const combo = h("div", { class: "oc-combo" }, h("button", { type: "button", class: "oc-btn", "aria-haspopup": "listbox", onClick: toggle }, label, h("span", { "aria-hidden": "true" }, "▾")), h("div", { class: "oc-panel-wrap" }, panel));
  panel.replaceChildren(search, listBox);
  const input = { get value() { return chosen; }, set value(v) { if (!v) pick(""); } };
  const note = h("input", { maxLength: 200, placeholder: t("orderNote"), "aria-label": t("orderNote") });
  const report = async () => {
    if (!input.value.trim()) return;
    try { const r = await api("/orders", { method: "POST", body: { restaurant_id: rid, name: input.value, note: note.value } }); toast(r.names?.length > 1 ? `${t("orderReported")} : ${r.names.join(", ")}` : t("orderReported")); reload(); } catch (e) { toast(errorText(e)); }
  };
  const when = (ms) => new Date(ms).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const supName = (id) => d.suppliers.find((x) => x.id === id)?.name;
  const row = (o, supplierId) => h("div", { class: "order-row" },
    h("div", {}, h("b", {}, o.name), o.note ? h("small", { class: "meta" }, ` · ${o.note}`) : null,
      h("small", { class: "meta", style: "display:block" }, `${t("orderBy")} ${o.reported_by ?? "—"} · ${when(o.reported_at)}${supplierId && o.codes?.[supplierId] && codeLine(o.codes[supplierId]) ? ` · ${codeLine(o.codes[supplierId])}` : ""}${o.supplier_ids.filter((s) => s !== supplierId).length ? ` · ${t("orderAlso")} ${o.supplier_ids.filter((s) => s !== supplierId).map(supName).join(", ")}` : ""}`)),
    d.can_order ? h("button", { class: "btn small primary", type: "button", onClick: async () => { try { await api(`/orders/${o.id}/ordered`, { method: "PUT", body: { supplier_id: supplierId } }); reload(); } catch (e) { toast(errorText(e)); } } }, t("orderDone")) : null,
    h("button", { class: "icon-btn", type: "button", "aria-label": t("delete"), onClick: async () => { if (!(await ask(t("orderCancelConfirm")))) return; try { await api(`/orders/${o.id}`, { method: "DELETE" }); reload(); } catch (e) { toast(errorText(e)); } } }, "✕"));
  const groups = [...d.suppliers.map((sp) => ({ sp, items: d.open.filter((o) => o.supplier_ids.includes(sp.id)) })), { sp: null, items: d.open.filter((o) => !o.supplier_ids.length) }].filter((g) => g.items.length);
  box.append(h("p", { class: "meta" }, t("orderHelp")),
    restos.length > 1 ? h("div", { class: "field", style: "max-width:320px" }, h("span", {}, t("restaurant")), restaurantSelect({ list: restos, value: rid, onChange: (id) => { state.restockRestaurant = id; render(); } })) : null,
    h("section", { class: "card order-report" }, h("h3", {}, `🛒 ${t("orderReport")}`), h("div", { class: "order-form" }, combo, note, h("button", { class: "btn primary", type: "button", onClick: report }, t("orderAddBtn")))),
    h("h3", { class: "restock-title" }, `${t("orderOpen")}${d.open.length ? ` · ${d.open.length}` : ""}`),
    ...(groups.length ? groups.map((g) => h("section", { class: "card order-group" }, h("h3", {}, g.sp ? `🚚 ${g.sp.name}` : t("supNone"), g.sp && supplierMethods(g.sp).length ? h("small", { class: "meta" }, ` · ${supplierMethods(g.sp).map(orderMethodLabel).join(" · ")}`) : null, g.sp?.customer_number ? h("small", { class: "meta" }, ` · ${t("supClientShort")} ${g.sp.customer_number}`) : null),
      g.sp ? windowNode(g.sp) : null,
      g.sp ? h("div", { class: "ord-actions" }, ...orderActions({ sp: g.sp, items: g.items, rid, canOrder: d.can_order, reload })) : null,
      g.sp && (g.sp.phone || g.sp.email) ? h("p", { class: "meta" }, g.sp.phone ? h("a", { href: `tel:${g.sp.phone}` }, `📞 ${formatPhone(g.sp.phone)}`) : null, g.sp.phone && g.sp.email ? " · " : "", g.sp.email ? h("a", { href: `mailto:${g.sp.email}` }, `✉️ ${g.sp.email}`) : null) : null,
      g.items.map((o) => row(o, g.sp?.id ?? null)))) : [h("p", { class: "meta" }, t("orderEmpty"))]),
    d.done.length ? h("details", { class: "order-done" }, h("summary", {}, t("orderRecent")), d.done.map((o) => h("div", { class: "order-row done" }, h("span", {}, `✓ ${o.name}`), h("small", { class: "meta" }, ` ${t("orderOrderedAt")} ${when(o.ordered_at)}${o.supplier ? ` · ${o.supplier}` : ""}`)))) : null);
}
// Restocking: tick what is missing at each post; the list to fetch is sorted by the place where things are kept.
state.restockRestaurant = null;
async function renderRestock(box, restaurantIds, mode = "restock") {
  const restos = state.restaurants.filter((r) => restaurantIds.includes(r.id));
  if (!restos.some((r) => r.id === state.restockRestaurant)) state.restockRestaurant = (restos.find((r) => r.id === state.sel.restaurant) ?? restos[0])?.id ?? null;
  const rid = state.restockRestaurant;
  if (!rid) { box.append(h("div", { class: "empty" }, t("noSchedules"))); return; }
  const data = await api(`/restock?restaurant=${rid}`);
  const lang = getLang(), gn = (g) => (lang === "en" ? g.name_en : g.name_fr);
  const holder = h("div", { class: "restock" });
  const setNeeded = async (items, needed) => {
    try { await api("/restock", { method: "PUT", body: { restaurant_id: rid, ingredient_ids: items.map((i) => i.id), needed } }); items.forEach((i) => { i.needed = needed; }); paint(); }
    catch (e) { toast(errorText(e)); }
  };
  const fetched = new Set(); // ticked in the fetch list for a home-made ingredient's basics (nothing to clear on the server)
  const paint = () => {
    const all = data.groups.flatMap((g) => g.items.map((i) => { i.group = gn(g); return i; }));
    const missing = all.filter((i) => i.needed);
    const byName = new Map(all.map((i) => [i.name.trim().toLowerCase(), i]));
    // what to fetch: the missing ingredients, and the basics needed to prepare the missing home-made ones
    const need = new Map();
    const addNeed = (name, location, id, why, hint) => { const k = `${location}|${name.trim().toLowerCase()}`; const e = need.get(k) ?? { key: k, name, location, ids: [], why: [] }; if (id) e.ids.push(id); if (why && !e.why.includes(why)) e.why.push(why); if (hint && !e.why.includes(hint)) e.why.push(hint); need.set(k, e); };
    for (const i of missing) {
      if (!i.homemade) addNeed(i.name, i.location, i.id, i.group, i.fridge_open ? `🧊 ${t("ingFridgeOpen").toLowerCase()}` : null);
      else for (const c of i.components ?? []) { const ref = byName.get(c.trim().toLowerCase()), q = i.component_qty?.[c]; addNeed(c, ref?.location ?? "fridge", null, `${t("forWord")} ${i.name}${q?.qty ? ` (${q.qty} ${q.unit ?? ""})`.replace(" )", ")") : ""}`); }
    }
    const fetchBy = Object.keys(LOCATION_INFO).map((loc) => [loc, [...need.values()].filter((e) => e.location === loc)]).filter(([, list]) => list.length);
    const toFetch = h("section", { class: "card restock-fetch" }, h("h3", {}, `🛒 ${t("restockToFetch")}`, need.size ? h("small", { class: "meta" }, ` · ${need.size} ${t("restockCount")}`) : null),
      fetchBy.length ? h("div", { class: "restock-places" }, fetchBy.map(([loc, list]) => h("div", { class: "restock-place" }, h("h4", {}, `${LOCATION_INFO[loc][0]} ${t(LOCATION_INFO[loc][1])} (${list.length})`),
        list.map((e) => h("label", { class: "check cl-item" }, h("input", { type: "checkbox", checked: fetched.has(e.key), onChange: (ev) => { if (e.ids.length) setNeeded(all.filter((i) => e.ids.includes(i.id)), false); else { if (ev.target.checked) fetched.add(e.key); else fetched.delete(e.key); } } }), h("span", {}, e.name), h("small", { class: "meta" }, ` · ${e.why.join(", ")}`), e.ids.length ? h("button", { type: "button", class: "btn small rupture", title: t("orderRupture"), onClick: async (ev) => { ev.preventDefault(); try { await api("/orders", { method: "POST", body: { restaurant_id: rid, name: e.name } }); all.filter((i) => e.ids.includes(i.id)).forEach((i) => { i.needed = false; }); toast(t("orderReported")); paint(); } catch (err) { toast(errorText(err)); } } }, `🚫 ${t("orderRupture")}`) : null))))) : h("p", { class: "meta" }, t("restockNothing")));
    if (mode === "prep") {
      const home = all.filter((i) => i.homemade);
      const todo = home.filter((i) => i.needed), rest = home.filter((i) => !i.needed);
      const task = (i) => h("label", { class: "check cl-item" }, h("input", { type: "checkbox", onChange: () => setNeeded([i], false) }),
        h("span", {}, h("b", {}, `${t("prepVerb")} : ${i.name}`), i.components?.length ? h("small", { class: "meta" }, ` · ${t("prepWith")} ${compText(i).join(", ")}`) : null,
          i.prep_note ? h("small", { class: "meta", style: "display:block" }, i.prep_note) : null, portionText(i) ? h("small", { class: "meta", style: "display:block" }, `⚖ ${portionText(i)}`) : null, h("small", { class: "meta", style: "display:block" }, i.group)));
      holder.replaceChildren(h("section", { class: "card" }, h("h3", {}, `📝 ${t("prepListTitle")}`, todo.length ? h("small", { class: "meta" }, ` · ${todo.length}`) : null), h("p", { class: "meta" }, t("prepListHelp")),
          todo.length ? todo.map(task) : h("p", { class: "meta" }, home.length ? t("prepNoneNow") : t("prepNoHomemade"))),
        rest.length ? h("section", { class: "card" }, h("h3", {}, t("prepAllTitle")), h("div", { class: "cl-posts" }, rest.map((i) => h("button", { type: "button", class: "chip-btn", title: i.group, onClick: () => setNeeded([i], true) }, `🏠 ${i.name}`)))) : null,
        need.size ? toFetch : null);
      return;
    }
    const groups = data.groups.length ? data.groups.map((g) => h("section", { class: "card restock-group" }, h("h3", {}, gn(g), g.items.some((i) => i.needed) ? h("small", { class: "meta" }, ` · ${g.items.filter((i) => i.needed).length}`) : null),
      // the ingredients of the post, under their category (those without one at the end)
      [...INGREDIENT_CATEGORIES.map(([v, key]) => [v, t(key)]), [null, t("ingNoCategory")]].map(([cat, label]) => [label, g.items.filter((i) => (i.category || null) === cat || (cat === null && !INGREDIENT_CATEGORIES.some(([v]) => v === i.category)))]).filter(([, list]) => list.length).map(([label, list0]) => [label, ingredientTree(list0).map((x) => x.item)]).map(([label, list]) =>
        h("div", { class: "restock-cat" }, g.items.some((i) => i.category) ? h("h4", {}, label) : null,
          h("div", { class: "cl-posts", role: "group", "aria-label": `${gn(g)} · ${label}` }, list.map((i) => h("button", { type: "button", class: `chip-btn ${i.needed ? "on need" : ""}`, "aria-pressed": String(!!i.needed), title: `${LOCATION_INFO[i.location]?.[0] ?? ""} ${t(LOCATION_INFO[i.location]?.[1] ?? "locFridge")}`, onClick: () => setNeeded([i], !i.needed) }, `${i.needed ? "⚠ " : ""}${i.homemade ? "🏠 " : ""}${i.name}`))))))) : [h("div", { class: "empty" }, t("restockNoGroups"))];
    // two tabs: one to choose the ingredients that are missing, one for the list to go and fetch
    const tab = state.restockTab === "fetch" ? "fetch" : "choose";
    const tabBar = h("div", { class: "subtabs restock-tabs", role: "tablist" }, [["choose", `✔ ${t("restockTabChoose")}`, missing.length], ["fetch", `🛒 ${t("restockTabFetch")}`, need.size]].map(([id, label, n]) =>
      h("button", { type: "button", role: "tab", "aria-selected": String(tab === id), onClick: () => { state.restockTab = id; paint(); } }, label, n > 0 ? h("span", { class: "nav-badge" }, String(n)) : null)));
    holder.replaceChildren(tabBar, ...(tab === "choose"
      ? [h("p", { class: "meta" }, t("restockHelp")), h("h3", { class: "restock-title" }, t("restockMissingTitle")), h("div", { class: "restock-groups" }, groups)]
      : [need.size ? toFetch : h("div", { class: "empty" }, `✓ ${t("restockNothingToFetch")}`)]));
  };
  box.append(restos.length > 1 ? h("div", { class: "field", style: "max-width:320px" }, h("span", {}, t("restaurant")), restaurantSelect({ list: restos, value: rid, onChange: (id) => { state.restockRestaurant = id; render(); } })) : null, holder);
  paint();
}
async function checklistCard(shiftId, info, test = false) {
  const card = h("section", { class: "card checklist-card" });
  const lang = getLang();
  const txt = (o) => (lang === "en" ? o.text_en || o.text_fr : o.text_fr);
  const nm = (o) => (lang === "en" ? o.name_en : o.name_fr);
  const dueSoon = (at) => { const n = new Date(); return `${ymd(n)}T${pad(n.getHours())}:${pad(n.getMinutes())}` >= new Date(Date.parse(`${at}:00Z`) - 30 * 60000).toISOString().slice(0, 16); };
  async function draw() {
    const d = await api(`/shifts/${shiftId}/checklist`);
    const total = d.lists.reduce((n, l) => n + l.items.length, 0), done = d.lists.reduce((n, l) => n + l.items.filter((i) => i.done || i.issue).length, 0);
    const bar = h("div", { class: "cl-progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": total, "aria-valuenow": done }, h("span", { style: `width:${total ? (done / total) * 100 : 0}%` }));
    card.replaceChildren(
      h("div", { class: "cl-head" }, h("b", {}, `${info?.restaurant ?? ""} · ${dayOf(d.shift.start_at) === ymd(new Date()) ? "" : `${fmt(dayOf(d.shift.start_at), { weekday: "short", day: "numeric", month: "short" })} `}${hhmm(d.shift.start_at)}–${hhmm(d.shift.end_at)}`), h("span", { class: "meta" }, total ? `${done}/${total}` : "")),
      total ? bar : null,
      // kitchen: the posts are not in the schedule, so the employee ticks the post(s) he worked and the list below follows
      d.posts.length ? h("div", { class: "cl-posts-box" },
        h("div", { class: "cl-posts-title" }, t("checklistMyPost")),
        h("div", { class: "cl-posts", role: "group", "aria-label": t("checklistMyPost") }, d.posts.map((p) => h("button", { type: "button", class: `chip-btn ${p.picked ? "on" : ""}`, "aria-pressed": String(p.picked), onClick: async () => {
          const list = d.lists.find((l) => l.kind === "post" && l.target_id === p.id);
          if (p.picked) {
            if (list?.items.some((i) => i.done) && !(await ask(t("checklistRemovePostConfirm")))) return;
            await api(`/shifts/${shiftId}/checklist/posts/${p.id}`, { method: "DELETE" });
          } else await api(`/shifts/${shiftId}/checklist/posts`, { method: "POST", body: { post_id: p.id } });
          await refresh();
        } }, `${p.picked ? "✓ " : ""}${nm(p)}`)))) : null,
      ...d.lists.map((l) => h("div", { class: `cl-list ${l.kind === "prep" || l.kind === "thaw" || l.kind === "closing" ? "prep" : ""}` }, h("h3", {}, l.kind === "prep" ? `📝 ${t("prepTitle")}` : l.kind === "thaw" ? `❄️ ${t("thawTitle")}` : l.kind === "closing" ? `🧹 ${t("closingTitle")}` : nm(l), l.start_at ? h("small", { class: "meta" }, ` · ${hhmm(l.start_at)}–${hhmm(l.end_at)}`) : null),
        // a post handed over before the end of the shift: its list is due at the handover
        l.due_at < d.shift.end_at && l.kind !== "prep" && l.kind !== "thaw" && l.kind !== "closing" ? h("div", { class: `cl-due ${dueSoon(l.due_at) ? "soon" : ""}` }, `⏰ ${t("checklistDueBy")} ${hhmm(l.due_at)}`) : null,
        ...l.items.map((it) => h("div", { class: `cl-item-wrap ${it.issue ? "issue" : ""}` },
          h("label", { class: `check cl-item ${it.done ? "done" : ""}` },
            h("input", { type: "checkbox", checked: it.done, onChange: async (e) => {
              const input = e.target;
              try {
                if (l.kind === "prep") await api(`/shifts/${shiftId}/prep/${it.id}`, { method: "PUT", body: { done: input.checked } });
                else if (l.kind === "thaw") await api(`/shifts/${shiftId}/thaw/${it.id}`, { method: "PUT", body: { done: input.checked } });
                else if (l.kind === "closing") await api(`/shifts/${shiftId}/closing/${it.id}`, { method: "PUT", body: { done: input.checked } });
                else await api(`/shifts/${shiftId}/checklist/items`, { method: "PUT", body: { item_id: it.id, done: input.checked } });
                await refresh();
              }
              catch (err) { input.checked = !input.checked; toast(errorText(err)); }
            } }), h("span", {}, txt(it)), l.kind === "prep" && it.due_at ? h("small", { class: "meta" }, ` · ${t("prepDueBy")} ${hhmm(it.due_at)}`) : null,
            // could not finish it: say why (missing ingredients…)
            l.kind === "prep" || l.kind === "thaw" || l.kind === "closing" ? null : h("button", { type: "button", class: "cl-issue-btn", title: t("checklistCannot"), "aria-label": t("checklistCannot"), onClick: async (e) => {
              e.preventDefault();
              const r = await issueDialog(txt(it), it.issue);
              if (!r) return;
              try {
                if (r.remove) await api(`/shifts/${shiftId}/checklist/issues/${it.id}`, { method: "DELETE" });
                else await api(`/shifts/${shiftId}/checklist/issues`, { method: "PUT", body: { item_id: it.id, reason: r.reason, note: r.note } });
                await refresh();
              } catch (err) { toast(errorText(err)); }
            } }, "⚠️")),
          it.issue ? h("div", { class: "cl-issue" }, h("b", {}, it.issue.reason === "missing_ingredient" ? `${t("checklistMissingIng")} : ` : `${t("checklistOtherReason")} : `), it.issue.note) : null)))),
      d.vehicle_report ? h("div", { class: "cl-vehicle" }, h("button", { class: "btn", type: "button", onClick: () => vehicleIssueDialog({ restaurantId: d.vehicle_report.restaurant_id }) }, `🚗 ${t("vehReport")}`), h("span", { class: "meta" }, ` ${t("vehReportHint")}`)) : null,
      !d.lists.length ? h("p", { class: "cl-pick-hint" }, `👆 ${t("checklistPickPost")}`) : null,
      total && done === total && !d.submitted ? h("div", { class: "okmsg" }, `🎉 ${t("checklistComplete")}`) : null,
      // close the list even if some tasks are not ticked
      d.submitted ? h("div", { class: "okmsg" }, `✓ ${t("checklistClosedMsg")}`, " ", h("button", { class: "btn small", type: "button", onClick: async () => { try { await api(`/shifts/${shiftId}/checklist/done`, { method: "DELETE" }); await refresh(); } catch (e) { toast(errorText(e)); } } }, t("checklistReopen")))
        : total && done < total ? h("div", { class: "actions cl-done" }, h("button", { class: "btn primary", type: "button", onClick: async () => {
          if (!(await ask(`${total - done} ${t("checklistDoneConfirm")}`))) return;
          try { await api(`/shifts/${shiftId}/checklist/done`, { method: "POST" }); await refresh(); } catch (e) { toast(errorText(e)); }
        } }, `✓ ${t("checklistDoneBtn")}`)) : null);
    return { total, done, submitted: d.submitted };
  }
  // after each change: when everything is done the tab disappears, so go back to the shifts
  async function refresh() {
    const r = await draw();
    // keep the badge of the header tab in step with what is left to do
    const entry = state.checklistShifts?.find((x) => x.id === shiftId);
    if (entry) { entry.total = r.total; entry.done = r.done; entry.needs_post = r.total === 0; renderChrome(); }
    if (!test && ((r.total && r.done === r.total) || r.submitted)) setTimeout(() => { if (!state.restock?.length) state.view = "mine"; render(); }, 2200);
  }
  await draw();
  return card;
}

// ---------- Assisted phone calls ----------
// Written message read aloud on the phone; the person's spoken answer comes back as text.
async function renderVoice() {
  if (state.voicePoll) { clearInterval(state.voicePoll); state.voicePoll = null; }
  const [info, calls] = await Promise.all([api("/voice/contacts"), api("/voice/calls")]);
  const box = h("div", { class: "account voice-view" }, h("h2", {}, `📞 ${t("voiceTitle")}`));
  $app.replaceChildren(box);
  const vtab = state.voiceTab === "orders" ? "orders" : "call";
  box.append(h("div", { class: "subtabs lists-tabs", role: "tablist" }, [["call", t("voiceTabCall"), "📞"], ["orders", t("listsOrders"), "🛒"]].map(([id, label, icon]) =>
    h("button", { type: "button", role: "tab", title: label, "aria-label": label, "aria-selected": String(vtab === id), onClick: () => { state.voiceTab = id; render(); } }, h("span", { class: "tab-ic", "aria-hidden": "true" }, icon), h("span", { class: "tab-tx" }, label)))));
  if (vtab === "orders") { await renderOrders(box, state.restaurants.map((r) => r.id)); return; }
  const lang = getLang();
  const errMsg = (e) => { const k = `voiceErr_${e.body?.error}`; const base = t(k) !== k ? t(k) : errorText(e); return e.body?.detail ? `${base} : ${e.body.detail}` : base; };
  const quick = [["voiceYes"], ["voiceNo"], ["voiceThanks"], ["voiceOk"], ["voiceCallMe"]].map(([k]) => t(k));
  const statusText = (call, last) => {
    if (!call.active) return { queued: t("voiceRinging"), completed: t("voiceEnded"), no_answer: t("voiceNoAnswer"), busy: t("voiceBusy"), failed: t("voiceFailed") }[call.status] ?? t("voiceEnded");
    return call.status === "queued" ? t("voiceRinging") : last?.direction === "out" && last.delivered ? t("voiceListening") : t("voiceOnline");
  };
  const bubble = (m, toName) => {
    if (m.direction === "sys") { const txt = { no_answer: t("voiceNoAnswer"), busy: t("voiceBusy"), failed: t("voiceFailed"), completed: t("voiceEnded"), idle: t("voiceIdle") }[m.text] ?? (m.text.startsWith("call_failed") ? `${t("voiceErr_call_failed")} · ${m.text.slice(13)}` : m.text); return h("div", { class: "vc-sys" }, txt); }
    const mine = m.direction === "out";
    return h("div", { class: `vc-row ${mine ? "mine" : "theirs"}` }, h("div", { class: "vc-bubble" }, h("small", {}, mine ? t("voiceWho") : toName), h("p", {}, m.text),
      mine ? h("small", { class: "vc-state" }, m.delivered ? `🔊 ${t("voiceSpoken")}` : `⏳ ${t("voiceWaiting")}`) : null),
      h("time", {}, new Date(m.created_at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })));
  };
  const phrases = (target) => h("div", { class: "vc-quick", role: "group", "aria-label": t("voiceQuick") }, quick.map((q) => h("button", { type: "button", class: "chip-btn", onClick: () => { target.value = target.value ? `${target.value} ${q}` : q; target.focus(); } }, q)));

  // ---- the conversation of a call ----
  function conversation(id, startActive) {
    const thread = h("div", { class: "vc-thread", "aria-live": "polite" });
    const head = h("div", { class: "vc-head" });
    const composer = h("div", { class: "vc-composer" });
    let call = null, count = -1;
    const text = h("textarea", { rows: 2, maxLength: 500, placeholder: t("voiceMessage"), "aria-label": t("voiceMessage"), onKeydown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } } });
    async function send() {
      const v = text.value.trim(); if (!v) return;
      try { await api(`/voice/calls/${id}/say`, { method: "POST", body: { text: v } }); text.value = ""; poll(); } catch (e) { toast(errMsg(e)); }
    }
    const hang = h("button", { class: "btn danger", type: "button", onClick: async () => { try { await api(`/voice/calls/${id}/hangup`, { method: "POST" }); } catch (e) { toast(errMsg(e)); } poll(); } }, `📵 ${t("voiceHangup")}`);
    composer.replaceChildren(text, h("div", { class: "vc-actions" }, h("button", { class: "btn primary", type: "button", onClick: send }, t("voiceSend")), hang), phrases(text));
    async function poll() {
      let d; try { d = await api(`/voice/calls/${id}`); } catch { return; }
      call = d.call;
      const last = [...d.messages].reverse().find((m) => m.direction !== "sys");
      head.replaceChildren(h("h3", {}, `📞 ${call.to_name}`), h("span", { class: `vc-status ${call.active ? "live" : ""}` }, statusText(call, last)));
      if (d.messages.length !== count || d.messages.some((m) => m.direction === "out" && !m.delivered) || count < 0) {
        const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80 || count < 0;
        thread.replaceChildren(...d.messages.map((m) => bubble(m, call.to_name))); count = d.messages.length;
        if (nearBottom) thread.scrollTop = thread.scrollHeight;
      }
      if (!call.active) {
        clearInterval(state.voicePoll); state.voicePoll = null;
        composer.replaceChildren(h("button", { class: "btn primary", type: "button", onClick: () => { state.voiceCall = null; render(); } }, t("voiceNewCall")));
      }
    }
    box.append(head, thread, composer);
    poll(); state.voicePoll = setInterval(() => { if (state.view !== "voice") { clearInterval(state.voicePoll); state.voicePoll = null; return; } poll(); }, 2000);
  }

  const active = calls.find((c) => c.active);
  if (state.voiceCall || active) { conversation(state.voiceCall ?? active.id); return; }

  // ---- a new call ----
  const pick = (v) => v.startsWith("c") ? info.extra.find((x) => `c${x.id}` === v) : v.startsWith("v") ? info.suppliers?.find((x) => `v${x.id}` === v) : info.contacts.find((x) => `s${x.id}` === v);
  const who = h("select", { "aria-label": t("voiceTo"), onChange: () => { const c = who.value === "p" ? null : pick(who.value); if (c) langSel.value = c.lang === "en" ? "en" : "fr"; } }, h("option", { value: "" }, `— ${t("voiceChoose")}`),
    h("optgroup", { label: t("voiceGroupTeam") }, info.contacts.map((c) => h("option", { value: `s${c.id}` }, `${c.name} (…${c.tail})`))),
    info.extra?.length ? h("optgroup", { label: t("voiceGroupContacts") }, info.extra.map((c) => h("option", { value: `c${c.id}` }, `${c.name}${c.label ? ` · ${c.label}` : ""} (…${c.tail})`))) : null,
    info.suppliers?.length ? h("optgroup", { label: t("voiceGroupSuppliers") }, info.suppliers.map((c) => h("option", { value: `v${c.id}` }, `🚚 ${c.name} (…${c.tail})`))) : null);
  const pre = state.voicePrefill; state.voicePrefill = null;
  if (pre) who.prepend(h("option", { value: "p", selected: true }, `${pre.name} (…${pre.phone.slice(-4)})`));
  const langSel = h("select", { "aria-label": t("voiceLangLabel") }, [["fr", "Français"], ["en", "English"]].map(([v, l]) => h("option", { value: v, selected: v === lang }, l)));
  const msg = h("textarea", { rows: 4, maxLength: 500, placeholder: t("voiceMessage"), "aria-label": t("voiceMessage") }, pre?.text ?? "");
  const go = h("button", { class: "btn primary big", type: "button", disabled: !info.ready, onClick: async () => {
    if (!who.value) { toast(t("voiceChoose")); return; }
    go.disabled = true;
    try { const r = await api("/voice/calls", { method: "POST", body: { ...(who.value === "p" ? { phone: pre.phone } : { [{ c: "contact_id", v: "supplier_id", s: "staff_id" }[who.value[0]]]: Number(who.value.slice(1)) }), lang: langSel.value, text: msg.value } }); state.voiceCall = r.id; render(); }
    catch (e) { toast(errMsg(e)); go.disabled = false; }
  } }, t("voiceCallBtn"));
  box.append(h("p", { class: "meta" }, t("voiceHelp")), info.ready ? null : h("div", { class: "info" }, `⚠ ${t("voiceNotReady")}`),
    h("div", { class: "card vc-new" }, h("div", { class: "vc-two" }, h("label", { class: "field" }, h("span", {}, t("voiceTo")), who), h("label", { class: "field" }, h("span", {}, t("voiceLangLabel")), langSel)),
      h("label", { class: "field" }, h("span", {}, t("voiceMessage")), msg), phrases(msg), go));
  if (calls.length) box.append(h("h3", { class: "restock-title" }, t("voiceHistory")), h("div", { class: "vc-history" }, calls.map((c) => h("button", { type: "button", class: "vc-hist-row", onClick: () => { state.voiceCall = c.id; render(); } },
    h("b", {}, c.to_name), h("small", {}, new Date(c.created_at).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })), h("small", { class: "meta" }, statusText(c, null))))));
}

// ---------- Communities ----------
// A message board per restaurant and group of departments; people are in the ones matching their roles.
const timeAgo = (iso) => new Date(iso).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
// ---------- Personal messages (the Messages tab of Communities) ----------
function dmSetUnread(n) { const d = n - (state.dmUnread ?? 0); state.dmUnread = n; state.communityUnread = Math.max(0, (state.communityUnread ?? 0) + d); renderChrome(); }
const dmFirst = (p) => p.first_name || p.name.split(" ")[0];
/** The name of a conversation: the group's name, else the first names of the others (the other person's full name when it is direct). */
function dmName(th, myId) {
  if (th.title) return th.title;
  const others = th.members.filter((m) => m.id !== myId);
  return others.length === 1 ? others[0].name : others.map(dmFirst).join(", ") || t("dmAlone");
}
const dmIcon = (th, myId, size = 40) => { const others = th.members.filter((m) => m.id !== myId); return others.length === 1 && !th.is_group ? avatar(others[0].id, others[0].name, others[0].color, others[0].photo_v, size) : h("span", { class: "dm-group-ic", style: `--s:${size}px`, "aria-hidden": "true" }, "👥"); };

// Desktop: the conversations on the left, the chosen one on the right. Phone: like Messenger: the list, then a full-screen chat with a back arrow.
async function renderMessages(box) {
  clearInterval(state.dmTimer); clearInterval(state.dmListTimer);
  const myId = state.me.me.id;
  const desktop = mqDesktop.matches;
  const root = box.closest(".community");
  const setOpen = (on) => root?.classList.toggle("dm-open", on && !desktop); // phone: the chat takes the whole screen
  let threads = [];
  const reach = await api("/messages/people").catch(() => ({ can_group: false, people: [] })); // who can be written to, and whether a group may be started
  const when = (ms) => { const d = new Date(ms), n = new Date(); return d.toDateString() === n.toDateString() ? d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : d.toLocaleDateString(locale(), { day: "numeric", month: "short" }); };
  const loadThreads = async () => { threads = await api("/messages/threads"); dmSetUnread(threads.reduce((n, x) => n + x.unread, 0)); };
  const search = h("input", { type: "search", class: "dm-search", placeholder: t("dmFind"), "aria-label": t("dmFind"), autocomplete: "off" });
  const listEl = h("div", { class: "dm-list", role: "list" });
  const norm = (x) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const pick = (id) => { state.dmThread = id; if (desktop) { paintList(); renderPane(); } else renderMessages(box); };
  const paintList = () => {
    const q = norm(search.value.trim());
    const rows = threads.filter((th) => !q || norm(dmName(th, myId)).includes(q));
    listEl.replaceChildren(...(rows.length ? rows.map((th) => h("button", { type: "button", role: "listitem", class: `dm-row ${th.unread ? "unread" : ""} ${state.dmThread === th.id ? "selected" : ""}`, "aria-current": state.dmThread === th.id ? "true" : "false", onClick: () => pick(th.id) },
      dmIcon(th, myId, 52),
      h("span", { class: "dm-row-main" }, h("span", { class: "dm-row-top" }, h("b", {}, dmName(th, myId)), h("span", { class: "meta dm-when" }, when(th.last_message_at))),
        h("span", { class: "dm-preview-line" }, h("span", { class: "meta dm-preview" }, `${th.last_by === myId ? `${t("dmYou")} : ` : ""}${th.last_body || (th.last_media ? dmMediaLabel(th.last_media) : t("dmDeleted"))}`), th.unread ? h("span", { class: "dm-dot", "aria-label": `${th.unread}` }, th.unread > 9 ? "9+" : String(th.unread)) : null)))) : [h("div", { class: "empty" }, threads.length ? t("dmNoMatch") : t("dmNone"))]));
  };
  search.addEventListener("input", paintList);
  const startNew = (kind) => { state.dmThread = kind; if (desktop) { paintList(); renderPane(); } else renderMessages(box); };
  const newBtn = h("button", { class: "btn primary dm-new-btn", type: "button", "aria-label": t("dmNew"), title: t("dmNew"), onClick: () => startNew("new") }, h("span", { "aria-hidden": "true" }, "✎"), h("span", { class: "dm-new-tx" }, ` ${t("dmNew")}`));
  const groupBtn = reach.can_group ? h("button", { class: "btn dm-new-btn", type: "button", "aria-label": t("dmNewGroup"), title: t("dmNewGroup"), onClick: () => startNew("newgroup") }, h("span", { "aria-hidden": "true" }, "👥"), h("span", { class: "dm-new-tx" }, ` ${t("dmNewGroup")}`)) : null;
  const sideHead = () => [h("div", { class: "dm-head" }, h("h3", {}, t("dmTab")), h("div", { class: "dm-head-btns" }, groupBtn, newBtn)), h("p", { class: "meta dm-privacy" }, t("dmPrivacy")), search, listEl];
  const pane = h("section", { class: "dm-main" });
  const toList = async () => { state.dmThread = null; if (desktop) { await loadThreads(); paintList(); renderPane(); } else renderMessages(box); };
  const toThread = async (id) => { await loadThreads(); state.dmThread = id; if (desktop) { paintList(); renderPane(); } else renderMessages(box); };
  async function renderPane() {
    clearInterval(state.dmTimer);
    if (state.dmThread === "new" || state.dmThread === "newgroup") { setOpen(true); return messageComposer(pane, toThread, toList, state.dmThread === "newgroup"); }
    if (state.dmThread) { setOpen(true); await messageThread(pane, state.dmThread, myId, toList, () => { loadThreads().then(paintList).catch(() => {}); }); return; }
    setOpen(false);
    pane.replaceChildren(h("div", { class: "dm-placeholder" }, h("div", { class: "dm-placeholder-ic", "aria-hidden": "true" }, "💬"), h("p", {}, t("dmPick"))));
  }
  await loadThreads();
  if (state.dmThread === "newgroup" && !reach.can_group) state.dmThread = null;
  if (desktop) {
    if (!state.dmThread && threads.length) state.dmThread = threads.find((x) => x.unread)?.id ?? threads[0].id; // like Messenger on a computer: a conversation is already open
    box.replaceChildren(h("div", { class: "dm-split" }, h("aside", { class: "dm-side" }, ...sideHead()), pane));
    paintList(); await renderPane();
    state.dmListTimer = setInterval(() => { if (!box.isConnected) { clearInterval(state.dmListTimer); return; } if (!document.hidden) loadThreads().then(paintList).catch(() => {}); }, 20000);
    return;
  }
  if (state.dmThread) { box.replaceChildren(pane); await renderPane(); return; }
  setOpen(false);
  // phone: the conversations start at the top; "new message" (and "new group") are round buttons at the bottom of the screen, like Messenger
  // the search sits behind a magnifier at the right of the tabs (like Messenger); tapping it shows the field above the list
  search.hidden = !search.value;
  const bar = root?.querySelector(".comm-top");
  bar?.querySelector(".dm-loupe")?.remove();
  const loupe = h("button", { type: "button", class: "dm-loupe", "aria-label": t("dmFind"), title: t("dmFind"), "aria-expanded": String(!search.hidden), onClick: () => {
    search.hidden = !search.hidden; loupe.setAttribute("aria-expanded", String(!search.hidden));
    if (search.hidden) { search.value = ""; paintList(); } else search.focus();
  } }, "🔍");
  bar?.append(loupe);
  box.replaceChildren(search, listEl, h("p", { class: "meta dm-privacy" }, t("dmPrivacy")),
    h("div", { class: "dm-fab" }, groupBtn, newBtn)); paintList();
  state.dmListTimer = setInterval(() => { if (!box.isConnected) { clearInterval(state.dmListTimer); return; } if (!document.hidden && !state.dmThread) loadThreads().then(paintList).catch(() => {}); }, 20000);
}

/** New conversation. Direct: pick ONE colleague and write. Group (when an administrator allows it): pick two or more, name it, write; it then shows in the list like any conversation. */
async function messageComposer(box, toThread, toList, group = false) {
  const { people, can_group: canGroup, max_group: maxGroup } = await api("/messages/people");
  if (group && !canGroup) { toList(); return; }
  const chosen = new Map();
  const search = h("input", { type: "search", placeholder: t("dmSearch"), "aria-label": t("dmSearch"), autocomplete: "off" });
  const chips = h("div", { class: "dm-chips" });
  const list = h("div", { class: "dm-people" });
  const title = h("input", { maxLength: 60, placeholder: t("dmGroupName"), "aria-label": t("dmGroupName") });
  const body = h("textarea", { rows: 3, maxLength: 2000, placeholder: t("dmWrite"), "aria-label": t("dmWrite") });
  const send = h("button", { class: "btn primary", type: "submit", disabled: true }, t("dmSend"));
  const need = group ? 2 : 1;
  const norm = (x) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const ready = () => { send.disabled = chosen.size < need || !body.value.trim(); };
  const choose = (p) => {
    if (!group) { chosen.clear(); chosen.set(p.id, p); }                                   // one person: tapping another one replaces the first
    else if (chosen.has(p.id)) chosen.delete(p.id);
    else if (chosen.size >= maxGroup - 1) { toast(t("dmGroupFull").replace("{n}", String(maxGroup))); return; }
    else chosen.set(p.id, p);
    refresh();
  };
  function refresh() {
    chips.replaceChildren(...[...chosen.values()].map((p) => h("button", { type: "button", class: "dm-chip", "aria-label": `${t("dmRemove")} ${p.name}`, onClick: () => { chosen.delete(p.id); refresh(); } }, `${p.name} ✕`)));
    ready();
    const q = norm(search.value.trim());
    list.replaceChildren(...(people.length ? people.filter((p) => !q || norm(p.name).includes(q)).map((p) => h("button", { type: "button", class: `dm-person ${chosen.has(p.id) ? "on" : ""}`, "aria-pressed": String(chosen.has(p.id)), onClick: () => choose(p) },
      avatar(p.id, p.name, p.color, p.photo_v, 34), h("span", { class: "dm-person-name" }, p.name), h("span", { class: "dm-check", "aria-hidden": "true" }, chosen.has(p.id) ? "✓" : ""))) : [h("div", { class: "empty" }, t("dmNoPeople"))]));
  }
  search.addEventListener("input", refresh); body.addEventListener("input", ready);
  refresh();
  box.replaceChildren(h("div", { class: "dm-new-view" },
    h("div", { class: "dm-chat-head" }, h("button", { class: "dm-back", type: "button", "aria-label": t("dmBack"), onClick: toList }, "‹"), h("h3", {}, group ? `👥 ${t("dmNewGroup")}` : t("dmNew"))),
    h("form", { class: "acc-form dm-new", onSubmit: async (e) => {
      e.preventDefault();
      try { const r = await api("/messages/threads", { method: "POST", body: { member_ids: [...chosen.keys()], title: group ? title.value : undefined, body: body.value } }); toThread(r.id); }
      catch (err) { toast(err.body?.error === "too_many_requests" ? t("loginTooMany") : err.body?.error === "groups_not_allowed" ? t("dmGroupsOff") : err.body?.error === "not_reachable" ? t("dmNotReachable") : errorText(err)); }
    } }, h("div", { class: "field" }, h("span", {}, group ? t("dmToMany") : t("dmTo")), chips, search, list), group ? h("label", { class: "field" }, h("span", {}, t("dmGroupName")), title) : null, group ? h("p", { class: "meta" }, t("dmGroupNeedTwo")) : null, body,
      h("div", { class: "actions" }, h("button", { class: "btn sm", type: "button", "aria-label": t("emojis"), title: t("emojis"), onClick: (e) => emojiPopover(e.currentTarget, (em) => { insertAtCursor(body, em); ready(); }) }, "😊"), send))));
}

/** The Messenger-style write bar, shared by Messages and Communities: round icons that fold into "›" while typing, a thumbs-up when empty, ➤ when there is something to send.
 *  opts: { uploadUrl, send({ body, media_ids }) (throws to keep what was typed), placeholder, like: "👍" }. Returns { form, previews, body, focus() }. */
function messengerBar({ uploadUrl, send, placeholder, like = "👍", sendLabel }) {
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  const body = h("textarea", { rows: 1, maxLength: 2000, class: "dm-input", placeholder: placeholder ?? t("dmMsgPh"), "aria-label": t("dmWrite") });
  const grow = () => { body.style.height = "auto"; body.style.height = `${Math.min(body.scrollHeight, 140)}px`; };
  let attached = [], expanded = true, busy = false;
  const previews = h("div", { class: "comm-previews dm-previews" });
  const drawPreviews = () => previews.replaceChildren(...attached.map((m, i) => h("div", { class: "comm-preview" },
    m.kind === "video" ? h("video", { src: m.url, muted: true, playsinline: true, preload: "metadata" }) : m.kind === "audio" ? h("div", { class: "comm-preview-audio" }, h("audio", { src: m.url, controls: true, preload: "metadata" }), m.transcript ? h("small", { class: "meta" }, `📝 ${m.transcript}`) : null) : h("img", { src: m.url, alt: "" }),
    h("button", { type: "button", class: "icon-btn", "aria-label": t("delete"), onClick: () => { attached.splice(i, 1); drawPreviews(); sync(); } }, "✕"))));
  const upload = async (file) => {
    if (attached.length >= 4) { toast(t("mediaTooMany")); return; }
    try { toast(t("mediaUploading")); attached.push(await uploadMedia(uploadUrl, file)); drawPreviews(); sync(); }
    catch (err) { toast(err.message === "too_large" ? t("mediaTooBig") : err.message === "invalid_type" ? t("mediaBadType") : errorText(err)); }
  };
  const picker = h("input", { type: "file", accept: "image/*,video/*,audio/*", multiple: true, hidden: true, onChange: async (e) => { const files = [...e.target.files]; e.target.value = ""; for (const f of files) await upload(f); } });
  const record = async (video) => { const file = await recordMessage(video); if (file) await upload(file); };
  const ic = (icon, label, run) => h("button", { class: "dm-ic round", type: "button", "aria-label": label, title: label, onClick: run }, icon);
  const toolsEl = h("div", { class: "dm-bar-tools" }, ic("📎", t("addMedia"), () => picker.click()), picker, ic("🎤", t("recVoice"), () => record(false)), ic("🎥", t("recVideo"), () => record(true)),
    ic("😊", t("emojis"), (e) => emojiPopover(e.currentTarget, (em) => { insertAtCursor(body, em); if (body.value.trim()) expanded = false; sync(); grow(); })));
  const moreBtn = ic("›", t("dmMoreTools"), () => { expanded = true; sync(); });
  moreBtn.classList.add("dm-more");
  const sendIc = h("span", { "aria-hidden": "true" }), sendTx = h("span", { class: "dm-send-tx" });
  const sendBtn = h("button", { class: "dm-send", type: "submit" }, sendIc, sendTx); // on a computer the label shows beside the arrow once there is something to send
  const typing = () => body.value.trim().length > 0 || attached.length > 0;
  function sync() {
    if (!typing()) expanded = true;
    toolsEl.hidden = typing() && !expanded; moreBtn.hidden = !(typing() && !expanded);
    const on = typing();
    sendIc.textContent = on ? "➤" : like; sendTx.textContent = on ? sendLabel ?? t("dmSend") : ""; sendBtn.classList.toggle("like", !on); sendBtn.setAttribute("aria-label", on ? t("dmSend") : t("dmLike")); sendBtn.title = on ? t("dmSend") : t("dmLike");
  }
  body.addEventListener("input", () => { if (body.value.trim() && expanded) expanded = false; sync(); grow(); });
  const sendNow = async (e) => {
    e?.preventDefault();
    if (busy) return;
    const text = body.value.trim();
    const quick = !text && !attached.length;                       // nothing written: the thumbs-up
    busy = true;
    try {
      await send({ body: quick ? like : text, media_ids: attached.map((m) => m.id) });
      body.value = ""; attached = []; drawPreviews(); expanded = true; grow(); sync();
    } catch (err) { toast(err?.body?.error === "too_many_requests" ? t("dmSlow") : errorText(err)); }
    finally { busy = false; }
  };
  // a computer: Enter sends (Shift+Enter = new line); a phone: Enter is a new line and the button sends
  body.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing && (finePointer ? !e.shiftKey : false)) sendNow(e); else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendNow(e); });
  const form = h("form", { class: "dm-compose", onSubmit: sendNow }, toolsEl, moreBtn, body, sendBtn);
  sync();
  return { form, previews, body, focus: () => { if (finePointer) body.focus(); } };
}

const dmMediaLabel = (k) => (k === "video" ? `🎥 ${t("dmVideo")}` : k === "audio" ? `🎤 ${t("voiceMsg")}` : `📷 ${t("dmPhoto")}`);
/** One conversation: a header (back arrow, who), the messages, and a Messenger-style bar to answer. */
async function messageThread(box, id, myId, toList, onChange) {
  let d = await api(`/messages/threads/${id}`);
  const msgs = h("div", { class: "dm-msgs", "aria-live": "polite" });
  const nameOf = (sid) => { const p = d.members.find((m) => m.id === sid); return p ? dmFirst(p) : "—"; };
  const person = (sid) => d.members.find((m) => m.id === sid);
  const th = () => ({ ...d.thread, members: d.members });
  const dayLabel = (ms) => { const x = new Date(ms), n = new Date(); const y = new Date(n); y.setDate(n.getDate() - 1); return x.toDateString() === n.toDateString() ? t("today") : x.toDateString() === y.toDateString() ? t("yesterday") : x.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long" }); };
  const hhmm = (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const snippet = (m) => (m.deleted ? t("dmDeleted") : m.body || (m.media?.[0] ? dmMediaLabel(m.media[0].kind) : m.kind ? dmMediaLabel(m.kind) : ""));
  // what is being written: pictures / voice already uploaded, the message being answered
  let replyTo = null;
  const replyBar = h("div", { class: "dm-replybar", hidden: true });
  const setReply = (m) => {
    replyTo = m; replyBar.hidden = !m;
    replyBar.replaceChildren(...(m ? [h("div", { class: "dm-replytxt" }, h("b", {}, `${t("dmReplyTo")} ${m.mine ? t("dmYou") : nameOf(m.staff_id)}`), h("span", { class: "meta" }, snippet(m))), h("button", { type: "button", class: "round", "aria-label": t("cancel"), onClick: () => setReply(null) }, "✕")] : []));
    if (m) body.focus();
  };
  const toggleReaction = async (m, emoji) => {
    const on = !m.reactions.some((r) => r.emoji === emoji && r.mine);
    try { await api(`/messages/messages/${m.id}/reaction`, { method: "PUT", body: { emoji, on } }); await reload(false); } catch (e) { toast(errorText(e)); }
  };
  const removeMessage = async (m) => { if (await ask(t("dmDeleteConfirm"))) { try { await api(`/messages/messages/${m.id}`, { method: "DELETE" }); await reload(false); } catch (e) { toast(errorText(e)); } } };
  const bubble = (m, prev, next) => {
    const first = !prev || prev.staff_id !== m.staff_id || m.created_at - prev.created_at > 300000, last = !next || next.staff_id !== m.staff_id || next.created_at - m.created_at > 300000;
    const p = person(m.staff_id);
    const line = h("div", { class: `dm-line ${m.mine ? "mine" : "theirs"}`, "data-mid": String(m.id) },
      !m.mine ? (last && p ? avatar(p.id, p.name, p.color, p.photo_v, 28) : h("span", { class: "dm-av-gap" })) : null,
      h("div", { class: "dm-stack" },
        h("div", { class: `dm-msg ${m.mine ? "mine" : "theirs"} ${m.deleted ? "deleted" : ""}`, title: hhmm(m.created_at) },
          !m.mine && d.thread.is_group && first ? h("b", { class: "dm-from" }, nameOf(m.staff_id)) : null,
          m.reply ? h("button", { type: "button", class: "dm-quote", onClick: () => msgs.querySelector(`[data-mid="${m.reply.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }) }, h("b", {}, m.reply.by), h("span", {}, m.reply.deleted ? t("dmDeleted") : m.reply.body || (m.reply.kind ? dmMediaLabel(m.reply.kind) : ""))) : null,
          m.deleted ? h("i", {}, t("dmDeleted")) : [mediaGrid(m.media, "/api/messages/media/"), m.body ? h("span", { class: "dm-text" }, m.body) : null],
          last ? h("span", { class: "meta dm-time" }, hhmm(m.created_at)) : null),
        m.reactions?.length ? h("div", { class: "dm-reacts" }, m.reactions.map((r) => h("button", { type: "button", class: `react ${r.mine ? "mine" : ""}`, "aria-pressed": String(r.mine), onClick: () => toggleReaction(m, r.emoji) }, r.count > 1 ? `${r.emoji} ${r.count}` : r.emoji))) : null));
    if (!m.deleted) msgActions(line, { react: (e) => toggleReaction(m, e), reply: () => setReply(m), del: m.mine ? () => removeMessage(m) : null });
    return line;
  };
  const older = h("button", { class: "btn sm", type: "button", hidden: true, onClick: async () => {
    const first = d.messages[0]?.id; if (!first) return;
    const more = await api(`/messages/threads/${id}?before=${first}`);
    d = { ...d, messages: [...more.messages, ...d.messages], more: more.more }; paint(false);
  } }, t("dmOlder"));
  function paint(stick) {
    const nearBottom = stick || msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
    const out = [older];
    d.messages.forEach((m, i) => {
      const same = (o) => o && new Date(o.created_at).toDateString() === new Date(m.created_at).toDateString() ? o : null;
      const prev = d.messages[i - 1];
      if (!same(prev)) out.push(h("div", { class: "dm-day" }, dayLabel(m.created_at)));
      out.push(bubble(m, same(prev), same(d.messages[i + 1])));
    });
    msgs.replaceChildren(...out);
    older.hidden = !d.more;
    if (nearBottom) msgs.scrollTop = msgs.scrollHeight;
  }
  async function reload(stick) { d = await api(`/messages/threads/${id}`); paint(stick); api("/messages/unread").then((u) => dmSetUnread(u.unread)).catch(() => {}); onChange?.(); }

  const bar = messengerBar({ uploadUrl: `/api/messages/threads/${id}/media`, send: async ({ body: text, media_ids }) => {
    await api(`/messages/threads/${id}/messages`, { method: "POST", body: { body: text, media_ids, reply_to: replyTo?.id } });
    setReply(null); await reload(true);
  } });
  const body = bar.body;
  const members = d.members.filter((m) => m.id !== myId);
  box.replaceChildren(h("div", { class: "dm-chat" },
    h("div", { class: "dm-chat-head" }, h("button", { class: "dm-back", type: "button", "aria-label": t("dmBack"), onClick: toList }, "‹"),
      h("div", { class: "dm-title" }, dmIcon(th(), myId, 40), h("div", { class: "dm-title-tx" }, h("b", {}, dmName(th(), myId)), d.thread.is_group ? h("div", { class: "meta" }, `${d.members.length} ${t("dmPeople")} · ${members.map(dmFirst).join(", ")}`) : null)),
      d.thread.is_group ? h("button", { class: "btn sm danger", type: "button", onClick: async () => { if (await ask(t("dmLeaveConfirm"))) { try { await api(`/messages/threads/${id}/leave`, { method: "POST" }); toList(); } catch (e) { toast(errorText(e)); } } } }, t("dmLeave")) : null),
    msgs, replyBar, bar.previews, bar.form));
  paint(true);
  api("/messages/unread").then((u) => dmSetUnread(u.unread)).catch(() => {});
  state.dmTimer = setInterval(() => { if (!box.isConnected) { clearInterval(state.dmTimer); return; } if (!document.hidden && !body.value.trim()) reload(false).catch(() => {}); }, 12000); // new messages arrive while it is open
  bar.focus();
}

async function renderCommunity() {
  const list = await api("/communities");
  // two tabs at the top: Communities (the boards) and Messages (personal messages, always there, even with no community)
  const tab = state.commTab ?? (list.length ? "communities" : "messages");
  const dmMode = tab === "messages";
  if (!dmMode && list.length && !list.some((x) => x.id === state.communityId)) { state.communityId = (list.find((x) => x.unread) ?? list[0]).id; state.commOpen = false; }
  const postsUnread = list.reduce((n, x) => n + (x.unread || 0), 0);
  const topTabs = h("div", { class: "subtabs comm-top", role: "tablist" }, [["communities", `🏘️ ${t("communityTab")}`, postsUnread], ["messages", `💬 ${t("dmTab")}`, state.dmUnread ?? 0]].map(([id, label, n]) =>
    h("button", { type: "button", role: "tab", "aria-selected": String(tab === id), onClick: () => { state.commTab = id; if (id === "messages") state.dmThread = null; else state.commOpen = false; renderCommunity(); } }, label, n > 0 && tab !== id ? h("span", { class: "nav-badge" }, String(n)) : null)));
  const inner = h("div", { class: "dm" });
  $app.replaceChildren(h("div", { class: "account community" }, h("h2", {}, t("messagesNav")), topTabs, inner));
  if (dmMode) { await renderMessages(inner); return; }
  if (!list.length) { inner.replaceChildren(h("div", { class: "empty" }, t("noCommunity"))); return; }
  inner.classList.add("comm-boards");
  await renderBoards(inner, list);
}

// Communities work exactly like Messages: a computer shows the boards on the left and the chosen one on the right; a phone shows the list,
// then a full-screen feed with a back arrow. The posts are on top (the newest at the bottom), the write bar is at the bottom.
async function renderBoards(box, list) {
  clearInterval(state.dmTimer); clearInterval(state.dmListTimer);
  const desktop = mqDesktop.matches;
  const root = box.closest(".community");
  const setOpen = (on) => root?.classList.toggle("dm-open", on && !desktop);
  const manyRestos = new Set(list.map((x) => x.restaurant_id)).size > 1;
  const short = (n) => n.split(/-des-|\sdes\s/)[0];
  const shortIcons = (deps) => { const l = deps.filter((d) => d !== "admin"); return [...(l.length ? l : deps)].sort((a, b) => DEPTS.indexOf(a) - DEPTS.indexOf(b)).map(deptIcon).join(""); };
  const title = (x) => (manyRestos ? `${short(x.restaurant)} · ${x.name}` : x.name);
  const when = (iso) => { const d = new Date(iso), n = new Date(); return d.toDateString() === n.toDateString() ? d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : d.toLocaleDateString(locale(), { day: "numeric", month: "short" }); };
  const preview = (x) => (x.last_body ? `${x.last_by}: ${x.last_body}` : x.last_media ? `${x.last_by}: ${dmMediaLabel(x.last_media)}` : t("noPosts"));
  const search = h("input", { type: "search", class: "dm-search", placeholder: t("commFind"), "aria-label": t("commFind"), autocomplete: "off" });
  const listEl = h("div", { class: "dm-list", role: "list" });
  const norm = (x) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const pane = h("section", { class: "dm-main" });
  const syncBadges = () => { state.communityUnread = list.reduce((n, x) => n + (x.unread || 0), 0) + (state.dmUnread ?? 0); renderChrome(); };
  const refreshList = async () => { try { const fresh = await api("/communities"); list.splice(0, list.length, ...fresh); } catch { return; } syncBadges(); paintList(); };
  const open = (id) => { state.communityId = id; state.commOpen = true; if (desktop) { paintList(); renderPane(); } else renderBoards(box, list); };
  const toList = () => { state.commOpen = false; renderBoards(box, list); };
  function paintList() {
    const q = norm(search.value.trim());
    const rows = list.filter((x) => !q || norm(`${x.restaurant} ${x.name}`).includes(q));
    listEl.replaceChildren(...(rows.length ? rows.map((x) => h("button", { type: "button", role: "listitem", class: `dm-row ${x.unread ? "unread" : ""} ${desktop && state.communityId === x.id ? "selected" : ""}`, "aria-current": desktop && state.communityId === x.id ? "true" : "false", onClick: () => open(x.id) },
      h("span", { class: "dm-group-ic board-ic", style: "--s:52px", "aria-hidden": "true" }, shortIcons(x.departments)),
      h("span", { class: "dm-row-main" }, h("span", { class: "dm-row-top" }, h("b", {}, title(x)), x.last_post_at ? h("span", { class: "meta dm-when" }, when(x.last_post_at)) : null),
        h("span", { class: "dm-preview-line" }, h("span", { class: "meta dm-preview" }, preview(x)), x.unread ? h("span", { class: "dm-dot", "aria-label": `${x.unread}` }, x.unread > 9 ? "9+" : String(x.unread)) : null)))) : [h("div", { class: "empty" }, t("dmNoMatch"))]));
  }
  search.addEventListener("input", paintList);
  async function renderPane() {
    clearInterval(state.dmTimer);
    const c = list.find((x) => x.id === state.communityId);
    if (!c || (!desktop && !state.commOpen)) { setOpen(false); pane.replaceChildren(h("div", { class: "dm-placeholder" }, h("div", { class: "dm-placeholder-ic", "aria-hidden": "true" }, "🏘️"), h("p", {}, t("commPick")))); return; }
    setOpen(true);
    await communityFeed(pane, c, { shortIcons, title, toList, onChange: refreshList });
  }
  if (desktop) {
    box.replaceChildren(h("div", { class: "dm-split" }, h("aside", { class: "dm-side" }, h("div", { class: "dm-head" }, h("h3", {}, t("communityTab"))), search, listEl), pane));
    paintList(); await renderPane();
    state.dmListTimer = setInterval(() => { if (!box.isConnected) { clearInterval(state.dmListTimer); return; } if (!document.hidden) refreshList(); }, 30000);
    return;
  }
  if (state.commOpen && list.some((x) => x.id === state.communityId)) { box.replaceChildren(pane); await renderPane(); return; }
  setOpen(false);
  // phone: the list; the search sits behind a magnifier next to the tabs, like in Messages
  search.hidden = !search.value;
  const bar = root?.querySelector(".comm-top");
  bar?.querySelector(".dm-loupe")?.remove();
  const loupe = h("button", { type: "button", class: "dm-loupe", "aria-label": t("commFind"), title: t("commFind"), "aria-expanded": String(!search.hidden), onClick: () => {
    search.hidden = !search.hidden; loupe.setAttribute("aria-expanded", String(!search.hidden));
    if (search.hidden) { search.value = ""; paintList(); } else search.focus();
  } }, "🔍");
  bar?.append(loupe);
  box.replaceChildren(search, listEl); paintList();
}

/** One board: its posts on top (pinned ones in a strip, the newest at the bottom), the Messenger-style write bar at the bottom. */
async function communityFeed(box, c, { shortIcons, title, toList, onChange }) {
  const id = c.id;
  let posts = [], moderator = false, more = false;
  const msgs = h("div", { class: "dm-msgs comm-posts", "aria-live": "polite" });
  const pinnedBox = h("div", { class: "comm-pinned", hidden: true });
  const author = (x) => h("div", { class: "post-who" }, avatar(x.staff_id, x.author, x.color, x.photo_v, 34), h("div", {}, h("b", {}, x.first_name || x.author), h("span", { class: "meta" }, ` · ${timeAgo(x.created_at)}`)));
  const reactionBar = (x) => h("div", { class: "reactions" }, ...x.reactions.map((r) => h("button", { type: "button", class: `react ${r.mine ? "mine" : ""}`, "aria-pressed": String(r.mine), onClick: () => toggleReact(x, r.emoji) }, `${r.emoji} ${r.count}`)));
  const toggleReact = async (x, emoji) => { const on = !x.reactions.some((r) => r.emoji === emoji && r.mine); try { await api(`/community-posts/${x.id}/reaction`, { method: "PUT", body: { emoji, on } }); await load(false); } catch (e) { toast(errorText(e)); } };
  const removePost = async (x) => { if (await ask(t("confirmDeletePost"))) { try { await api(`/community-posts/${x.id}`, { method: "DELETE" }); await load(false); } catch (e) { toast(errorText(e)); } } };
  const postCard = (x) => {
    const replyInput = h("input", { maxLength: 2000, placeholder: t("writeReply"), "aria-label": t("writeReply") });
    const replyBox = h("form", { class: "comm-reply", hidden: true, onSubmit: async (e) => {
      e.preventDefault();
      const input = e.target.querySelector("input"); if (!input.value.trim()) return;
      try { await api(`/communities/${id}/posts`, { method: "POST", body: { body: input.value, parent_id: x.id } }); await load(false); } catch (err) { toast(errorText(err)); }
    } }, replyInput, h("button", { class: "btn sm", type: "button", "aria-label": t("emojis"), title: t("emojis"), onClick: (e) => emojiPopover(e.currentTarget, (em) => insertAtCursor(replyInput, em)) }, "😊"), h("button", { class: "btn sm primary", type: "submit" }, t("send")));
    const article = h("article", { class: `post ${x.pinned ? "pinned" : ""}` },
      x.pinned ? h("div", { class: "post-pin" }, `📌 ${t("pinned")}`) : null,
      author(x), x.body ? h("p", { class: "post-body" }, x.body) : null, mediaGrid(x.media), reactionBar(x),
      x.replies.length ? h("div", { class: "post-replies" }, x.replies.map((r) => { const el = h("div", { class: "reply" }, author(r), r.body ? h("p", { class: "post-body" }, r.body) : null, mediaGrid(r.media), reactionBar(r)); msgActions(el, { react: (e) => toggleReact(r, e), del: r.can_delete ? () => removePost(r) : null }); return el; })) : null,
      replyBox);
    // hover toolbar / long press: react, reply, pin (moderators), delete
    msgActions(article, { react: (e) => toggleReact(x, e), reply: () => { replyBox.hidden = false; replyBox.querySelector("input").focus(); },
      pin: moderator ? { label: x.pinned ? t("unpin") : t("pin"), run: async () => { try { await api(`/community-posts/${x.id}/pin`, { method: "PUT", body: { pinned: !x.pinned } }); await load(false); } catch (e) { toast(errorText(e)); } } } : null,
      del: x.can_delete ? () => removePost(x) : null });
    return article;
  };
  const older = h("button", { class: "btn sm", type: "button", hidden: true, onClick: async () => {
    const oldest = Math.min(...posts.filter((p) => !p.pinned).map((p) => p.id));
    const more2 = await api(`/communities/${id}/posts?before=${oldest}`);
    const have = new Set(posts.map((p) => p.id));
    posts = [...posts, ...more2.posts.filter((p) => !have.has(p.id))]; more = more2.more; paint(false);
  } }, t("olderPosts"));
  function paint(stick) {
    const nearBottom = stick || msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
    const pinned = posts.filter((p) => p.pinned), rest = posts.filter((p) => !p.pinned).sort((a, b) => a.id - b.id);
    pinnedBox.replaceChildren(...pinned.map(postCard)); pinnedBox.hidden = !pinned.length;
    msgs.replaceChildren(...(more ? [older] : []), ...(rest.length ? rest.map(postCard) : [h("div", { class: "empty" }, t("noPosts"))]));
    older.hidden = !more;
    if (nearBottom) msgs.scrollTop = msgs.scrollHeight;
  }
  async function load(stick) { const d = await api(`/communities/${id}/posts`); moderator = d.moderator; posts = d.posts; more = d.more; paint(stick); onChange?.(); }
  const bar = messengerBar({ sendLabel: t("publishBtn"), uploadUrl: `/api/communities/${id}/media`, send: async ({ body: text, media_ids }) => { await api(`/communities/${id}/posts`, { method: "POST", body: { body: text, media_ids } }); await load(true); } });
  box.replaceChildren(h("div", { class: "dm-chat comm-feed-view" },
    h("div", { class: "dm-chat-head" }, h("button", { class: "dm-back", type: "button", "aria-label": t("dmBack"), onClick: toList }, "‹"),
      h("div", { class: "dm-title" }, h("span", { class: "dm-group-ic board-ic", style: "--s:40px", "aria-hidden": "true" }, shortIcons(c.departments)), h("div", { class: "dm-title-tx" }, h("b", {}, title(c)), h("div", { class: "meta" }, c.restaurant)))),
    pinnedBox, msgs, bar.previews, bar.form));
  await load(true);
  state.dmTimer = setInterval(() => {
    if (!box.isConnected) { clearInterval(state.dmTimer); return; }
    const typingReply = [...box.querySelectorAll(".comm-reply:not([hidden]) input")].some((i) => i.value);
    if (!document.hidden && !typingReply && !bar.body.value.trim()) load(false).catch(() => {});   // new posts arrive while it is open
  }, 15000);
  bar.focus();
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

// "Your shift starts soon" reminders: how long before, and by which channel; up to 5.
const REMINDER_PRESETS = [15, 30, 45, 60, 90, 120, 180, 720, 1440];
function durationLabel(min) {
  if (min >= 1440 && min % 1440 === 0) { const d = min / 1440; return getLang() === "fr" ? `${d} jour${d > 1 ? "s" : ""}` : `${d} day${d > 1 ? "s" : ""}`; }
  if (min >= 60) { const hh = Math.floor(min / 60), m = min % 60; return m ? `${hh} h ${String(m).padStart(2, "0")}` : `${hh} h`; }
  return `${min} min`;
}
// A section that folds: open on a computer, closed on a phone (to keep the screen short).
function fold(title, children, open) {
  const d = h("details", { class: "fold" }, h("summary", {}, title), h("div", { class: "fold-body" }, ...[].concat(children)));
  d.open = open ?? mqDesktop.matches;
  return d;
}
function reminderControls() {
  const box = h("div", { class: "reminders" });
  let items = [];
  const draw = () => {
    const rows = items.map((it, i) => {
      const opts = REMINDER_PRESETS.includes(it.minutes_before) ? REMINDER_PRESETS : [...REMINDER_PRESETS, it.minutes_before].sort((a, b) => a - b);
      const word = (it.anchor ?? "start") === "end" ? t("reminderBeforeEnd") : t("reminderBeforeWord"); // "30 min avant" / "30 min avant la fin": no separate field for it
      const when = h("select", { "aria-label": t("reminderBefore"), onChange: (e) => { it.minutes_before = Number(e.target.value); } }, opts.map((m) => h("option", { value: m, selected: m === it.minutes_before }, `${durationLabel(m)} ${word}`)));
      const how = h("select", { "aria-label": t("reminderHow"), onChange: (e) => { it.channel = e.target.value; } }, [["push", t("reminderPush")], ["sms", t("sms")], ["email", t("emailCh")]].map(([v, l]) => h("option", { value: v, selected: v === it.channel }, l)));
      return h("div", { class: "reminder-row" }, h("div", { class: "reminder-sels" }, when, how), h("button", { class: "icon-btn", type: "button", "aria-label": t("delete"), title: t("delete"), onClick: () => { items.splice(i, 1); draw(); } }, "🗑"));
    });
    box.replaceChildren(h("p", { class: "meta acc-help" }, t("remindersHelp")), ...(rows.length ? rows : [h("p", { class: "meta" }, t("noReminders"))]),
      h("div", { class: "actions push-actions reminder-add" },
        items.length < 5 ? h("button", { class: "btn", type: "button", onClick: () => { items.push({ minutes_before: items.some((x) => x.minutes_before === 60) ? 30 : 60, channel: "push", anchor: "start" }); draw(); } }, `+ ${t("addReminder")}`) : null));
  };
  // saved together with the rest of the form (the main Enregistrer button)
  box.save = async () => { if (loaded) await api("/account/reminders", { method: "PUT", body: { items } }); };
  let loaded = false;
  api("/account/reminders").then((rows) => { items = rows; loaded = true; draw(); }).catch((e) => box.replaceChildren(h("p", { class: "meta" }, errorText(e))));
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

// On a phone the tabs of Mon compte are icons only (the name stays as tooltip and for screen readers).
const ACCOUNT_TAB_ICONS = { profile: "📋", daysoff: "📅", availability: "🕑", timeoff: "🌴", calendar: "🗓️", payslips: "💵", security: "🔒" };
async function renderAccount() {
  const acc = await api("/account");
  const phone = h("input", { type: "tel", value: acc.phone ?? "", autocomplete: "tel" });
  phone.value = formatPhone(acc.phone);
  phone.addEventListener("blur", () => { phone.value = formatPhone(phone.value); });
  const lang = radioGroup("acc-lang", [["fr", "Français"], ["en", "English"]], acc.lang);
  const channel = radioGroup("acc-chan", [["sms", t("sms")], ["email", t("emailCh")]], acc.notify_channel);
  const reminders = reminderControls();
  const save = async (e) => {
    e.preventDefault();
    try { await api("/account", { method: "PUT", body: { phone: phone.value, lang: lang.value, notify_channel: channel.value } }); await reminders.save(); toast(t("saved")); }
    catch (err) { toast(err.body?.error === "invalid_phone" ? t("invalidPhone") : err.body?.error === "duplicate" ? t("reminderDuplicate") : errorText(err)); }
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
  let slipsLoaded = false;
  const loadSlips = () => { if (slipsLoaded) return; slipsLoaded = true; api("/payslips").then((rows) => slipsBox.replaceChildren(rows.length ? h("div", { class: "log" }, rows.map((r) =>
    h("a", { class: "log-row slip-link", href: `/api/payslips/${r.id}/pdf`, target: "_blank", rel: "noopener" }, h("span", {}, r.pay_date ?? r.filename), h("span", { class: "meta" }, `${r.period_label ?? ""} · PDF`)))) : h("p", { class: "meta" }, t("noPayslips"))))
    .catch(() => { slipsLoaded = false; slipsBox.replaceChildren(h("p", { class: "meta" }, t("genericError"))); }); };
  // Mobile-first, tab-based screen (same tabs as the employee dialog, limited to what the employee may change).
  const profile = h("form", { class: "acc-form", onSubmit: save },
    h("div", { class: "acc-who" }, h("b", {}, acc.name), h("span", { class: "meta" }, acc.email ?? "—")),
    h("label", { class: "field acc-phone" }, h("span", {}, t("phone")), phone, h("span", { class: "meta acc-help" }, t("phoneHelp"))),
    h("div", { class: "acc-pair" }, h("div", { class: "field" }, h("span", {}, t("language")), lang), h("div", { class: "field" }, h("span", {}, t("notifyBy")), channel)),
    fold(t("installTitle"), installControls()),
    fold(t("pushTitle"), pushControls()),
    h("div", { class: "field push-field" }, h("span", {}, t("remindersTitle")), reminders),
    h("div", { class: "acc-actions" }, h("button", { class: "btn primary", type: "submit" }, t("save")),
      h("button", { class: "btn", type: "button", onClick: async () => { await api("/auth/logout", { method: "POST" }).catch(() => {}); state.me = null; renderLogin(); } }, t("logout"))));
  const securityBox = () => {
    const box = h("div", { class: "acc-content" }, h("p", { class: "meta" }, t("loading")));
    const draw = async () => {
      let info;
      try { info = await api("/account/security"); } catch (e) { box.replaceChildren(h("p", { class: "meta" }, t("genericError"))); return; }
      const when = (ms) => new Date(ms).toLocaleDateString(getLang() === "en" ? "en-CA" : "fr-CA");
      const keys = info.passkeys.length ? info.passkeys.map((k) => h("div", { class: "pk-row" },
        h("div", {}, h("b", {}, k.name || "—"), h("div", { class: "meta" }, `${t("secLastUsed")} : ${k.last_used_at ? `${when(k.last_used_at)}${k.last_used_device ? ` · ${k.last_used_device}` : ""}` : t("secNeverUsed")}`)),
        h("button", { class: "btn danger", type: "button", onClick: async () => { if (await ask(t("secRemoveConfirm"))) { await api(`/account/passkeys/${encodeURIComponent(k.id)}`, { method: "DELETE" }); toast(t("secPasskeyRemoved")); draw(); } } }, t("secRemove"))))
        : [h("p", { class: "meta" }, t("secNoPasskeys"))];
      const add = passkeysSupported()
        ? h("button", { class: "btn primary", type: "button", onClick: async () => {
            try { await registerPasskey(); toast(t("secPasskeyAdded")); draw(); }
            catch (err) { toast(err?.body?.error === "too_many_passkeys" ? t("secPasskeyTooMany") : err?.name === "InvalidStateError" ? t("secPasskeyAlready") : t("secPasskeyCancelled")); }
          } }, t("secAddPasskey"))
        : h("p", { class: "meta" }, t("secPasskeyUnsupported"));
      const cur = h("input", { type: "password", autocomplete: "current-password", maxLength: 200 });
      const pw1 = h("input", { type: "password", autocomplete: "new-password", minLength: 10, maxLength: 200, required: true });
      const pw2 = h("input", { type: "password", autocomplete: "new-password", minLength: 10, maxLength: 200, required: true });
      const pwForm = h("form", { class: "acc-form", onSubmit: async (e) => {
        e.preventDefault();
        if (pw1.value !== pw2.value) { toast(t("secPasswordMismatch")); return; }
        try { await api("/account/password", { method: "PUT", body: { password: pw1.value, current: info.has_password ? cur.value : undefined } }); toast(t("secPasswordSaved")); draw(); }
        catch (err) { const k = err?.body?.error; toast(k === "wrong_current_password" ? t("secWrongCurrent") : k === "too_short" ? t("secTooShort") : k === "too_common" ? t("secTooCommon") : k === "too_long" ? t("secTooLong") : errorText(err)); }
      } },
        ...(info.has_password ? [h("label", { class: "field" }, h("span", {}, t("secPasswordCurrent")), cur)] : []),
        h("label", { class: "field" }, h("span", {}, t("secPasswordNew")), pw1), h("label", { class: "field" }, h("span", {}, t("secPasswordConfirm")), pw2),
        h("button", { class: "btn primary", type: "submit" }, info.has_password ? t("secChangePassword") : t("secSetPassword")));
      const ago = (ms) => new Date(ms).toLocaleString(getLang() === "en" ? "en-CA" : "fr-CA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      const icon = (x) => (/iPhone|Android|iPad|Samsung|Pixel/.test(x.device ?? "") ? "📱" : "💻");
      const sessions = (info.sessions ?? []).map((x) => h("div", { class: `pk-row dev-row ${x.current ? "current" : ""}` },
        h("div", {}, h("b", {}, `${icon(x)} ${x.device || t("secUnknownDevice")}${x.browser ? ` · ${x.browser}` : ""}`), x.current ? h("span", { class: "badge" }, t("secThisDevice")) : null, x.standalone ? h("span", { class: "badge" }, `📲 ${t("secInstalledApp")}`) : null,
          h("div", { class: "meta" }, `${t("secSignedBy")} ${t(`secMethod_${x.method ?? "code"}`)} · ${t("secLastActivity")} : ${ago(x.last_seen_at)}`)),
        x.current ? null : h("button", { class: "btn danger", type: "button", onClick: async () => { if (await ask(t("secSignOutConfirm"))) { try { await api(`/account/sessions/${x.id}`, { method: "DELETE" }); toast(t("secSignedOut")); draw(); } catch (e) { toast(errorText(e)); } } } }, t("secSignOut"))));
      box.replaceChildren(
        fold(`${t("secDevices")} (${sessions.length})`, [h("p", { class: "meta acc-help" }, t("secDevicesHelp")), ...sessions,
          sessions.length > 1 ? h("button", { class: "btn", type: "button", onClick: async () => { if (await ask(t("secSignOutOthersConfirm"))) { try { const r = await api("/account/sessions/sign-out-others", { method: "POST" }); toast(`${r.signed_out} ${t("secSignedOutN")}`); draw(); } catch (e) { toast(errorText(e)); } } } }, t("secSignOutOthers")) : null]),
        fold(t("secPasskeys"), [h("p", { class: "meta acc-help" }, t("secPasskeysHelp")), h("p", { class: "meta acc-help" }, t("secSyncedHint")), ...keys, add]),
        fold(t("secPassword"), [h("p", { class: "meta" }, info.has_password ? t("secPasswordSet") : t("secPasswordNone")), h("p", { class: "meta acc-help" }, t("secPasswordHelp")), pwForm,
          ...(info.has_password ? [h("button", { class: "btn danger", type: "button", onClick: async () => { if (await ask(t("secRemovePasswordConfirm"))) { await api("/account/password", { method: "DELETE" }); toast(t("secPasswordRemoved")); draw(); } } }, t("secRemovePassword"))] : [])]));
    };
    draw();
    return box;
  };
  const tabs = [
    ["profile", t("details"), () => [profile]],
    ["daysoff", t("tabDaysOff"), () => [availabilityEditor(state.me.me.id, "daysoff")]],
    ["availability", t("tabAvailability"), () => [availabilityEditor(state.me.me.id, "times")]],
    ["timeoff", t("timeOff"), () => { const box = h("div", { class: "acc-content" }, h("p", { class: "meta" }, t("loading"))); timeOffNodes().then((n) => box.replaceChildren(...n)).catch((e) => box.replaceChildren(h("p", { class: "meta" }, errorText(e)))); return [box]; }],
    ["calendar", t("tabCalendar"), () => [h("p", { class: "meta" }, t("calendarHelp")), calBox]],
    ["payslips", t("tabPayslips"), () => { loadSlips(); return [slipsBox]; }],
    ["security", t("tabSecurity"), () => [securityBox()]],
  ];
  state.accountTab = tabs.some(([id]) => id === state.accountTab) ? state.accountTab : "profile";
  const bar = h("div", { class: "dlg-tabs acc-tabs", role: "tablist" });
  const content = h("div", { class: "acc-content" });
  const draw = () => {
    bar.replaceChildren(...tabs.map(([id, label]) => h("button", { type: "button", role: "tab", title: label, "aria-label": label, "aria-selected": String(state.accountTab === id), onClick: () => { state.accountTab = id; draw(); } },
      h("span", { class: "tab-ic", "aria-hidden": "true" }, ACCOUNT_TAB_ICONS[id] ?? "•"), h("span", { class: "tab-tx" }, label))));
    content.replaceChildren(...tabs.find(([id]) => id === state.accountTab)[2]());
  };
  draw();
  $app.replaceChildren(h("div", { class: "account acc-screen" }, h("h2", {}, t("account")), bar, content));
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
              h("span", { class: "meta" }, [`${roleIcon(s)} ${roleName(s)}`, s.notes].filter(Boolean).join(" · ")), s.status === "sick_open" ? h("span", { class: "sick-badge" }, `🚫 ${t("sickOpen")}`) : null,
              // the people working with me during this shift
              s.colleagues?.length ? h("div", { class: "mine-with" },
                // my own department first ("Avec toi"), then each other department under its own label
                [...new Set(s.colleagues.map((c) => c.department_id))].sort((x, y) => (x === s.department_id ? -1 : y === s.department_id ? 1 : DEPTS.indexOf(x) - DEPTS.indexOf(y))).map((dept) =>
                  h("div", { class: "mine-dept" }, h("span", { class: `mine-dept-name ${dept === s.department_id ? "team" : ""}` }, dept === s.department_id ? `👥 ${t("workingWith")}` : t(`where.${dept}`)),
                    h("div", { class: "mine-people" }, s.colleagues.filter((c) => c.department_id === dept).map((c) => h("span", { class: "mine-person", title: `${c.name} · ${hhmm(c.start_at)}–${c.until_close ? "F" : hhmm(c.end_at)}` }, avatar(c.staff_id, c.name, c.color, c.photo_v, 20), h("b", {}, c.first_name || c.name), h("small", {}, `${hhmm(c.start_at)}–${c.until_close ? "F" : hhmm(c.end_at)}`))))))) : null),
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
      h("div", { class: "log-row" }, h("span", { class: "meta" }, `${new Date(r.created_at).toLocaleString(locale(), { dateStyle: "short", timeStyle: "short", hourCycle: "h23" })} · ${r.channel.toUpperCase()} · ${r.kind}`),
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
  const when = (ms) => new Date(ms).toLocaleString(getLang() === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short", hourCycle: "h23" });
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
  const when = (ms) => new Date(ms).toLocaleString(getLang() === "fr" ? "fr-CA" : "en-CA", { dateStyle: "medium", timeStyle: "short", hourCycle: "h23" });
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

// Administration: extra people the assisted calls can reach (suppliers, repairers...) besides the team.
function voiceContactsPanel() {
  const box = h("section", { class: "panel" });
  async function load() {
    const list = await api("/admin/voice-contacts");
    const form = (c) => {
      const name = h("input", { value: c?.name ?? "", maxLength: 80, required: true, placeholder: t("vcName") });
      const label = h("input", { value: c?.label ?? "", maxLength: 60, placeholder: t("vcLabelEx") });
      const phone = h("input", { type: "tel", value: formatPhone(c?.phone), required: true, autocomplete: "off", placeholder: "+1 (514) 953-6985" }); phone.addEventListener("blur", () => { phone.value = formatPhone(phone.value); });
      const lang = h("select", {}, [["fr", "Français"], ["en", "English"]].map(([v, l]) => h("option", { value: v, selected: (c?.lang ?? "fr") === v }, l)));
      const notes = h("input", { value: c?.notes ?? "", maxLength: 300, placeholder: t("vcNotes") });
      return { name, label, phone, lang, notes, body: () => ({ name: name.value, label: label.value, phone: phone.value, lang: lang.value, notes: notes.value }) };
    };
    const editor = (c) => {
      const f = form(c);
      return h("form", { class: "vc-admin-form", onSubmit: async (e) => { e.preventDefault(); try { await api(c ? `/admin/voice-contacts/${c.id}` : "/admin/voice-contacts", { method: c ? "PUT" : "POST", body: f.body() }); load(); } catch (err) { toast(err.body?.error === "invalid_phone" ? t("vcBadPhone") : errorText(err)); } } },
        f.name, f.label, f.phone, f.lang, f.notes, h("button", { class: "btn primary", type: "submit" }, c ? t("save") : t("add")),
        c ? h("button", { class: "btn", type: "button", onClick: () => load() }, t("cancel")) : null);
    };
    box.replaceChildren(h("h2", {}, `📞 ${t("adminContacts")}`), h("p", { class: "meta" }, t("vcHelp")),
      ...list.map((c) => h("div", { class: "card vc-admin-row" }, h("div", {}, h("strong", {}, c.name), c.label ? h("span", { class: "meta" }, ` · ${c.label}`) : null, h("div", { class: "meta" }, `${formatPhone(c.phone)} · ${c.lang.toUpperCase()}${c.notes ? ` · ${c.notes}` : ""}`)),
        h("div", { class: "actions" },
          h("button", { class: "btn", type: "button", onClick: (e) => e.currentTarget.closest(".vc-admin-row").replaceChildren(editor(c)) }, t("edit")),
          h("button", { class: "btn danger", type: "button", onClick: async () => { if (await confirmDialog({ title: t("delete"), message: t("vcDelete").replace("{name}", c.name), yes: t("delete"), no: t("cancel") })) { await api(`/admin/voice-contacts/${c.id}`, { method: "DELETE" }); load(); } } }, t("delete"))))),
      h("h3", {}, t("vcAdd")), h("div", { class: "card" }, editor(null)));
  }
  load().catch((e) => box.replaceChildren(h("p", { class: "meta" }, errorText(e))));
  return box;
}

// Administration -> Products: what the customers buy. Formats (sizes) with a price, and the ingredients (with quantities) of each format.
function productsPanel() {
  const box = h("section", { class: "panel products" });
  const st = { list: [], names: [], q: "", filter: "all" };
  const UNITS = ["g", "kg", "ml", "L", "oz", "lb", "unité", "tranche", "portion", "tasse", "c. à soupe", "c. à thé"];
  const money = (n) => (n === null || n === undefined ? "" : `${Number(n).toFixed(2).replace(".", getLang() === "fr" ? "," : ".")} $`);
  const period = (p) => (p.available_from || p.available_to ? `${p.available_from ? fmt(p.available_from, { day: "numeric", month: "short", year: "numeric" }) : "…"} → ${p.available_to ? fmt(p.available_to, { day: "numeric", month: "short", year: "numeric" }) : "…"}` : "");
  async function load() {
    [st.list, st.names] = await Promise.all([api("/admin/products"), api("/admin/ingredient-names")]);
    draw();
  }
  function draw() {
    const q = st.q.trim().toLowerCase();
    const list = st.list.filter((p) => (st.filter === "all" || (st.filter === "promo" ? p.is_promo : st.filter === "inactive" ? !p.active : p.active))
      && (!q || p.name_fr.toLowerCase().includes(q) || (p.name_en ?? "").toLowerCase().includes(q) || (p.category ?? "").toLowerCase().includes(q) || p.formats.some((f) => f.ingredients.some((i) => i.ingredient.toLowerCase().includes(q)))));
    const cats = [...new Set(list.map((p) => p.category ?? ""))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, getLang())));
    const filters = [["all", t("prodAll")], ["promo", `🏷️ ${t("prodPromos")}`], ["active", t("prodActive")], ["inactive", t("prodInactive")]];
    box.replaceChildren(h("h2", {}, `🛍️ ${t("adminProducts")}`), h("p", { class: "meta" }, t("prodHelp")),
      h("div", { class: "ing-add" }, h("button", { class: "btn primary", type: "button", onClick: () => productDialog(null) }, `+ ${t("prodAdd")}`), h("button", { class: "btn", type: "button", onClick: importDialog }, `⬆ ${t("prodImport")}`),
        h("input", { type: "search", value: st.q, placeholder: t("prodSearch"), "aria-label": t("prodSearch"), onInput: (e) => { st.q = e.target.value; clearTimeout(st.t); st.t = setTimeout(() => { draw(); box.querySelector("input[type=search]")?.focus(); }, 250); } })),
      h("div", { class: "chip-row", role: "group" }, filters.map(([id, label]) => h("button", { type: "button", class: `chip-btn${st.filter === id ? " on" : ""}`, "aria-pressed": String(st.filter === id), onClick: () => { st.filter = id; draw(); } }, label))),
      ...(list.length ? cats.flatMap((cat) => [h("h3", { class: "restock-title" }, `${cat || t("prodNoCategory")} · ${list.filter((p) => (p.category ?? "") === cat).length}`),
        ...list.filter((p) => (p.category ?? "") === cat).map((p) => h("div", { class: `card prod-card${p.active ? "" : " inactive"}` },
          h("div", { class: "prod-head" }, h("b", {}, p.name_fr), p.name_en ? h("small", { class: "meta" }, ` · ${p.name_en}`) : null,
            p.is_promo ? h("span", { class: `prod-promo ${p.availability}` }, `🏷️ ${t("prodPromo")}`) : null,
            p.availability !== "always" ? h("span", { class: `prod-period ${p.availability}` }, `${period(p)}${p.availability === "upcoming" ? ` · ${t("prodUpcoming")}` : p.availability === "expired" ? ` · ${t("prodExpired")}` : ""}`) : null,
            !p.active ? h("span", { class: "ing-badge" }, t("prodInactive")) : null,
            h("button", { class: "btn small", type: "button", onClick: () => productDialog(p) }, `✎ ${t("editWord")}`)),
          p.description ? h("p", { class: "meta" }, p.description) : null,
          h("div", { class: "prod-formats" }, p.formats.map((f) => h("details", { class: "prod-format" }, h("summary", {}, h("b", {}, f.name || t("prodStandard")), f.price ? ` · ${money(f.price)}` : "", h("small", { class: "meta" }, ` · ${f.ingredients.length} ${t("prodIngredientsWord")}`)),
            f.ingredients.length ? h("ul", { class: "prod-ings" }, f.ingredients.map((i) => h("li", { class: st.names.some((n) => n.name.toLowerCase() === i.ingredient.toLowerCase()) ? "" : "unknown" }, i.ingredient, h("small", { class: "meta" }, `${i.qty ? ` — ${i.qty}${i.unit ? ` ${i.unit}` : ""}` : ""}${i.note ? ` (${i.note})` : ""}`)))) : h("p", { class: "meta" }, t("prodNoIngredients")))))))]) : [h("p", { class: "meta" }, t("prodNone"))]));
  }
  // ---- one product ----
  function productDialog(p) {
    let dlg = document.getElementById("product-modal");
    if (!dlg) { dlg = h("dialog", { id: "product-modal", class: "wide" }); document.body.append(dlg); }
    const cur = p ? JSON.parse(JSON.stringify(p)) : { name_fr: "", name_en: "", category: "", description: "", code: "", active: true, is_promo: false, available_from: null, available_to: null, formats: [{ name: "", price: null, ingredients: [] }] };
    const f = (label, el) => h("label", { class: "field" }, h("span", {}, label), el);
    const name = h("input", { value: cur.name_fr, maxLength: 80, "aria-label": t("prodNameFr") }), nameEn = h("input", { value: cur.name_en ?? "", maxLength: 80, "aria-label": t("prodNameEn") });
    const cat = h("input", { value: cur.category ?? "", maxLength: 40, list: "prod-cats", "aria-label": t("prodCategory") });
    const code = h("input", { value: cur.code ?? "", maxLength: 30, "aria-label": t("prodCode") }), desc = h("textarea", { rows: 2, maxLength: 300, "aria-label": t("prodDescription") }, cur.description ?? "");
    const active = h("input", { type: "checkbox", checked: cur.active });
    const promo = h("input", { type: "checkbox", checked: cur.is_promo });
    const from = h("input", { type: "date", value: cur.available_from ?? "" }), to = h("input", { type: "date", value: cur.available_to ?? "" });
    const err = h("p", { class: "form-error", role: "alert", hidden: true });
    const fmtBox = h("div", { class: "prod-fmts" });
    const drawFormats = () => fmtBox.replaceChildren(...cur.formats.map((fm, fi) => {
      const lines = h("div", { class: "prod-lines" });
      const drawLines = () => lines.replaceChildren(...fm.ingredients.map((l, li) => {
        const unknown = l.ingredient && !st.names.some((n) => n.name.toLowerCase() === l.ingredient.toLowerCase());
        const ing = h("input", { value: l.ingredient, list: "prod-ings", maxLength: 80, placeholder: t("prodIngredient"), "aria-label": t("prodIngredient"), onInput: (e) => { l.ingredient = e.target.value; ing.classList.toggle("unknown", !!l.ingredient && !st.names.some((n) => n.name.toLowerCase() === l.ingredient.toLowerCase())); } });
        ing.classList.toggle("unknown", !!unknown);
        return h("div", { class: "prod-line" }, ing,
          h("input", { type: "number", min: "0", step: "any", inputmode: "decimal", value: l.qty ?? "", placeholder: t("prodQty"), "aria-label": t("prodQty"), onInput: (e) => { l.qty = e.target.value === "" ? null : Number(e.target.value); } }),
          h("input", { value: l.unit ?? "", list: "prod-units", maxLength: 20, placeholder: t("prodUnit"), "aria-label": t("prodUnit"), onInput: (e) => { l.unit = e.target.value; } }),
          h("input", { value: l.note ?? "", maxLength: 80, placeholder: t("prodLineNote"), "aria-label": t("prodLineNote"), onInput: (e) => { l.note = e.target.value; } }),
          h("button", { type: "button", class: "icon-btn", "aria-label": t("delete"), onClick: () => { fm.ingredients.splice(li, 1); drawLines(); } }, "✕"));
      }));
      drawLines();
      return h("div", { class: "card prod-fmt" },
        h("div", { class: "prod-fmt-head" }, f(t("prodFormatName"), h("input", { value: fm.name, maxLength: 40, placeholder: t("prodFormatPh"), onInput: (e) => { fm.name = e.target.value; } })),
          f(t("prodPrice"), h("input", { type: "number", min: "0", step: "0.01", inputmode: "decimal", value: fm.price ?? "", placeholder: "0.00", onInput: (e) => { fm.price = e.target.value === "" ? null : Number(e.target.value); } }))),
        h("div", { class: "prod-line prod-line-head meta" }, h("span", {}, t("prodIngredient")), h("span", {}, t("prodQty")), h("span", {}, t("prodUnit")), h("span", {}, t("prodLineNote")), h("span", {})),
        lines,
        h("div", { class: "actions prod-fmt-actions" },
          h("button", { type: "button", class: "btn small", onClick: () => { fm.ingredients.push({ ingredient: "", qty: null, unit: "", note: "" }); drawLines(); lines.querySelector(".prod-line:last-child input")?.focus(); } }, `+ ${t("prodAddIngredient")}`),
          h("button", { type: "button", class: "btn small", onClick: () => { cur.formats.splice(fi + 1, 0, { name: "", price: null, ingredients: JSON.parse(JSON.stringify(fm.ingredients)) }); drawFormats(); } }, t("prodDuplicateFormat")),
          cur.formats.length > 1 ? h("button", { type: "button", class: "btn small danger", onClick: () => { cur.formats.splice(fi, 1); drawFormats(); } }, t("prodRemoveFormat")) : null));
    }));
    drawFormats();
    const body = () => ({ name_fr: name.value, name_en: nameEn.value, category: cat.value, description: desc.value, code: code.value, active: active.checked, is_promo: promo.checked, available_from: from.value || null, available_to: to.value || null, formats: cur.formats });
    const close = () => dlg.close();
    dlg.replaceChildren(h("form", { class: "modal-body prod-dialog", onSubmit: async (e) => {
        e.preventDefault(); err.hidden = true;
        try { await api(p ? `/admin/products/${p.id}` : "/admin/products", { method: p ? "PUT" : "POST", body: body() }); toast(t("saved")); close(); load(); }
        catch (x) { const k = x.body?.error; err.textContent = `⚠ ${t(`prodErr_${k}`) !== `prodErr_${k}` ? t(`prodErr_${k}`) : errorText(x)}`; err.hidden = false; err.scrollIntoView({ block: "nearest" }); }
      } },
      h("h2", {}, p ? p.name_fr : t("prodAdd")), err,
      h("datalist", { id: "prod-cats" }, [...new Set(st.list.map((x) => x.category).filter(Boolean))].map((c) => h("option", { value: c }))),
      h("datalist", { id: "prod-ings" }, st.names.map((n) => h("option", { value: n.name }, n.homemade ? `🏠 ${t("mixIsMix")}` : ""))),
      h("datalist", { id: "prod-units" }, UNITS.map((u) => h("option", { value: u }))),
      h("div", { class: "ing-two" }, f(t("prodNameFr"), name), f(t("prodNameEn"), nameEn)),
      h("div", { class: "ing-two" }, f(t("prodCategory"), cat), f(t("prodCode"), code)),
      f(t("prodDescription"), desc),
      h("label", { class: "check" }, active, h("span", {}, t("prodActiveLabel"))),
      h("div", { class: "card prod-promo-box" }, h("label", { class: "check" }, promo, h("span", {}, `🏷️ ${t("prodIsPromo")}`)), h("p", { class: "meta" }, t("prodPeriodHelp")), h("div", { class: "ing-two" }, f(t("prodFrom"), from), f(t("prodTo"), to))),
      h("h3", {}, t("prodFormats")), h("p", { class: "meta" }, t("prodFormatsHelp")), fmtBox,
      h("button", { type: "button", class: "btn", onClick: () => { cur.formats.push({ name: "", price: null, ingredients: [] }); drawFormats(); } }, `+ ${t("prodAddFormat")}`),
      h("div", { class: "actions" },
        p ? h("button", { class: "btn danger", type: "button", onClick: async () => { if (!(await ask(t("prodDeleteConfirm").replace("{n}", p.name_fr)))) return; try { await api(`/admin/products/${p.id}`, { method: "DELETE" }); toast(t("saved")); close(); load(); } catch (x) { toast(errorText(x)); } } }, t("delete")) : null,
        h("button", { class: "btn", type: "button", onClick: close }, t("cancel")), h("button", { class: "btn primary", type: "submit" }, t("save")))));
    dlg.showModal();
  }
  // ---- import (a JSON list of products, e.g. read from menu photos) ----
  function importDialog() {
    let dlg = document.getElementById("product-import-modal");
    if (!dlg) { dlg = h("dialog", { id: "product-import-modal", class: "wide" }); document.body.append(dlg); }
    const ta = h("textarea", { rows: 12, spellcheck: false, placeholder: '{ "products": [ { "name_fr": "Pizza pepperoni", "category": "Pizzas", "formats": [ { "name": "10 po", "price": 12.99, "ingredients": [ { "ingredient": "Fromage", "qty": 120, "unit": "g" } ] } ] } ] }' });
    const upd = h("input", { type: "checkbox", checked: true }), out = h("p", { class: "meta" });
    dlg.replaceChildren(h("form", { class: "modal-body", onSubmit: async (e) => {
        e.preventDefault(); out.textContent = "";
        let data; try { data = JSON.parse(ta.value); } catch { out.textContent = `⚠ ${t("prodImportBad")}`; return; }
        try { const r = await api("/admin/products/import", { method: "POST", body: { products: Array.isArray(data) ? data : data.products, update: upd.checked } }); out.textContent = `✅ ${r.created} ${t("prodImportCreated")}, ${r.updated} ${t("prodImportUpdated")}${r.skipped ? `, ${r.skipped} ${t("prodImportSkipped")}` : ""}`; load(); }
        catch (x) { out.textContent = `⚠ ${x.body?.errors?.length ? x.body.errors.map((z) => `#${z.index + 1}: ${z.error}`).join(", ") : errorText(x)}`; }
      } }, h("h2", {}, `⬆ ${t("prodImport")}`), h("p", { class: "meta" }, t("prodImportHelp")), h("label", { class: "field" }, h("span", {}, t("prodImportFile")), h("input", { type: "file", accept: ".json,application/json", onChange: async (e) => { const f = e.target.files[0]; if (f) ta.value = await f.text(); } })), ta, h("label", { class: "check" }, upd, h("span", {}, t("prodImportUpdate"))), out,
      h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: () => dlg.close() }, t("close")), h("button", { class: "btn primary", type: "submit" }, t("prodImportGo")))));
    dlg.showModal();
  }
  load().catch((e) => box.replaceChildren(h("p", { class: "meta" }, errorText(e))));
  return box;
}

const ADMIN_SECTIONS_MARK = 0;
const ADMIN_SECTIONS = [["restaurants", "adminRestaurants"], ["vehicles", "adminVehicles"], ["contacts", "adminContacts"], ["staff", "adminStaff"], ["timeoff", "adminTimeOff"], ["payslips", "adminPayslips"], ["incidents", "adminIncidents"], ["communities", "adminCommunities"], ["checklists", "adminChecklists"], ["ingredients", "adminIngredients"], ["products", "adminProducts"], ["targets", "adminTargets"], ["autoschedule", "adminAutoSchedule"], ["messaging", "adminMessaging"], ["usage", "adminUsage"], ["branding", "adminBranding"], ["api", "adminApi"]];
const ADMIN_ICONS = { contacts: "📞", vehicles: "🚗", autoschedule: "🌙", restaurants: "🏪", staff: "👥", timeoff: "🌴", payslips: "💵", incidents: "⚠️", communities: "🏘️", checklists: "✅", ingredients: "🥬", products: "🛍️", targets: "🎯", messaging: "✉️", usage: "💰", branding: "🎨", api: "🔌", clients: "🏢" };
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
    checklists: () => [checklistsPanel(), postPeriodsPanel()],
    ingredients: () => [ingredientsPanel()],
    products: () => [productsPanel()],
    usage: () => [usagePanel()],
    autoschedule: () => [autoSchedulePanel()],
    vehicles: () => [vehiclesAdminPanel()],
    contacts: () => [voiceContactsPanel()],
    timeoff: () => { const box = h("div", {}, h("p", { class: "meta" }, t("loading"))); timeOffNodes("review").then((n) => box.replaceChildren(...n)).catch((e) => box.replaceChildren(h("p", { class: "meta" }, errorText(e)))); return [box]; },
  };
  // the menu in groups, like an accordion: Personnel (people) and Restaurants (the places and what they use); opening one closes the other
  const labelOf = Object.fromEntries(ADMIN_SECTIONS);
  const groups = [["staffGroup", "adminGroupStaff", ["staff", "timeoff", "payslips", "incidents", "communities", "targets", "autoschedule", "checklists"]], ["restaurantsGroup", "adminGroupRestaurants", ["restaurants", "vehicles", "contacts", "messaging", "ingredients", "products", "usage", "branding", "api"]], ...(state.me.me.is_super ? [["platformGroup", "adminGroupPlatform", ["clients"]]] : [])];
  const current = adminSectionOf();
  // first time (or when the open group does not hold the section being shown): open the group of the current section
  if (state.adminGroup === undefined) state.adminGroup = groups.find(([, , ids]) => ids.includes(current))?.[0] ?? groups[0][0];
  const nav = h("nav", { class: "admin-nav", "aria-label": t("admin") });
  const paintGroups = () => nav.querySelectorAll(".admin-group").forEach((el) => { const open = el.dataset.group === state.adminGroup; el.classList.toggle("open", open); el.querySelector(".admin-group-title").setAttribute("aria-expanded", String(open)); });
  nav.append(...groups.map(([gid, title, ids]) => h("div", { class: "admin-group", "data-group": gid },
    h("button", { type: "button", class: "admin-group-title", "aria-expanded": "false", onClick: () => { state.adminGroup = state.adminGroup === gid ? null : gid; paintGroups(); } }, h("span", {}, t(title)), h("span", { class: "admin-chevron", "aria-hidden": "true" }, "▾")),
    h("div", { class: "admin-group-items", role: "group", "aria-label": t(title) }, ids.map((id) => { const label = labelOf[id] ?? "adminClients";
      return h("button", { type: "button", "aria-label": t(label), title: t(label), "aria-current": current === id ? "page" : false, onClick: () => { state.adminGroup = gid; state.adminSection = id; render(); } },
        h("span", { class: "tab-ic", "aria-hidden": "true" }, ADMIN_ICONS[id] ?? "•"), h("span", { class: "tab-tx" }, t(label))); })))));
  paintGroups();
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
    const tr = await api("/admin/community-transcripts").catch(() => ({ all: false, ai_available: false }));
    const dm = await api("/admin/messages-settings").catch(() => null);
    const dmCard = () => {
      if (!dm) return null;
      const scope = radioGroup("dm-scope", [["department", t("dmScopeDepartment")], ["restaurant", t("dmScopeRestaurant")], ["all", t("dmScopeAll")]], dm.scope);
      const groups = radioGroup("dm-groups", [["all", t("dmGroupsAll")], ["managers", t("dmGroupsMgr")], ["off", t("dmGroupsNone")]], dm.groups);
      const max = h("input", { type: "number", min: 3, max: 50, value: dm.max_group, inputMode: "numeric", style: "max-width:6rem", "aria-label": t("dmMaxGroup") });
      return h("form", { class: "card dm-settings", onSubmit: async (e) => {
        e.preventDefault();
        try { await api("/admin/messages-settings", { method: "PUT", body: { scope: scope.value, groups: groups.value, max_group: Number(max.value) } }); toast(t("saved")); } catch (err) { toast(err.body?.field === "max_group" ? t("dmMaxGroupBad") : errorText(err)); }
      } }, h("h3", {}, `💬 ${t("dmSettings")}`), h("p", { class: "meta" }, t("dmSettingsHelp")),
        h("div", { class: "field" }, h("span", {}, t("dmScope")), scope, h("span", { class: "meta" }, t("dmScopeHelp"))),
        h("div", { class: "field" }, h("span", {}, t("dmGroups")), groups), h("label", { class: "field" }, h("span", {}, t("dmMaxGroup")), max),
        h("button", { class: "btn primary", type: "submit" }, t("save")));
    };
    box.replaceChildren(h("h2", {}, t("adminCommunities")), h("p", { class: "meta" }, t("communitiesHelp")), dmCard(),
      h("div", { class: "card tr-setting" }, h("label", { class: "check" }, h("input", { type: "checkbox", checked: tr.all, onChange: async (e) => { const want = e.target.checked; try { await api("/admin/community-transcripts", { method: "PUT", body: { all: want } }); toast(t("saved")); } catch (err) { e.target.checked = !want; toast(errorText(err)); } } }), h("span", {}, `📝 ${t("transcriptAllLabel")}`)),
        h("p", { class: "meta" }, t("transcriptAllHelp")), tr.ai_available ? null : h("p", { class: "meta" }, `⚠ ${t("transcriptNoAi")}`)),
      ...ov.restaurants.map((r) => h("div", { class: "comm-resto" }, h("h3", {}, r.name), ...rows.filter((c) => c.restaurant_id === r.id).map(rowFor), addFor(r))));
  }
  load().catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
  return box;
}
const COMM_DEPTS = ["floor", "kitchen", "prep", "delivery", "admin"];

// Admin preview of a list, as the employee sees it (the boxes are not saved).
function previewChecklist(title, items, role) {
  let dlg = document.getElementById("preview-modal");
  if (!dlg) { dlg = h("dialog", { id: "preview-modal" }); document.body.append(dlg); }
  const lang = getLang();
  dlg.replaceChildren(h("div", { class: "modal-body" }, h("h2", {}, title),
    h("p", { class: "meta" }, role ? t("checklistPreviewRole") : t("checklistPreviewPost")),
    ...items.map((it) => h("label", { class: "check cl-item" }, h("input", { type: "checkbox" }), h("span", {}, (lang === "en" ? it.text_en || it.text_fr : it.text_fr) + (it.last_out ? ` · ${t("checklistLastOutTag")}` : "")))),
    h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onClick: () => dlg.close() }, t("close")))));
  dlg.showModal();
}

// Administration: the end-of-shift lists (per kitchen post and per role) and who did theirs.
// Administration → Coûts: what Claude and Twilio cost, per month.
// ---------- Automatic schedules (created overnight) ----------
function autoSchedulePanel() {
  const box = h("section", { class: "panel auto-panel" });
  let timer = null;
  const dayName = (i) => new Date(Date.UTC(2026, 10, 1 + i)).toLocaleDateString(locale(), { weekday: "long", timeZone: "UTC" });
  const hourLabel = (hh) => (getLang() === "en" ? `${hh % 12 || 12} ${hh < 12 ? "AM" : "PM"}` : `${hh} h`);
  const select = (options, value, label) => h("select", { "aria-label": label }, options.map(([v, l]) => h("option", { value: v, selected: String(v) === String(value) }, l)));
  const weekLabel = (w) => new Date(`${w}T12:00:00Z`).toLocaleDateString(locale(), { day: "numeric", month: "long", timeZone: "UTC" });
  // restaurants x departments, each box ticked when included; value() is null when everything is ticked
  const scopeMatrix = (d, initial) => {
    const on = (rid, dep) => initial === null || initial.includes(`${rid}:${dep}`);
    const boxes = [];
    const rows = d.restaurants.map((r) => h("tr", {}, h("th", { scope: "row" }, r.name), d.departments.map((dep) => {
      const cb = h("input", { type: "checkbox", checked: on(r.id, dep), "aria-label": `${r.name} · ${t(`dept.${dep}`)}` }); boxes.push([`${r.id}:${dep}`, cb]);
      return h("td", {}, cb); })));
    return { node: h("div", { class: "auto-scope-wrap" }, h("table", { class: "auto-scope" }, h("thead", {}, h("tr", {}, h("th"), d.departments.map((dep) => h("th", {}, t(`dept.${dep}`))))), h("tbody", {}, rows))),
      value: () => (boxes.every(([, cb]) => cb.checked) ? null : boxes.filter(([, cb]) => cb.checked).map(([k]) => k)) };
  };
  async function load() {
    const d = await api("/admin/auto-schedule");
    const s = d.settings;
    const enabled = h("input", { type: "checkbox", checked: s.enabled });
    const dow = select([0, 1, 2, 3, 4, 5, 6].map((i) => [i, dayName(i)]), s.dow, t("autoDay"));
    const hour = select(Array.from({ length: 24 }, (_, i) => [i, hourLabel(i)]), s.hour, t("autoHour"));
    const nHour = select(Array.from({ length: 24 }, (_, i) => [i, hourLabel(i)]), s.notify_hour, t("autoNoticeHour"));
    const email = h("input", { type: "checkbox", checked: s.email }), sms = h("input", { type: "checkbox", checked: s.sms });
    const extra = h("textarea", { rows: 3, maxLength: 2000, placeholder: t("autoExtraPh") }, s.extra);
    const matrix = scopeMatrix(d, s.scope);
    const picks = d.candidates.map((p) => [p, h("input", { type: "checkbox", checked: d.recipients_now.includes(p.id), "aria-label": p.name })]);
    // reminders while the schedules are still not published
    const rOn = h("input", { type: "checkbox", checked: s.reminders });
    const rDays = Array.from({ length: 7 }, (_, i) => [i + 1, h("input", { type: "checkbox", checked: s.reminder_days.includes(i + 1), "aria-label": `+${i + 1}` })]);
    const rHour = select(Array.from({ length: 24 }, (_, i) => [i, hourLabel(i)]), s.reminder_hour, t("autoRemindHour"));
    const rEmail = h("input", { type: "checkbox", checked: s.r_email }), rSms = h("input", { type: "checkbox", checked: s.r_sms });
    const sameCb = h("input", { type: "checkbox", checked: s.reminder_recipients === null });
    const rPicks = d.candidates.map((p) => [p, h("input", { type: "checkbox", checked: (s.reminder_recipients ?? d.recipients_now).includes(p.id), disabled: s.reminder_recipients === null, "aria-label": p.name })]);
    sameCb.addEventListener("change", () => rPicks.forEach(([, cb]) => { cb.disabled = sameCb.checked; }));
    const when = h("p", { class: "meta auto-when" });
    const paintWhen = () => {
      const sameDay = Number(nHour.value) > Number(hour.value);
      when.textContent = t("autoWhen").replace("{week}", weekLabel(d.next_week)).replace("{day}", dayName(Number(dow.value))).replace("{hour}", hourLabel(Number(hour.value))).replace("{tz}", d.timezone)
        + " " + t("autoWhenNotice").replace("{day}", dayName(sameDay ? Number(dow.value) : (Number(dow.value) + 1) % 7)).replace("{hour}", hourLabel(Number(nHour.value)));
    };
    [dow, hour, nHour].forEach((el) => el.addEventListener("change", paintWhen)); paintWhen();
    const save = async (e) => {
      e.preventDefault();
      try {
        await api("/admin/auto-schedule", { method: "PUT", body: { enabled: enabled.checked, dow: Number(dow.value), hour: Number(hour.value), notify_hour: Number(nHour.value), email: email.checked, sms: sms.checked, recipients: picks.filter(([, cb]) => cb.checked).map(([p]) => p.id), scope: matrix.value(), extra: extra.value,
          reminders: rOn.checked, reminder_days: rDays.filter(([, cb]) => cb.checked).map(([n]) => n), reminder_hour: Number(rHour.value), reminder_recipients: sameCb.checked ? null : rPicks.filter(([, cb]) => cb.checked).map(([p]) => p.id), r_email: rEmail.checked, r_sms: rSms.checked } });
        toast(t("saved")); load();
      } catch (err) { toast(errorText(err)); }
    };
    // runs
    const resLine = (r) => h("li", {}, `${r.restaurant} · ${t(`dept.${r.department}`)} : `, r.status === "created" ? `${r.shifts} ${t("autoShifts")}` : r.status === "failed" ? `${t("autoRes_failed")}${r.error ? ` (${r.error})` : ""}` : t(`autoRes_${r.status}`));
    const runCard = (r) => h("div", { class: `card auto-run ${r.status}` },
      h("div", {}, h("b", {}, `${t("autoWeekOf")} ${weekLabel(r.week)}`), " · ", h("span", { class: "badge" }, t(`autoSt_${r.status}`)), " · ", h("span", { class: "meta" }, new Date(r.started_at).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }))),
      r.summary?.error ? h("p", { class: "alert" }, r.summary.error === "no_ai_key" ? t("autoNoKey") : r.summary.error) : null,
      h("ul", { class: "auto-results" }, (r.summary?.results ?? []).filter((x) => x.status !== "no_staff").map(resLine)),
      r.reminders_sent?.length ? h("p", { class: "meta" }, `${t("autoRemindersSent")} : ${r.reminders_sent.map((n) => `+${n} ${t("autoDayShort")}`).join(", ")}`) : null,
      h("p", { class: "meta" }, r.notified_at ? `${t("autoNoticeSent")} · ${new Date(r.notified_at).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}` : r.notify_at ? `${t("autoNoticePlanned")} · ${r.notify_at.replace("T", " ")}` : t("autoNoNotice")));
    const busy = d.runs.some((r) => r.status === "running");
    const runNow = h("button", { class: "btn", type: "button", disabled: busy || !d.has_ai_key, onClick: async () => {
      if (!(await ask(t("autoRunConfirm").replace("{week}", weekLabel(d.next_week))))) return;
      try { await api("/admin/auto-schedule/run", { method: "POST" }); toast(t("autoRunStarted")); load(); } catch (err) { toast(err.body?.error === "already_running" ? t("autoAlreadyRunning") : errorText(err)); }
    } }, `▶ ${t("autoRunNow")} ${weekLabel(d.next_week)}`);
    // regenerate with extra instructions
    const rExtra = h("textarea", { rows: 3, maxLength: 2000, placeholder: t("autoRegenPh"), "aria-label": t("autoRegenExtra") });
    const rMatrix = scopeMatrix(d, s.scope);
    const rNotify = h("input", { type: "checkbox" });
    const regen = h("button", { class: "btn danger", type: "button", disabled: busy || !d.has_ai_key, onClick: async () => {
      if (!(await ask(t("autoRegenConfirm").replace("{week}", weekLabel(d.next_week)), t("autoRegenYes")))) return;
      try { await api("/admin/auto-schedule/regenerate", { method: "POST", body: { extra: rExtra.value, scope: rMatrix.value(), notify: rNotify.checked } }); toast(t("autoRegenStarted")); rExtra.value = ""; load(); }
      catch (err) { toast(err.body?.error === "already_running" ? t("autoAlreadyRunning") : err.body?.error === "no_ai_key" ? t("autoNoKey") : errorText(err)); }
    } }, `↻ ${t("autoRegenBtn")} ${weekLabel(d.next_week)}`);
    box.replaceChildren(h("h2", {}, `🌙 ${t("autoTitle")}`), h("p", { class: "meta" }, t("autoHelp")),
      d.has_ai_key ? null : h("div", { class: "alert", role: "alert" }, t("autoNoKey")),
      h("form", { class: "acc-form", onSubmit: save },
        h("label", { class: "check" }, enabled, h("span", {}, t("autoEnabled"))),
        h("div", { class: "form-row r2" }, h("label", { class: "field" }, h("span", {}, t("autoDay")), dow), h("label", { class: "field" }, h("span", {}, t("autoHour")), hour)), when,
        h("div", { class: "field" }, h("span", {}, t("autoScope")), h("span", { class: "meta" }, t("autoScopeHelp")), matrix.node),
        h("label", { class: "field" }, h("span", {}, t("autoExtra")), h("span", { class: "meta" }, t("autoExtraHelp")), extra),
        h("h3", {}, t("autoNotice")), h("p", { class: "meta" }, t("autoNoticeHelp")),
        h("div", { class: "form-row r2" }, h("label", { class: "field" }, h("span", {}, t("autoNoticeHour")), nHour),
          h("div", { class: "field" }, h("span", {}, t("autoNoticeBy")), h("label", { class: "check" }, email, h("span", {}, t("autoNoticeEmail"))), h("label", { class: "check" }, sms, h("span", {}, t("autoNoticeSms"))))),
        h("p", { class: "meta" }, t("autoNoticeOwn")),
        h("div", { class: "field" }, h("span", {}, t("autoRecipients")), h("span", { class: "meta" }, t("autoRecipientsHelp")),
          h("div", { class: "auto-people" }, picks.map(([p, cb]) => h("label", { class: "check auto-person" }, cb, h("span", {}, p.name, " ", h("small", { class: "meta" }, `${p.is_admin ? t("autoAdminTag") : t("autoManagerTag")} · ${p.email ?? t("autoNoEmail")} · ${p.phone ?? t("autoNoPhone")}`)))))),
        h("h3", {}, t("autoReminders")), h("p", { class: "meta" }, t("autoRemindersHelp")),
        h("label", { class: "check" }, rOn, h("span", {}, t("autoRemindersOn"))),
        h("div", { class: "field" }, h("span", {}, t("autoRemindDays")), h("div", { class: "auto-days" }, rDays.map(([n, cb]) => h("label", { class: "check" }, cb, h("span", {}, `+${n} ${t("autoDayShort")}`))))),
        h("div", { class: "form-row r2" }, h("label", { class: "field" }, h("span", {}, t("autoRemindHour")), rHour),
          h("div", { class: "field" }, h("span", {}, t("autoNoticeBy")), h("label", { class: "check" }, rEmail, h("span", {}, t("autoNoticeEmail"))), h("label", { class: "check" }, rSms, h("span", {}, t("autoNoticeSms"))))),
        h("div", { class: "field" }, h("span", {}, t("autoRemindWho")), h("label", { class: "check" }, sameCb, h("span", {}, t("autoRemindSame"))),
          h("div", { class: "auto-people" }, rPicks.map(([p, cb]) => h("label", { class: "check auto-person" }, cb, h("span", {}, p.name, " ", h("small", { class: "meta" }, `${p.is_admin ? t("autoAdminTag") : t("autoManagerTag")} · ${p.email ?? t("autoNoEmail")} · ${p.phone ?? t("autoNoPhone")}`)))))),
        h("button", { class: "btn primary", type: "submit" }, t("save"))),
      h("h3", {}, t("autoRuns")), d.runs.length ? d.runs.map(runCard) : h("p", { class: "meta" }, t("autoNoRuns")),
      h("div", { class: "actions" }, runNow), h("p", { class: "meta" }, t("autoRunNowHelp")),
      h("details", { class: "auto-regen" }, h("summary", {}, `↻ ${t("autoRegen")}`), h("p", { class: "meta" }, t("autoRegenHelp")),
        h("label", { class: "field" }, h("span", {}, t("autoRegenExtra")), rExtra), h("div", { class: "field" }, h("span", {}, t("autoScope")), rMatrix.node),
        h("label", { class: "check" }, rNotify, h("span", {}, t("autoRegenNotify"))), h("div", { class: "actions" }, regen)));
    clearTimeout(timer);
    if (busy) timer = setTimeout(() => { if (box.isConnected) load().catch(() => {}); }, 5000); // a run takes a few minutes: follow it
  }
  load().catch((e) => box.replaceChildren(h("p", { class: "meta" }, errorText(e))));
  return box;
}

function usagePanel() {
  const box = h("section", { class: "panel usage-panel" });
  const st = { month: null };
  const usd = (micro) => { const d = micro / 1_000_000; return `${d < 1 ? d.toFixed(4) : d.toFixed(2)} $`; };
  async function load() {
    const d = await api(`/admin/usage${st.month ? `?month=${st.month}` : ""}`);
    st.month = d.month;
    const by = (kind) => d.totals.find((x) => x.kind === kind);
    const card = (kind, label, qty) => { const x = by(kind); return h("div", { class: "card usage-card" }, h("h3", {}, label), x ? [h("div", { class: "usage-big" }, usd(x.cost_micro), x.pending ? h("small", { class: "meta" }, ` + ${x.pending} ${t("usagePending")}`) : null), h("p", { class: "meta" }, `${x.n} ${t("usageCount")} · ${qty(x)}`)] : h("p", { class: "meta" }, "—")); };
    const total = d.totals.reduce((n, x) => n + x.cost_micro, 0);
    const what = (r) => ({ ai_schedule: t("usageAiSchedule"), payslip: t("usagePayslip"), invoice: t("usageInvoice"), sms: t("usageSms"), call: t("usageCall") }[r.kind] ?? r.kind);
    const qty = (r) => (r.kind === "ai_schedule" || r.kind === "payslip" || r.kind === "invoice" ? `${(r.input_tokens ?? 0).toLocaleString(locale())} / ${(r.output_tokens ?? 0).toLocaleString(locale())}` : r.kind === "sms" ? `${r.units ?? 1} ${t("usageSegments")}` : r.units != null ? `${Math.round((r.units / 60) * 10) / 10} min` : "—");
    box.replaceChildren(h("h2", {}, `💰 ${t("usageTitle")}`), h("p", { class: "meta" }, t("usageHelp")),
      h("div", { class: "field", style: "max-width:220px" }, h("span", {}, t("usageMonth")), h("select", { "aria-label": t("usageMonth"), onChange: (e) => { st.month = e.target.value; load(); } }, d.months.map((m) => h("option", { value: m, selected: m === d.month }, m)))),
      h("div", { class: "card usage-total" }, h("span", {}, t("usageTotal")), h("b", {}, usd(total))),
      h("div", { class: "usage-cards" },
        card("ai_schedule", t("usageAiSchedule"), (x) => `${x.input_tokens.toLocaleString(locale())} / ${x.output_tokens.toLocaleString(locale())} ${t("usageTokens")}`),
        card("payslip", t("usagePayslip"), (x) => `${x.input_tokens.toLocaleString(locale())} / ${x.output_tokens.toLocaleString(locale())} ${t("usageTokens")}`),
        card("invoice", t("usageInvoice"), (x) => `${x.input_tokens.toLocaleString(locale())} / ${x.output_tokens.toLocaleString(locale())} ${t("usageTokens")}`),
        card("sms", t("usageSms"), (x) => `${x.units} ${t("usageSegments")}`),
        card("call", t("usageCall"), (x) => `${Math.round((x.units / 60) * 10) / 10} ${t("usageMinutes")}`)),
      d.recent.length ? [h("h3", {}, t("usageRecent")), h("div", { class: "usage-table-wrap" }, h("table", { class: "usage-table" },
        h("thead", {}, h("tr", {}, [t("usageWhen"), t("usageWhat"), "", t("usageQty"), t("usageCost")].map((x) => h("th", {}, x)))),
        h("tbody", {}, d.recent.map((r) => h("tr", {}, h("td", {}, new Date(r.created_at).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })), h("td", {}, what(r)), h("td", { class: "meta" }, r.detail ?? ""), h("td", {}, qty(r)), h("td", {}, r.cost_micro == null ? h("span", { class: "meta" }, t("usagePending")) : usd(r.cost_micro)))))))] : h("p", { class: "meta" }, t("usageNone")),
      h("p", { class: "meta" }, t("usageNotes")));
  }
  load().catch((e) => box.replaceChildren(h("p", { class: "meta" }, errorText(e))));
  return box;
}

// Administration → Ingrédients: what each restaurant keeps, per group (post or area), where it is stored, whether it must be thawed
// the day before (freezer) or is home-made from other ingredients. Everything is edited in dialogs and saved at once.
function ingredientsPanel() {
  const box = h("section", { class: "panel ing-panel" });
  const st = { restaurant: state.restaurants[0]?.id ?? null, groups: [], posts: [], suppliers: [], view: "post", catFilter: "" };
  const lang = getLang(), nm = (o) => (lang === "en" ? o.name_en : o.name_fr), gname = (g) => (lang === "en" ? g.name_en || g.name_fr : g.name_fr);
  const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  const catLabel = (v) => { const c = INGREDIENT_CATEGORIES.find(([x]) => x === v); return c ? t(c[1]) : t("ingNoCategory"); };
  const place = (v) => `${LOCATION_INFO[v]?.[0] ?? ""} ${t(LOCATION_INFO[v]?.[1] ?? "locFridge")}`;
  async function load() {
    const [d, sup, lr] = await Promise.all([api(`/admin/ingredients?restaurant=${st.restaurant}`), api("/admin/suppliers"), api("/admin/labor-rate")]);
    st.laborRate = lr.rate;
    st.suppliers = sup;
    st.groups = d.groups.map((g) => ({ ...g, items: g.items.map((i) => ({ ...i, components: [...(i.components ?? [])], supplier_ids: [...(i.supplier_ids ?? [])] })) })); st.posts = d.posts; draw();
  }
  // one entry per ingredient name (the same ingredient can be in several posts)
  const unique = () => {
    const m = new Map();
    st.groups.forEach((g, gi) => g.items.forEach((i) => { const k = i.name.trim().toLowerCase(); if (!k) return; const e = m.get(k) ?? { ...i, groups: [] }; e.groups.push(gi); m.set(k, e); }));
    return [...m.values()];
  };
  // saves everything; with `report`, a failure is handed back (to show it in the open dialog) instead of a toast
  async function persist(report) {
    const scroll = box.querySelector(".ing-matrix-wrap")?.scrollTop ?? 0;
    try {
      await api("/admin/ingredients", { method: "PUT", body: { restaurant_id: st.restaurant, groups: st.groups } }); toast(t("saved"));
      await load(); const w = box.querySelector(".ing-matrix-wrap"); if (w) w.scrollTop = scroll;
    } catch (e) { await load(); if (report) return errorText(e); toast(errorText(e)); }
    return null;
  }
  const dialog = (id) => { let dlg = document.getElementById(id); if (!dlg) { dlg = h("dialog", { id }); document.body.append(dlg); } return dlg; };
  const badges = (e) => h("span", { class: "ing-badges" },
    e.category ? h("span", { class: "ing-badge" }, catLabel(e.category)) : null, h("span", { class: "ing-badge" }, place(e.location)),
    e.thaw ? h("span", { class: "ing-badge thaw", title: t("ingThaw") }, `❄ ${t("ingThawShort")}`) : null,
    e.fridge_open ? h("span", { class: "ing-badge thaw", title: t("ingFridgeOpen") }, `🧊 ${t("ingFridgeOpenShort")}`) : null,
    e.homemade ? h("span", { class: "ing-badge home", title: t("ingHomemade") }, `🏠 ${t("ingHomemadeShort")}${e.components?.length ? ` · ${compText(e).join(", ")}` : ""}`) : null,
    portionText(e) ? h("span", { class: "ing-badge" }, `⚖ ${portionText(e)}`) : null,
    e.supplier_ids?.length ? h("span", { class: "ing-badge sup" }, `🚚 ${e.supplier_ids.map((id) => st.suppliers.find((x) => x.id === id)?.name).filter(Boolean).join(", ")}`) : null);

  // ---- ingredient dialog (also used to add one) ----
  function ingredientDialog(entry, presetGroup, preset) {
    const dlg = dialog("ing-modal");
    const cur = entry ?? { name: "", category: null, location: "fridge", thaw: false, homemade: !!preset?.homemade, components: [], prep_note: "", groups: presetGroup !== undefined ? [presetGroup] : [] };
    const name = h("input", { value: cur.name, maxLength: 80, "aria-label": t("ingName") });
    const err = h("p", { class: "form-error", role: "alert", hidden: true });
    const fail = (msg) => { err.textContent = `⚠ ${msg}`; err.hidden = false; err.scrollIntoView({ block: "nearest" }); };
    let catTouched = !!entry;
    const cat = h("select", { "aria-label": t("ingCategory"), onChange: () => { catTouched = true; } }, h("option", { value: "" }, `— ${t("ingNoCategory")}`), categoriesAlpha().map(([v, key]) => h("option", { value: v, selected: cur.category === v }, t(key))));
    const loc = h("select", { "aria-label": t("ingLocation"), onChange: () => sync() }, Object.entries(LOCATION_INFO).map(([v, [ic, key]]) => h("option", { value: v, selected: cur.location === v }, `${ic} ${t(key)}`)));
    const thaw = h("input", { type: "checkbox", checked: !!cur.thaw });
    const thawRow = h("label", { class: "check" }, thaw, h("span", {}, `❄ ${t("ingThaw")}`));
    const fopen = h("input", { type: "checkbox", checked: !!cur.fridge_open });
    const fopenRow = h("label", { class: "check" }, fopen, h("span", {}, `🧊 ${t("ingFridgeOpen")}`));
    const home = h("input", { type: "checkbox", checked: !!cur.homemade, onChange: () => sync() });
    const note = h("input", { value: cur.prep_note ?? "", maxLength: 200, placeholder: t("ingPrepNote"), "aria-label": t("ingPrepNote") });
    const comps = new Set(cur.components ?? []);
    // how much of each component goes into the home-made product
    const qtys = {};
    for (const n of cur.components ?? []) { const q = cur.component_qty?.[n]; if (q) qtys[n] = { qty: q.qty, unit: q.unit ?? "" }; }
    const qtyBox = h("div", { class: "ing-qtys" });
    const drawQty = () => qtyBox.replaceChildren(...(comps.size ? [h("p", { class: "meta" }, t("compQtyTitle"))] : []), ...[...comps].map((n) => h("div", { class: "ing-qty-row" }, h("span", {}, n),
      h("input", { type: "number", min: "0", step: "any", inputmode: "decimal", value: qtys[n]?.qty ?? "", "aria-label": `${n} · ${t("compQty")}`, onInput: (e) => { (qtys[n] ??= { qty: "", unit: "" }).qty = e.target.value; } }),
      h("input", { list: "ing-qty-units", maxLength: 20, value: qtys[n]?.unit ?? "", placeholder: t("compUnit"), "aria-label": `${n} · ${t("compUnit")}`, onInput: (e) => { (qtys[n] ??= { qty: "", unit: "" }).unit = e.target.value; } }))));
    const search = h("input", { type: "search", placeholder: t("ingSearch"), "aria-label": t("ingSearch"), onInput: () => drawComps() });
    const compList = h("div", { class: "ing-comps" });
    const others = () => unique().map((e) => e.name).filter((n) => !same(n, cur.name) && !same(n, name.value)).sort((a, b) => a.localeCompare(b, lang));
    // a new home-made ingredient takes the category of the ingredient it is made from, until a category is chosen by hand
    const autoCat = () => {
      if (catTouched) return;
      const base = [...comps].map((c) => unique().find((e) => same(e.name, c))).find((e) => e?.category);
      cat.value = base?.category ?? "";
    };
    const drawComps = () => {
      const q = search.value.trim().toLowerCase();
      compList.replaceChildren(...[...new Set([...comps, ...others()])].filter((n) => comps.has(n) || !q || n.toLowerCase().includes(q)).filter((n) => !q || n.toLowerCase().includes(q) || comps.has(n))
        .map((n) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: comps.has(n), onChange: (e) => { if (e.target.checked) comps.add(n); else comps.delete(n); autoCat(); drawQty(); } }), h("span", {}, n))));
    };
    // weight of one portion, in grams and ounces (each follows the other)
    const OZ = 28.3495, r1 = (x) => String(Math.round(x * 10) / 10);
    const grams = h("input", { type: "number", min: "0", step: "0.1", inputmode: "decimal", value: cur.portion_g ? r1(cur.portion_g) : "", "aria-label": `${t("ingPortion")} (g)`, onInput: () => { ounces.value = grams.value ? r1(Number(grams.value) / OZ) : ""; } });
    const ounces = h("input", { type: "number", min: "0", step: "0.1", inputmode: "decimal", value: cur.portion_g ? r1(cur.portion_g / OZ) : "", "aria-label": `${t("ingPortion")} (oz)`, onInput: () => { grams.value = ounces.value ? r1(Number(ounces.value) * OZ) : ""; } });
    const portion = h("div", { class: "ing-portion" }, h("span", {}, `⚖ ${t("ingPortion")}`), grams, h("span", {}, "g"), h("span", {}, "="), ounces, h("span", {}, "oz"));
    // or a count of something: 2 slices, 3 pieces…
    const qty = h("input", { type: "number", min: "0", step: "0.5", inputmode: "decimal", value: cur.portion_qty ? String(cur.portion_qty) : "", "aria-label": t("ingPortionCount") });
    const unit = h("input", { value: cur.portion_unit ?? "", maxLength: 30, list: "ing-units", placeholder: t("ingPortionUnitPh"), "aria-label": t("ingPortionUnitPh") });
    const units = h("datalist", { id: "ing-units" }, ["tranches", "morceaux", "unités", "tasses", "poignées", "tasses à mesurer", "sacs", "paquets", "caisses", "boîtes", "bouteilles"].map((u) => h("option", { value: u })));
    const portionCount = h("div", { class: "ing-portion count" }, h("span", {}, `⚖ ${t("ingPortionCount")}`), qty, unit, units);
    const homeBox = h("div", { class: "ing-home" }, h("p", { class: "meta" }, t("ingHomemadeHelp")), search, compList, qtyBox, h("datalist", { id: "ing-qty-units" }, ["g", "kg", "oz", "lb", "ml", "L", "tasse", "c. à soupe", "c. à thé", "unité", "tranche", "sac", "paquet", "caisse", "boîte", "bouteille"].map((u) => h("option", { value: u }))), note, portion, portionCount);
    // how it is packaged and counted (used by the Inventory screen)
    const iv = cur.inv ?? {};
    const ivIn = (key, extra = {}) => h("input", { value: iv[key] ?? "", "aria-label": t(`invF_${key}`), autocomplete: "off", ...extra });
    const ivf = { family: ivIn("family", { maxLength: 60, list: "ing-families" }), base_unit: ivIn("base_unit", { maxLength: 20, list: "ing-units" }), pack_unit: ivIn("pack_unit", { maxLength: 20, list: "ing-units" }),
      pack_qty: ivIn("pack_qty", { type: "number", min: "0", step: "any", inputmode: "decimal" }), pack_weight: ivIn("pack_weight", { type: "number", min: "0", step: "any", inputmode: "decimal" }), unit_weight: ivIn("unit_weight", { type: "number", min: "0", step: "any", inputmode: "decimal" }),
      min_qty: ivIn("min_qty", { type: "number", min: "0", step: "any", inputmode: "decimal" }), pack_cost: ivIn("pack_cost", { type: "number", min: "0", step: "0.01", inputmode: "decimal" }) };
    const families = [...new Set(st.groups.flatMap((g) => g.items.map((i) => i.inv?.family)).filter(Boolean))];
    const lab = (k) => h("label", { class: "field" }, h("span", {}, t(`invF_${k}`)), ivf[k]);
    const packBox = h("div", { class: "ing-pack-body" }, h("p", { class: "meta" }, t("ingPackHelp")),
      h("datalist", { id: "ing-families" }, families.map((f) => h("option", { value: f }))),
      lab("family"), lab("base_unit"), h("div", { class: "ing-two" }, lab("pack_unit"), lab("pack_qty")),
      h("div", { class: "ing-two" }, lab("pack_weight"), lab("unit_weight")), lab("min_qty"));
    const gboxes = st.groups.map((g, gi) => h("input", { type: "checkbox", checked: cur.groups.includes(gi) }));
    const supSel = new Set(cur.supplier_ids ?? []);
    // the supplier's product numbers: the preferred one and the ones that can replace it, for each supplier ticked above
    const codesBy = {}; for (const [sid, c] of Object.entries(cur.codes ?? {})) codesBy[sid] = codeInit(c);
    const codesBox = h("div", { class: "ing-codes" });
    const compareBox = h("div", { class: "ing-compare" });
    // the same ingredient at each supplier, on the same basis (per usable kg, preparation counted)
    const drawCompare = () => {
      const offers = st.suppliers.filter((x) => supSel.has(x.id)).map((x) => ({ id: x.id, name: x.name, ...codeValue(codesBy[x.id] ?? {}) }));
      const r = compareOffers(offers, st.laborRate);
      if (offers.filter((o) => o.price).length < 1) { compareBox.replaceChildren(); return; }
      const cost = (row) => row.cost;
      compareBox.replaceChildren(h("h4", {}, `⚖ ${t("ingCompareTitle")}`), h("p", { class: "meta" }, `${t(`ingBasis_${r.basis}`)}${st.laborRate ? ` · ${t("ingLabor")} ${st.laborRate} $/h` : ` · ${t("ingNoLabor")}`}`),
        h("div", { class: "usage-table-wrap" }, h("table", { class: "usage-table ing-cmp" },
          h("thead", {}, h("tr", {}, [t("ingCmpSupplier"), t("ingCmpPack"), t("ingCmpValue"), t("ingCmpPrep")].map((x) => h("th", {}, x)))),
          h("tbody", {}, r.rows.map((row) => h("tr", { class: row.best ? "best" : "" }, h("td", {}, `${row.best ? "🏆 " : ""}${row.name}`), h("td", {}, cost(row) ? `${money2(cost(row).price)}${offers.find((o) => o.id === row.id)?.unit ? ` / ${offers.find((o) => o.id === row.id).unit}` : ""}` : "—"),
            h("td", {}, row.value !== null ? `${money2(row.value)}${r.basis === "kg" ? " / kg" : r.basis === "unit" ? ` / ${t("ingCmpUnit")}` : ""}` : "—"),
            h("td", {}, row.prep ? `🔪 ${row.prep}${cost(row)?.prepMin ? ` · ${cost(row).prepMin} min` : ""}` : t("ingReady"))))))));
    };
    const drawCodes = () => {
      const sel = st.suppliers.filter((x) => supSel.has(x.id));
      codesBox.replaceChildren(...(sel.length ? [h("span", {}, `🔢 ${t("ingCodesTitle")}`), h("p", { class: "meta" }, t("ingCodesHelp")), ...sel.map((x) => {
        const c = (codesBy[x.id] ??= codeInit());
        return h("div", { class: "ing-code-row" }, h("b", {}, x.name), productCodeFields(c, drawCompare));
      })] : []));
    };

    const sync = () => { thawRow.hidden = loc.value !== "freezer"; fopenRow.hidden = loc.value !== "backstore"; homeBox.hidden = !home.checked; if (!home.checked) return; drawComps(); drawQty(); };
    // one tab per theme: general, home-made, packaging / stock taking, suppliers
    const generalPane = h("div", { class: "sup-pane" },
      h("label", { class: "field" }, h("span", {}, t("ingName")), name),
      h("div", { class: "ing-two" }, h("label", { class: "field" }, h("span", {}, t("ingCategory")), cat), h("label", { class: "field" }, h("span", {}, t("ingLocation")), loc)),
      thawRow, fopenRow,
      h("div", { class: "field" }, h("span", {}, t("ingInPosts")), h("div", { class: "ing-posts" }, st.groups.map((g, gi) => h("label", { class: "check" }, gboxes[gi], h("span", {}, gname(g))))))
    );
    const homePane = h("div", { class: "sup-pane" }, h("label", { class: "check" }, home, h("span", {}, `🏠 ${t("ingHomemade")}`)), homeBox);
    const packPane = h("div", { class: "sup-pane" }, packBox);
    const supPane = h("div", { class: "sup-pane" },
      h("div", { class: "field" }, h("span", {}, `🚚 ${t("ingSuppliers")}`), st.suppliers.length ? h("div", { class: "ing-posts" }, st.suppliers.map((sp) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: supSel.has(sp.id), onChange: (e) => { if (e.target.checked) supSel.add(sp.id); else supSel.delete(sp.id); drawCodes(); drawCompare(); } }), h("span", {}, sp.name)))) : h("p", { class: "meta" }, t("ingNoSuppliers"))),
      codesBox, compareBox);
    const ingPanes = { general: generalPane, home: homePane, pack: packPane, suppliers: supPane };
    const ingTabBar = h("div", { class: "dlg-tabs sup-tabs", role: "tablist" });
    const showIngTab = (id) => { for (const [k, el] of Object.entries(ingPanes)) el.hidden = k !== id; ingTabBar.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === id))); };
    ingTabBar.append(...[["general", `📝 ${t("ingTabGeneral")}`], ["home", `🏠 ${t("ingTabHome")}`], ["pack", `📦 ${t("ingTabPack")}`], ["suppliers", `🚚 ${t("ingTabSuppliers")}`]].map(([id, label]) => h("button", { type: "button", role: "tab", "data-tab": id, onClick: () => showIngTab(id) }, label)));
    let done = false; const close = () => { if (!done) { done = true; dlg.close(); } };
    dlg.replaceChildren(h("form", { class: "modal-body ing-dialog", onSubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        const nn = name.value.trim(); if (!nn) { showIngTab("general"); fail(t("ingNameRequired")); name.focus(); return; }
        const old = entry?.name;
        if ((!entry || !same(entry.name, nn)) && unique().some((x) => same(x.name, nn))) { showIngTab("general"); fail(t("ingNameTaken")); name.focus(); return; }
        // an ingredient lives in the posts it is ticked for: with none it would silently disappear
        if (!gboxes.some((x) => x.checked)) {
          if (!entry) { showIngTab("general"); fail(t("ingPickPost")); return; }
          if (!(await ask(`${t("ingNoPostDelete")} « ${entry.name} » ?`))) return;
        }
        const codes = Object.fromEntries([...supSel].map((sid) => [sid, codeValue(codesBy[sid] ?? {})]).filter(([, c]) => codeFilled(c)));
        const fields = { codes, inv: Object.fromEntries(Object.entries(ivf).map(([k, el]) => [k, el.value.trim()])), name: nn, category: cat.value || null, location: loc.value, thaw: loc.value === "freezer" && thaw.checked, fridge_open: loc.value === "backstore" && fopen.checked, homemade: home.checked, components: home.checked ? [...comps] : [], component_qty: home.checked ? Object.fromEntries([...comps].filter((n) => Number(qtys[n]?.qty) > 0).map((n) => [n, { qty: Number(qtys[n].qty), unit: (qtys[n].unit ?? "").trim() }])) : {}, prep_note: home.checked ? note.value.trim() : null, supplier_ids: [...supSel], portion_g: home.checked && Number(grams.value) > 0 ? Number(grams.value) : null,
          portion_qty: home.checked && Number(qty.value) > 0 && unit.value.trim() ? Number(qty.value) : null, portion_unit: home.checked && Number(qty.value) > 0 && unit.value.trim() ? unit.value.trim() : null };
        st.groups.forEach((g, gi) => {
          const want = gboxes[gi].checked, idx = g.items.findIndex((i) => old && same(i.name, old));
          if (idx >= 0 && want) Object.assign(g.items[idx], fields);
          else if (idx >= 0) g.items.splice(idx, 1);
          else if (want) g.items.push({ ...fields, components: [...fields.components], component_qty: { ...fields.component_qty } });
        });
        // renamed: the home-made ingredients made from it follow
        if (old && !same(old, nn)) for (const g of st.groups) for (const i of g.items) { i.components = i.components.map((x) => (same(x, old) ? nn : x)); if (i.component_qty) i.component_qty = Object.fromEntries(Object.entries(i.component_qty).map(([k, v]) => [same(k, old) ? nn : k, v])); }
        const problem = await persist(true);
        if (problem) { fail(problem); return; }
        close();
      } },
      h("h2", {}, entry ? t("ingEditTitle") : t("ingAdd")),
      ingTabBar,
      generalPane, homePane, packPane, supPane,
      err,
      h("div", { class: "actions" },
        entry ? h("button", { class: "btn danger", type: "button", onClick: async () => {
          if (!(await ask(`${t("ingConfirmDeleteOne")} « ${entry.name} » ?`))) return;
          for (const g of st.groups) g.items = g.items.filter((i) => !same(i.name, entry.name));
          for (const g of st.groups) for (const i of g.items) { i.components = i.components.filter((x) => !same(x, entry.name)); if (i.component_qty) i.component_qty = Object.fromEntries(Object.entries(i.component_qty).filter(([k]) => !same(k, entry.name))); }
          close(); await persist();
        } }, t("postsRemove")) : null,
        h("button", { class: "btn", type: "button", onClick: close }, t("cancel")),
        h("button", { class: "btn primary", type: "submit" }, t("save")))));
    sync(); drawCodes(); drawCompare(); showIngTab("general");
    dlg.addEventListener("close", () => { done = true; }, { once: true });
    dlg.showModal();
  }
  // ---- group dialog ----
  function groupDialog(g) {
    const dlg = dialog("ing-group-modal");
    const gerr = h("p", { class: "form-error", role: "alert", hidden: true });
    const fr = h("input", { value: g?.name_fr ?? "", maxLength: 60, "aria-label": t("ingGroupName") }), en = h("input", { value: g?.name_en ?? "", maxLength: 60, "aria-label": t("ingGroupNameEn") });
    const post = h("select", { "aria-label": t("ingLinkedPost") }, h("option", { value: "" }, t("ingNoPost")), st.posts.map((p) => h("option", { value: p.id, selected: g?.post_id === p.id }, nm(p))));
    dlg.replaceChildren(h("form", { class: "modal-body", onSubmit: async (e) => {
        e.preventDefault(); if (!fr.value.trim()) { gerr.textContent = `⚠ ${t("ingGroupNameRequired")}`; gerr.hidden = false; fr.focus(); return; }
        if (g) Object.assign(g, { name_fr: fr.value.trim(), name_en: en.value.trim(), post_id: Number(post.value) || null });
        else st.groups.push({ name_fr: fr.value.trim(), name_en: en.value.trim(), post_id: Number(post.value) || null, items: [] });
        dlg.close(); await persist();
      } },
      h("h2", {}, g ? t("ingEditGroup") : t("ingAddGroup")),
      h("label", { class: "field" }, h("span", {}, t("ingGroupName")), fr), h("label", { class: "field" }, h("span", {}, t("ingGroupNameEn")), en), h("label", { class: "field" }, h("span", {}, t("ingLinkedPost")), post), gerr,
      h("div", { class: "actions" },
        g ? h("button", { class: "btn danger", type: "button", onClick: async () => { if (!(await ask(t("ingConfirmDeleteGroup")))) return; st.groups.splice(st.groups.indexOf(g), 1); dlg.close(); await persist(); } }, t("postsRemove")) : null,
        h("button", { class: "btn", type: "button", onClick: () => dlg.close() }, t("cancel")), h("button", { class: "btn primary", type: "submit" }, t("save")))));
    dlg.showModal();
  }
  const editBtn = (e) => h("button", { class: "btn small", type: "button", onClick: () => ingredientDialog(e) }, `✎ ${t("editWord")}`);
  const row = (e) => h("div", { class: "ing-line" }, h("b", {}, e.name), badges(e), editBtn(e));

  // ---- suppliers ----
  function supplierDialog(sp, startTab = "card") {
    const dlg = dialog("ing-supplier-modal");
    const err = h("p", { class: "form-error", role: "alert", hidden: true });
    const name = h("input", { value: sp?.name ?? "", maxLength: 80, "aria-label": t("supName") }), phone = h("input", { type: "tel", value: formatPhone(sp?.phone), maxLength: 40, autocomplete: "off", placeholder: "+1 (514) 953-6985", "aria-label": t("supPhone") });
    phone.addEventListener("blur", () => { phone.value = formatPhone(phone.value); });
    const email = h("input", { type: "email", value: sp?.email ?? "", maxLength: 120, "aria-label": t("supEmail") }), notes = h("textarea", { rows: 3, maxLength: 300, "aria-label": t("supNotes") }, sp?.notes ?? "");
    const customer = h("input", { value: sp?.customer_number ?? "", maxLength: 60, "aria-label": t("supCustomer") });
    // the ways to order (several at once)
    const methodsOn = new Set(supplierMethods(sp));
    const urlIn = (v, label) => h("input", { type: "url", value: v ?? "", maxLength: 300, placeholder: "https://", "aria-label": label });
    const portalUrl = urlIn(sp?.portal_url, t("supPortalUrl")), siteUrl = urlIn(sp?.website_url, t("supSiteUrl"));
    const apiUrl = h("input", { type: "url", value: sp?.api_url ?? "", maxLength: 300, placeholder: "https://", "aria-label": t("supApiUrl") }), apiUser = h("input", { value: sp?.api_user ?? "", maxLength: 120, autocomplete: "off", "aria-label": t("supApiUser") });
    const apiKey = h("input", { type: "password", value: "", maxLength: 400, autocomplete: "new-password", placeholder: sp?.api_key_set ? t("supApiKeySaved") : "", "aria-label": t("supApiKey") });
    const clearKey = h("input", { type: "checkbox" });
    const portalBox = h("label", { class: "field", hidden: !methodsOn.has("portal") }, h("span", {}, t("supPortalUrl")), portalUrl);
    const siteBox = h("label", { class: "field", hidden: !methodsOn.has("website") }, h("span", {}, t("supSiteUrl")), siteUrl);
    const apiBox = h("div", { class: "sup-api", hidden: !methodsOn.has("api") }, h("p", { class: "meta" }, t("supApiHelp")),
      h("label", { class: "field" }, h("span", {}, t("supApiUrl")), apiUrl), h("div", { class: "ing-two" }, h("label", { class: "field" }, h("span", {}, t("supApiUser")), apiUser), h("label", { class: "field" }, h("span", {}, t("supApiKey")), apiKey)),
      sp?.api_key_set ? h("label", { class: "check" }, clearKey, h("span", {}, t("supApiKeyClear"))) : null);
    const showBoxes = () => { portalBox.hidden = !methodsOn.has("portal"); siteBox.hidden = !methodsOn.has("website"); apiBox.hidden = !methodsOn.has("api"); };
    const methodChecks = h("div", { class: "sup-methods", role: "group", "aria-label": t("supMethods") }, ["call", "email", "portal", "website", "api"].map((m) =>
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: methodsOn.has(m), onChange: (e) => { if (e.target.checked) methodsOn.add(m); else methodsOn.delete(m); showBoxes(); } }), h("span", {}, orderMethodLabel(m)))));
    // the order calendar
    const os = sp?.order_settings ?? {};
    const dayLabel = (i) => new Date(2026, 0, 5 + i).toLocaleDateString(locale(), { weekday: "short" }); // 2026-01-05 is a Monday
    const dayChips = (set) => h("div", { class: "sup-days", role: "group" }, Array.from({ length: 7 }, (_, i) => i + 1).map((d) => {
      const b = h("button", { type: "button", class: "chip-btn", "aria-pressed": String(set.has(d)), onClick: () => { if (set.has(d)) set.delete(d); else set.add(d); b.setAttribute("aria-pressed", String(set.has(d))); } }, dayLabel(d - 1)); return b; }));
    const orderDays = new Set(os.order_days ?? []), deliveryDays = new Set(os.delivery_days ?? []);
    const cutoffTime = timeField(os.cutoff || "14:00"), cutoffOn = h("input", { type: "checkbox", checked: !!os.cutoff, onChange: () => { cutoffTime.disabled = !cutoffOn.checked; } });
    cutoffTime.disabled = !os.cutoff;
    const cutoff = { get value() { return cutoffOn.checked ? cutoffTime.value : ""; } }; // "" = no cut-off
    const offset = h("input", { type: "number", min: "0", max: "14", step: "1", value: String(os.delivery_offset ?? 1), "aria-label": t("supDeliveryOffset") });
    const mode = os.delivery_mode === "days" ? "days" : "offset";
    const offsetRow = h("div", { class: "sup-delivery", hidden: mode !== "offset" }, offset, h("span", {}, t("supDaysAfter")));
    const daysRow = h("div", { class: "sup-delivery", hidden: mode !== "days" }, dayChips(deliveryDays));
    const modeRadios = ["offset", "days"].map((m) => h("label", { class: "check" }, h("input", { type: "radio", name: "sup-delivery-mode", value: m, checked: m === mode, onChange: () => { offsetRow.hidden = m !== "offset"; daysRow.hidden = m !== "days"; } }), h("span", {}, t(m === "offset" ? "supDeliveryOffsetMode" : "supDeliveryDaysMode"))));
    const orderNote = h("input", { value: os.note ?? "", maxLength: 200, "aria-label": t("supOrderNote"), placeholder: t("supOrderNotePh") });
    const settingsPane = h("div", { class: "sup-pane" }, h("p", { class: "meta" }, t("supSettingsHelp")),
      h("div", { class: "field" }, h("span", {}, t("supOrderDays")), dayChips(orderDays)), h("div", { class: "field" }, h("span", {}, t("supCutoff")), h("div", { class: "sup-cutoff" }, h("label", { class: "check" }, cutoffOn, h("span", {}, t("supCutoffOn"))), cutoffTime)),
      h("div", { class: "field" }, h("span", {}, t("supDelivery")), ...modeRadios, offsetRow, daysRow), h("label", { class: "field" }, h("span", {}, t("supOrderNote")), orderNote));
    const cardPane = h("div", { class: "sup-pane" }, h("label", { class: "field" }, h("span", {}, t("supName")), name),
      h("div", { class: "ing-two" }, h("label", { class: "field" }, h("span", {}, t("supPhone")), phone), h("label", { class: "field" }, h("span", {}, t("supEmail")), email)),
      h("div", { class: "field" }, h("span", {}, t("supMethods")), methodChecks), portalBox, siteBox, apiBox,
      h("label", { class: "field" }, h("span", {}, t("supCustomer")), customer), h("label", { class: "field" }, h("span", {}, t("supNotes")), notes));
    // history and current order need a saved supplier (and the restaurant chosen in the ingredients screen)
    const rid = st.restaurant, restoName = state.restaurants.find((r) => r.id === rid)?.name ?? "";
    const histPane = h("div", { class: "sup-pane" }), curPane = h("div", { class: "sup-pane" });
    const loaded = {};
    async function loadHistory() {
      histPane.replaceChildren(h("p", { class: "meta" }, t("loading")));
      try {
        const d = await api(`/suppliers/${sp.id}/orders?restaurant=${rid}`);
        const stamp = (ts) => new Date(ts).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short", hourCycle: "h23" });
        const refresh = () => { loaded.hist = false; loaded.cur = false; showTab("history"); };
        const invLink = (v) => { const slot = h("div", { class: "inv-slot" }); return h("div", {}, h("button", { type: "button", class: "btn small", onClick: async () => { if (slot.childElementCount) { slot.replaceChildren(); return; } try { slot.replaceChildren(invoiceResult(await api(`/invoices/${v.id}`), refresh)); } catch (e) { toast(errorText(e)); } } }, `🧾 ${v.invoice_number ? `${t("invcTitle")} ${v.invoice_number}` : t("invcTitle")}${v.total != null ? ` · ${money2(v.total)}` : ""}`), slot); };
        const orderCard = (o) => {
          const zoneSlot = h("div", { class: "inv-slot" });
          return h("div", { class: "card sup-order" }, h("b", {}, stamp(o.placed_at)), h("span", { class: "meta" }, ` · ${orderMethodLabel(o.method)}${o.placed_by ? ` · ${o.placed_by}` : ""}`),
            h("span", { class: `badge ${o.received_at ? "ok" : ""}` }, o.received_at ? ` ✅ ${t("invcReceived")} ${stamp(o.received_at)}` : ` 📦 ${t("invcToReceive")}`),
            o.delivery_date ? h("div", { class: "meta" }, `🚚 ${t("ordDelivery")} ${fmtDay(o.delivery_date)}`) : null, o.note ? h("div", { class: "meta" }, o.note) : null,
            h("ul", {}, o.items.map((i) => h("li", {}, i.name, i.code && codeLine(i.code) ? h("small", { class: "meta" }, ` — ${codeLine(i.code)}`) : null, i.note ? h("small", { class: "meta" }, ` (${i.note})`) : null))),
            ...o.invoices.map(invLink),
            h("div", { class: "ord-actions" },
              h("button", { type: "button", class: "btn small", onClick: () => { zoneSlot.replaceChildren(zoneSlot.childElementCount ? [] : invoiceDropZone({ sp, rid, order: o, onDone: (soft) => { if (!soft) refresh(); } })); } }, `🧾 ${t("invcUpload")}`),
              !o.received_at ? h("button", { type: "button", class: "btn small", onClick: async () => { try { await api(`/supplier-orders/${o.id}/received`, { method: "POST" }); refresh(); } catch (e) { toast(errorText(e)); } } }, `📥 ${t("invcMarkReceived")}`) : null), zoneSlot);
        };
        const unreceived = d.orders.filter((o) => !o.received_at);
        histPane.replaceChildren(h("p", { class: "meta" }, `🏪 ${restoName}`),
          h("section", { class: "card" }, h("h4", {}, `📥 ${t("invcReceiveTitle")}`), h("p", { class: "meta" }, t("invcHelp")),
            (() => { const sel = h("select", { "aria-label": t("invcWhichOrder") }, h("option", { value: "" }, t("invcNoOrderOpt")), unreceived.map((o) => h("option", { value: o.id, selected: o === unreceived[0] }, `${stamp(o.placed_at)} · ${orderMethodLabel(o.method)}`)));
              const holder = h("div", {}); const draw = () => holder.replaceChildren(invoiceDropZone({ sp, rid, order: d.orders.find((o) => String(o.id) === sel.value) ?? null, onDone: (soft) => { if (!soft) refresh(); } })); sel.addEventListener("change", draw); draw();
              return h("div", {}, unreceived.length ? h("label", { class: "field" }, h("span", {}, t("invcWhichOrder")), sel) : null, holder); })()),
          ...(d.orders.length ? d.orders.map(orderCard) : [h("p", { class: "meta" }, t("ordNoHistory"))]),
          d.invoices.length ? h("details", { class: "order-done" }, h("summary", {}, t("invcAlone")), d.invoices.map(invLink)) : null,
          d.loose.length ? h("details", { class: "order-done" }, h("summary", {}, t("ordLoose")), d.loose.map((o) => h("div", { class: "order-row done" }, h("span", {}, `✓ ${o.name}`), h("small", { class: "meta" }, ` ${stamp(o.ordered_at)}`)))) : null);
      } catch (e) { histPane.replaceChildren(h("p", { class: "meta" }, errorText(e))); }
    }
    async function loadCurrent() {
      curPane.replaceChildren(h("p", { class: "meta" }, t("loading")));
      try {
        const d = await api(`/orders?restaurant=${rid}`);
        const me = d.suppliers.find((x) => x.id === sp.id) ?? sp, items = d.open.filter((o) => o.supplier_ids.includes(sp.id));
        curPane.replaceChildren(h("p", { class: "meta" }, `🏪 ${restoName}`), windowNode(me),
          ...(items.length ? [h("ul", { class: "sup-items" }, items.map((o) => h("li", {}, h("b", {}, o.name), o.note ? h("small", { class: "meta" }, ` (${o.note})`) : null, o.codes?.[sp.id] && codeLine(o.codes[sp.id]) ? h("div", { class: "meta" }, `${t("ordNumber")} ${codeLine(o.codes[sp.id])}`) : null))),
            h("div", { class: "ord-actions" }, ...orderActions({ sp: me, items, rid, canOrder: d.can_order, reload: () => { loaded.cur = false; loaded.hist = false; showTab("current"); } }))] : [h("p", { class: "meta" }, t("ordNothing"))]));
      } catch (e) { curPane.replaceChildren(h("p", { class: "meta" }, errorText(e))); }
    }
    // the ingredients this supplier delivers, with its product numbers (changes are saved with the dialog's Save button)
    const key = (n) => n.trim().toLowerCase();
    const linked = new Map(unique().filter((e) => sp && e.supplier_ids?.includes(sp.id)).map((e) => [key(e.name), { name: e.name, location: e.location, ...codeInit(e.codes?.[sp.id]) }]));
    let ingDirty = false;
    const ingPane = h("div", { class: "sup-pane" });
    const drawIng = () => {
      const rows = [...linked.values()].sort((a, b) => a.name.localeCompare(b.name, getLang()));
      const addable = unique().filter((e) => !linked.has(key(e.name))).sort((a, b) => a.name.localeCompare(b.name, getLang()));
      const pick = h("select", { "aria-label": t("supIngAdd") }, h("option", { value: "" }, `+ ${t("supIngAdd")}`), addable.map((e) => h("option", { value: key(e.name) }, e.name)));
      pick.addEventListener("change", () => { const e = addable.find((x) => key(x.name) === pick.value); if (!e) return; linked.set(key(e.name), { name: e.name, location: e.location, ...codeInit() }); ingDirty = true; drawIng(); });
      ingPane.replaceChildren(h("p", { class: "meta" }, t("supIngHelp")), addable.length ? pick : null,
        ...(rows.length ? rows.map((r) => h("div", { class: "ing-code-row" }, h("div", { class: "sup-ing-head" }, h("b", {}, `${LOCATION_INFO[r.location]?.[0] ?? ""} ${r.name}`),
          h("button", { type: "button", class: "icon-btn", "aria-label": t("supIngRemove"), title: t("supIngRemove"), onClick: () => { linked.delete(key(r.name)); ingDirty = true; drawIng(); } }, "✕")),
          productCodeFields(r, () => { ingDirty = true; }))) : [h("p", { class: "meta" }, t("supIngNone"))]));
      const tab = tabBar.querySelector('[data-tab="ingredients"]'); if (tab) tab.textContent = `${t("supTabIngredients")} (${linked.size})`;
    };
    const applyIngredients = () => {
      for (const g of st.groups) for (const i of g.items) {
        const L = linked.get(key(i.name)), ids = new Set(i.supplier_ids ?? []);
        if (L) ids.add(sp.id); else ids.delete(sp.id);
        i.supplier_ids = [...ids];
        const codes = { ...(i.codes ?? {}) };
        const v = L ? codeValue(L) : null; if (v && codeFilled(v)) codes[sp.id] = v; else delete codes[sp.id];
        i.codes = codes;
      }
    };
    const panes = { card: cardPane, settings: settingsPane, ingredients: ingPane, history: histPane, current: curPane };
    const tabDefs = [["card", t("supTabCard")], ["settings", t("supTabSettings")], ...(sp ? [["ingredients", t("supTabIngredients")], ["history", t("supTabHistory")], ["current", t("supTabCurrent")]] : [])];
    const tabBar = h("div", { class: "dlg-tabs sup-tabs", role: "tablist" });
    function showTab(id) {
      for (const [k, el] of Object.entries(panes)) el.hidden = k !== id;
      tabBar.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === id)));
      if (id === "history" && !loaded.hist) { loaded.hist = true; loadHistory(); }
      if (id === "current" && !loaded.cur) { loaded.cur = true; loadCurrent(); }
    }
    tabBar.append(...tabDefs.map(([id, label]) => h("button", { type: "button", role: "tab", "data-tab": id, onClick: () => showTab(id) }, label)));
    if (sp) drawIng();
    const save = async (list) => { try { await api("/admin/suppliers", { method: "PUT", body: { suppliers: list } }); toast(t("saved")); dlg.close(); await load(); } catch (e) { err.textContent = `⚠ ${e.body?.error === "invalid_suppliers" ? t("supInvalid") : errorText(e)}`; err.hidden = false; } };
    dlg.replaceChildren(h("form", { class: "modal-body sup-dialog", onSubmit: async (e) => {
        e.preventDefault(); err.hidden = true;
        if (!name.value.trim()) { showTab("card"); err.textContent = `⚠ ${t("supNameRequired")}`; err.hidden = false; name.focus(); return; }
        if (sp && ingDirty) { applyIngredients(); const problem = await persist(true); if (problem) { err.textContent = `⚠ ${problem}`; err.hidden = false; return; } ingDirty = false; }
        const methods = ["call", "email", "portal", "website", "api"].filter((m) => methodsOn.has(m));
        const one = { id: sp?.id, name: name.value, phone: phone.value, email: email.value, notes: notes.value, order_methods: methods, portal_url: methodsOn.has("portal") ? portalUrl.value : "", website_url: methodsOn.has("website") ? siteUrl.value : "", customer_number: customer.value,
          order_settings: { order_days: [...orderDays], cutoff: cutoff.value, delivery_mode: modeRadios.find((r) => r.querySelector("input").checked).querySelector("input").value, delivery_offset: Number(offset.value) || 0, delivery_days: [...deliveryDays], note: orderNote.value },
          api_url: methodsOn.has("api") ? apiUrl.value : "", api_user: methodsOn.has("api") ? apiUser.value : "", ...(apiKey.value ? { api_key: apiKey.value } : {}), clear_api_key: clearKey.checked || undefined };
        await save(sp ? st.suppliers.map((x) => (x.id === sp.id ? { ...x, ...one } : x)) : [...st.suppliers, one]);
      } },
      // the buttons sit in the header so they stay in view whatever the tab
      h("div", { class: "dlg-top" }, h("div", { class: "dlg-head" }, h("h2", {}, sp ? sp.name : t("supAdd")),
        h("div", { class: "dlg-actions wrap" },
          sp ? h("button", { class: "btn danger", type: "button", onClick: async () => { if (!(await ask(t("supDeleteConfirm")))) return; await save(st.suppliers.filter((x) => x.id !== sp.id)); } }, t("delete")) : null,
          h("button", { class: "btn", type: "button", onClick: () => dlg.close() }, t("cancel")), h("button", { class: "btn primary", type: "submit" }, t("save"))))),
      tabBar, err, cardPane, settingsPane, ingPane, histPane, curPane));
    showTab(tabDefs.some(([id]) => id === startTab) ? startTab : "card");
    dlg.showModal();
  }
  function viewSuppliers() {
    const count = (id) => unique().filter((e) => e.supplier_ids?.includes(id)).length;
    const rate = h("input", { type: "number", min: "0", step: "0.5", inputmode: "decimal", value: st.laborRate ?? "", placeholder: "0", "aria-label": t("ingLaborRate"), onChange: async () => {
      try { const r = await api("/admin/labor-rate", { method: "PUT", body: { rate: rate.value } }); st.laborRate = r.rate; toast(t("saved")); } catch (e) { toast(errorText(e)); } } });
    return [h("label", { class: "field labor-rate" }, h("span", {}, `${t("ingLaborRate")} ($/h)`), rate, h("small", { class: "meta" }, t("ingLaborHelp"))),
      h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: () => supplierDialog(null) }, `+ ${t("supAdd")}`)),
      st.suppliers.length ? h("div", { class: "ing-lines tree" }, st.suppliers.map((sp) => h("div", { class: "ing-line" }, h("b", {}, sp.name),
        h("span", { class: "ing-badges" }, ...supplierMethods(sp).map((m) => h("span", { class: "ing-badge sup" }, orderMethodLabel(m))), sp.customer_number ? h("span", { class: "ing-badge" }, `${t("supClientShort")} ${sp.customer_number}`) : null, sp.phone ? h("span", { class: "ing-badge" }, `📞 ${formatPhone(sp.phone)}`) : null, sp.email ? h("span", { class: "ing-badge" }, `✉️ ${sp.email}`) : null, h("span", { class: "ing-badge" }, `${count(sp.id)} ${t("adminIngredients").toLowerCase()}`)),
        sp.notes ? h("small", { class: "meta", style: "flex-basis:100%" }, sp.notes) : null, h("button", { class: "btn small", type: "button", onClick: () => supplierDialog(sp) }, `✎ ${t("editWord")}`)))) : h("p", { class: "meta" }, t("supEmpty"))];
  }
  // ---- mixes: the ingredients a mix is made of, and where an ingredient is used ----
  function viewMixes() {
    const all = unique(), k = (n) => n.trim().toLowerCase();
    const byName = new Map(all.map((e) => [k(e.name), e]));
    const compQty = (mix, name) => { const key = Object.keys(mix.component_qty ?? {}).find((x) => k(x) === k(name)); const q = key ? mix.component_qty[key] : null; return q?.qty ? `${q.qty}${q.unit ? ` ${q.unit}` : ""}` : ""; };
    const usedIn = new Map(); // ingredient -> the mixes that use it
    for (const m of all.filter((e) => e.homemade)) for (const c of m.components ?? []) usedIn.set(k(c), [...(usedIn.get(k(c)) ?? []), m]);
    const q = (st.mixQ ?? "").trim().toLowerCase();
    const edit = (e) => h("button", { type: "button", class: "link-btn", onClick: () => ingredientDialog(e) }, e.name);
    const badge = (e) => [e.homemade ? h("span", { class: "ing-badge" }, `🏠 ${t("mixIsMix")}`) : null, LOCATION_INFO[e.location] ? h("span", { class: "ing-badge" }, LOCATION_INFO[e.location][0]) : null];
    // a mix and what it is made of, down to the ingredients (a component can itself be a mix)
    const tree = (mix, path) => h("ul", { class: "mix-tree" }, (mix.components ?? []).map((c) => {
      const e = byName.get(k(c)), qty = compQty(mix, c);
      return h("li", {}, e ? edit(e) : h("span", { class: "meta" }, `${c} ⚠ ${t("mixMissing")}`), qty ? h("small", { class: "meta" }, ` — ${qty}`) : null, ...(e ? badge(e) : []),
        e?.homemade && !path.includes(k(c)) && path.length < 5 ? tree(e, [...path, k(c)]) : null);
    }));
    // an ingredient and the mixes that use it (and where those mixes are used in turn)
    const upTree = (e, path) => h("ul", { class: "mix-tree" }, (usedIn.get(k(e.name)) ?? []).map((m) => {
      const qty = compQty(m, e.name), deeper = !path.includes(k(m.name)) && path.length < 5 && (usedIn.get(k(m.name)) ?? []).length;
      return h("li", {}, edit(m), qty ? h("small", { class: "meta" }, ` — ${qty}`) : null, ...badge(m), deeper ? upTree(m, [...path, k(m.name)]) : null);
    }));
    const modes = [["mix", t("mixByMix")], ["ingredient", t("mixByIngredient")]];
    st.mixMode ??= "mix";
    const head = [h("p", { class: "meta" }, t("mixHelp")),
      h("div", { class: "ing-add" }, h("button", { class: "btn", type: "button", onClick: () => ingredientDialog(null, undefined, { homemade: true }) }, `+ ${t("mixAdd")}`),
        h("input", { type: "search", value: st.mixQ ?? "", placeholder: t("mixSearch"), "aria-label": t("mixSearch"), onInput: (e) => { st.mixQ = e.target.value; clearTimeout(st.mixT); st.mixT = setTimeout(() => { draw(); document.querySelector(".ing-add input[type=search]")?.focus(); }, 250); } })),
      h("div", { class: "chip-row", role: "group" }, modes.map(([id, label]) => h("button", { type: "button", class: `chip-btn${st.mixMode === id ? " on" : ""}`, "aria-pressed": String(st.mixMode === id), onClick: () => { st.mixMode = id; draw(); } }, label)))];
    if (st.mixMode === "mix") {
      const mixes = all.filter((e) => e.homemade).filter((m) => !q || m.name.toLowerCase().includes(q) || (m.components ?? []).some((c) => c.toLowerCase().includes(q))).sort((a, b) => a.name.localeCompare(b.name, getLang()));
      return [...head, ...(mixes.length ? mixes.map((m) => h("section", { class: "card mix-card" }, h("h3", {}, edit(m), ...badge(m).slice(1)),
        m.prep_note ? h("p", { class: "meta" }, `📝 ${m.prep_note}`) : null,
        m.portion_g || m.portion_qty ? h("p", { class: "meta" }, `⚖ ${m.portion_g ? `${m.portion_g} g` : ""}${m.portion_qty ? ` ${m.portion_qty} ${m.portion_unit ?? ""}` : ""}`) : null,
        (m.components ?? []).length ? tree(m, [k(m.name)]) : h("p", { class: "meta" }, t("mixNoComponents")))) : [h("p", { class: "meta" }, t("mixNone"))])];
    }
    const used = all.filter((e) => (usedIn.get(k(e.name)) ?? []).length), unused = all.filter((e) => !e.homemade && !(usedIn.get(k(e.name)) ?? []).length);
    const match = (e) => !q || e.name.toLowerCase().includes(q) || (usedIn.get(k(e.name)) ?? []).some((m) => m.name.toLowerCase().includes(q));
    return [...head, ...used.filter(match).sort((a, b) => a.name.localeCompare(b.name, getLang())).map((e) => h("section", { class: "card mix-card" }, h("h3", {}, edit(e), ...badge(e)), h("p", { class: "meta" }, `${t("mixUsedIn")} ${(usedIn.get(k(e.name)) ?? []).length}`), upTree(e, [k(e.name)]))),
      used.length ? null : h("p", { class: "meta" }, t("mixNone")),
      unused.length ? h("details", { class: "order-done" }, h("summary", {}, `${t("mixUnused")} (${unused.length})`), h("ul", { class: "mix-tree" }, unused.filter(match).sort((a, b) => a.name.localeCompare(b.name, getLang())).map((e) => h("li", {}, edit(e))))) : null];
  }
  function viewByPost() {
    const uniq = unique();
    return st.groups.map((g, gi) => h("div", { class: "card ing-group" },
      h("div", { class: "ing-group-head" }, h("h3", {}, gname(g), h("small", { class: "meta" }, ` · ${g.items.length}`)),
        h("div", { class: "ing-group-actions" }, h("button", { class: "btn small", type: "button", onClick: () => ingredientDialog(null, gi) }, `+ ${t("ingAdd")}`), h("button", { class: "btn small", type: "button", onClick: () => groupDialog(g) }, `✎ ${t("ingEditGroup")}`))),
      h("div", { class: "ing-lines" }, g.items.map((i) => row(uniq.find((e) => same(e.name, i.name)) ?? { ...i, groups: [gi] }))),
      (() => { const bulk = h("input", { placeholder: t("ingBulk"), "aria-label": t("ingBulk") });
        return h("div", { class: "ing-add" }, bulk, h("button", { class: "btn small", type: "button", onClick: async () => { const names = bulk.value.split(",").map((x) => x.trim()).filter(Boolean); if (!names.length) return; for (const n of names) g.items.push({ name: n, location: "fridge", category: null, thaw: false, homemade: false, components: [], prep_note: null }); await persist(); } }, "+")); })()));
  }
  function viewByCategory() {
    const all = unique();
    return [...INGREDIENT_CATEGORIES.map(([v, key]) => [v, t(key)]), [null, t("ingNoCategory")]].map(([cat, label]) => [label, all.filter((e) => (e.category || null) === cat || (cat === null && !INGREDIENT_CATEGORIES.some(([v]) => v === e.category)))])
      .filter(([, list]) => list.length).map(([label, list]) => h("div", { class: "card ing-group" }, h("div", { class: "ing-group-head" }, h("h3", {}, label, h("small", { class: "meta" }, ` · ${list.length}`))),
        h("div", { class: "ing-lines tree" }, ingredientTree(list).map(({ item: e, depth }) => h("div", { class: `ing-line ${depth ? "ing-sub" : ""}`, style: depth ? `margin-left:${depth * 1.4}rem` : "" }, h("b", {}, depth ? `↳ ${e.name}` : e.name), h("span", { class: "ing-badges" }, e.groups.map((gi) => h("span", { class: "ing-badge" }, gname(st.groups[gi]))), h("span", { class: "ing-badge" }, place(e.location)),
          e.thaw ? h("span", { class: "ing-badge thaw" }, `❄ ${t("ingThawShort")}`) : null, e.fridge_open ? h("span", { class: "ing-badge thaw" }, `🧊 ${t("ingFridgeOpenShort")}`) : null, e.homemade ? h("span", { class: "ing-badge home" }, `🏠 ${t("ingHomemadeShort")}${e.components?.length ? ` · ${e.components.join(", ")}` : ""}`) : null, portionText(e) ? h("span", { class: "ing-badge" }, `⚖ ${portionText(e)}`) : null, e.supplier_ids?.length ? h("span", { class: "ing-badge sup" }, `🚚 ${e.supplier_ids.map((id) => st.suppliers.find((x) => x.id === id)?.name).filter(Boolean).join(", ")}`) : null), editBtn(e))))));
  }
  function viewTable() {
    const cols = st.groups.map((g, gi) => ({ g, gi })).filter(({ g }) => g.name_fr.trim());
    const rows = unique().filter((r) => !st.catFilter || (st.catFilter === "none" ? !r.category : r.category === st.catFilter));
    const bfOf = (g) => { const code = st.posts.find((p) => p.id === g.post_id)?.code, bf = st.posts.find((p) => p.code === (code === "subs" ? "bf_eggs" : code === "pizza" ? "bf_back" : "")); return bf ? nm(bf) : code === "starters" ? t("bfBreads") : ""; };
    // rows under their category (those without one at the end)
    const byCat = [...INGREDIENT_CATEGORIES.map(([v, key]) => [v, t(key)]), [null, t("ingNoCategory")]].map(([cat, label]) => [label, rows.filter((e) => (e.category || null) === cat || (cat === null && !INGREDIENT_CATEGORIES.some(([v]) => v === e.category)))]).filter(([, list]) => list.length);
    return [h("p", { class: "meta" }, t("ingMatrixHelp")),
      h("div", { class: "ing-add" }, h("button", { class: "btn", type: "button", onClick: () => ingredientDialog(null) }, `+ ${t("ingAdd")}`),
        h("select", { "aria-label": t("ingCategory"), onChange: (e) => { st.catFilter = e.target.value; draw(); } }, h("option", { value: "" }, t("ingAllCategories")), categoriesAlpha().map(([v, key]) => h("option", { value: v, selected: st.catFilter === v }, t(key))), h("option", { value: "none", selected: st.catFilter === "none" }, t("ingNoCategory")))),
      h("div", { class: "ing-matrix-wrap" }, h("table", { class: "ing-matrix" },
        h("thead", {}, h("tr", {}, h("th", {}, t("ingName")), h("th", {}, t("ingLocation")), ...cols.map(({ g }) => h("th", { class: "ing-col" }, h("b", {}, gname(g)), bfOf(g) ? h("small", {}, `+ ${bfOf(g)}`) : null)), h("th", { class: "ing-edit-cell", "aria-label": t("editWord") }))),
        h("tbody", {}, byCat.flatMap(([label, list]) => [
          h("tr", { class: "ing-cat-row" }, h("th", { colSpan: 3 + cols.length, scope: "colgroup" }, label, h("small", { class: "meta" }, ` · ${list.length}`))),
          ...ingredientTree(list).map(({ item: r, depth }) => h("tr", {}, h("th", { scope: "row", style: depth ? `padding-left:${0.5 + depth * 1.4}rem` : "" }, depth ? "↳ " : "", r.name, r.thaw ? " ❄" : "", r.fridge_open ? " 🧊" : "", r.homemade ? " 🏠" : ""), h("td", {}, place(r.location)),
            ...cols.map(({ g, gi }) => h("td", { class: "ing-check" }, h("input", { type: "checkbox", checked: r.groups.includes(gi), "aria-label": `${r.name} · ${gname(g)}`, onChange: async (e) => {
              if (e.target.checked) g.items.push({ ...r, id: undefined, components: [...(r.components ?? [])] }); else g.items = g.items.filter((i) => !same(i.name, r.name));
              await persist();
            } }))),
            h("td", { class: "ing-edit-cell" }, h("button", { class: "btn small ing-icon", type: "button", title: `${t("editWord")} · ${r.name}`, "aria-label": `${t("editWord")} · ${r.name}`, onClick: () => ingredientDialog(r) }, "✎"))))])))) ];
  }
  function draw() {
    const others = state.restaurants.filter((r) => r.id !== st.restaurant);
    const copySel = h("select", { "aria-label": t("ingCopyFrom") }, others.map((r) => h("option", { value: r.id }, r.name)));
    const views = [["post", t("ingViewByPost")], ["category", t("ingViewByCategory")], ["table", t("ingViewTable")], ["mixes", `🧪 ${t("ingViewMixes")}`], ["suppliers", t("ingViewSuppliers")]];
    box.replaceChildren(h("h2", {}, t("adminIngredients")), h("p", { class: "meta" }, t("ingredientsHelp")),
      h("div", { class: "ing-top" },
        h("div", { class: "field" }, h("span", {}, t("restaurant")), restaurantSelect({ list: state.restaurants, value: st.restaurant, onChange: (id) => { st.restaurant = id; load(); } })),
        others.length ? h("div", { class: "field" }, h("span", {}, t("ingCopyFrom")), h("div", { class: "ing-copy" }, copySel, h("button", { class: "btn", type: "button", onClick: async () => {
          if (st.groups.length && !(await ask(t("ingCopyFrom") + " ?"))) return;
          const d = await api(`/admin/ingredients?restaurant=${copySel.value}`);
          st.groups = d.groups.map((g) => ({ name_fr: g.name_fr, name_en: g.name_en, post_id: g.post_id, items: g.items.map((i) => ({ name: i.name, location: i.location, category: i.category ?? null, thaw: i.thaw, fridge_open: i.fridge_open, homemade: i.homemade, components: [...(i.components ?? [])], component_qty: { ...(i.component_qty ?? {}) }, prep_note: i.prep_note, portion_g: i.portion_g ?? null, portion_qty: i.portion_qty ?? null, portion_unit: i.portion_unit ?? null, supplier_ids: [...(i.supplier_ids ?? [])] })) }));
          await persist(); toast(t("ingCopied"));
        } }, t("ingCopyBtn")))) : null),
      h("div", { class: "subtabs", role: "tablist" }, views.map(([id, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(st.view === id), onClick: () => { st.view = id; draw(); } }, label))),
      ...(st.view === "table" ? viewTable() : st.view === "mixes" ? viewMixes() : st.view === "suppliers" ? viewSuppliers() : st.view === "category" ? viewByCategory() : viewByPost()),
      st.view === "table" || st.view === "suppliers" || st.view === "mixes" ? null : h("div", { class: "actions" }, st.view === "post" ? h("button", { class: "btn", type: "button", onClick: () => groupDialog(null) }, `+ ${t("ingAddGroup")}`) : h("button", { class: "btn", type: "button", onClick: () => ingredientDialog(null) }, `+ ${t("ingAdd")}`)));
  }
  load().catch((e) => box.replaceChildren(h("p", { class: "meta" }, errorText(e))));
  return box;
}

// Administration → periods of the Postes screen (Matin / Après-midi / Soir), for all restaurants or one.
function postPeriodsPanel() {
  const box = h("section", { class: "panel" });
  const st = { restaurant: 0, periods: [], custom: false };
  async function load() {
    const d = await api(`/admin/post-periods${st.restaurant ? `?restaurant=${st.restaurant}` : ""}`);
    st.periods = d.periods.map((p) => ({ ...p })); st.custom = d.custom; draw();
  }
  function draw() {
    box.replaceChildren(h("h2", {}, t("periodsTitle")), h("p", { class: "meta" }, t("periodsHelp")),
      h("div", { class: "field", style: "max-width:340px" }, h("span", {}, t("restaurant")),
        h("select", { "aria-label": t("restaurant"), onChange: (e) => { st.restaurant = Number(e.target.value); load(); } }, h("option", { value: 0, selected: !st.restaurant }, t("periodsDefaultAll")), state.restaurants.map((r) => h("option", { value: r.id, selected: st.restaurant === r.id }, r.name)))),
      ...st.periods.map((p, i) => {
        const a = timeField(p.start), z = timeField(p.end);
        a.addEventListener("change", () => { p.start = a.value; }); z.addEventListener("change", () => { p.end = z.value; });
        return h("div", { class: "period-row" },
          h("input", { value: p.fr, maxLength: 30, placeholder: t("periodNameFr"), "aria-label": t("periodNameFr"), onInput: (e) => { p.fr = e.target.value; } }),
          h("input", { value: p.en, maxLength: 30, placeholder: t("periodNameEn"), "aria-label": t("periodNameEn"), onInput: (e) => { p.en = e.target.value; } }),
          a, h("span", {}, "–"), z,
          h("button", { class: "icon-btn", type: "button", "aria-label": t("postsRemove"), onClick: () => { st.periods.splice(i, 1); draw(); } }, "✕"));
      }),
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "button", onClick: () => { st.periods.push({ fr: "", en: "", start: "07:00", end: "14:00" }); draw(); } }, `+ ${t("periodAdd")}`),
        st.custom ? h("button", { class: "btn", type: "button", onClick: async () => { try { await api("/admin/post-periods", { method: "PUT", body: { restaurant_id: st.restaurant || null, periods: null } }); toast(t("saved")); load(); } catch (e) { toast(errorText(e)); } } }, t("periodReset")) : null,
        h("button", { class: "btn primary", type: "button", onClick: async () => {
          if (!st.periods.length || st.periods.some((p) => !p.fr.trim() || p.start >= p.end)) { toast(t("periodsInvalid")); return; }
          try { await api("/admin/post-periods", { method: "PUT", body: { restaurant_id: st.restaurant || null, periods: st.periods } }); toast(t("saved")); load(); } catch (e) { toast(errorText(e)); }
        } }, t("save"))));
  }
  load().catch((e) => box.replaceChildren(h("p", { class: "meta" }, errorText(e))));
  return box;
}

function checklistsPanel() {
  const box = h("section", { class: "panel" });
  const st = { key: null, date: ymd(new Date()) };
  async function load() {
    const [data, report] = await Promise.all([api("/admin/checklists"), api(`/admin/checklist-report?date=${st.date}`)]);
    const lang = getLang();
    const nm = (o) => (lang === "en" ? o.name_en : o.name_fr);
    const targets = [...data.posts.map((p) => ({ kind: "post", id: p.id, label: `🍳 ${nm(p)}` })), ...data.roles.filter((r) => r.department_id !== "admin").map((r) => ({ kind: "role", id: r.id, label: `${roleIcon(r)} ${roleName(r)}` }))];
    if (!st.key || !targets.some((x) => `${x.kind}:${x.id}` === st.key)) st.key = `${targets[0].kind}:${targets[0].id}`;
    const cur = targets.find((x) => `${x.kind}:${x.id}` === st.key);
    const list = data.lists.find((l) => l.kind === cur.kind && l.target_id === cur.id);
    let items = (list?.items ?? []).map((i) => ({ id: i.id, text_fr: i.text_fr, text_en: i.text_en ?? "", last_out: !!i.last_out }));
    const rowsBox = h("div", { class: "cl-edit" });
    const drawRows = () => rowsBox.replaceChildren(...items.map((it, i) => h("div", { class: "cl-edit-row" },
      h("input", { value: it.text_fr, maxLength: 200, placeholder: t("checklistFr"), "aria-label": t("checklistFr"), onInput: (e) => { it.text_fr = e.target.value; } }),
      h("input", { value: it.text_en, maxLength: 200, placeholder: t("checklistEn"), "aria-label": t("checklistEn"), onInput: (e) => { it.text_en = e.target.value; } }),
      cur.kind === "role" ? h("label", { class: "check cl-lastout", title: t("checklistLastOutHelp") }, h("input", { type: "checkbox", checked: it.last_out, onChange: (e) => { it.last_out = e.target.checked; } }), h("span", {}, t("checklistLastOut"))) : null,
      h("div", { class: "cl-edit-btns" },
        h("button", { class: "icon-btn", type: "button", "aria-label": "↑", disabled: i === 0, onClick: () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; drawRows(); } }, "↑"),
        h("button", { class: "icon-btn", type: "button", "aria-label": "↓", disabled: i === items.length - 1, onClick: () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; drawRows(); } }, "↓"),
        h("button", { class: "icon-btn", type: "button", "aria-label": t("delete"), onClick: () => { items.splice(i, 1); drawRows(); } }, "🗑️")))));
    drawRows();
    const sel = h("select", { "aria-label": t("checklistWhich"), onChange: (e) => { st.key = e.target.value; load(); } }, targets.map((x) => h("option", { value: `${x.kind}:${x.id}`, selected: `${x.kind}:${x.id}` === st.key }, x.label)));
    const day = h("input", { type: "date", value: st.date, onChange: (e) => { st.date = e.target.value || st.date; load(); } });
    box.replaceChildren(h("h2", {}, t("checklistsTitle")), h("p", { class: "meta" }, t("checklistsHelp")),
      h("label", { class: "check cl-test" }, h("input", { type: "checkbox", checked: data.test_mode, onChange: async (e) => { try { await api("/admin/checklists/test-mode", { method: "PUT", body: { on: e.target.checked } }); toast(t("saved")); render(); } catch (err) { e.target.checked = !e.target.checked; toast(errorText(err)); } } }), h("span", {}, `🧪 ${t("checklistTestMode")}`)),
      h("p", { class: "meta" }, t("checklistTestHelp")),
      h("div", { class: "field" }, h("span", {}, t("checklistWhich")), sel),
      rowsBox,
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "button", onClick: () => previewChecklist(cur.label, items.filter((x) => x.text_fr.trim()), cur.kind === "role") }, `👁 ${t("checklistPreview")}`),
        h("button", { class: "btn", type: "button", onClick: () => { items.push({ text_fr: "", text_en: "", last_out: false }); drawRows(); rowsBox.querySelector(".cl-edit-row:last-child input")?.focus(); } }, `+ ${t("checklistAddItem")}`),
        h("button", { class: "btn primary", type: "button", onClick: async () => {
          try { await api("/admin/checklists", { method: "PUT", body: { kind: cur.kind, target_id: cur.id, items } }); toast(t("saved")); load(); } catch (e) { toast(errorText(e)); }
        } }, t("save"))),
      h("h3", { class: "cl-report-title" }, t("checklistReport")), h("label", { class: "field cl-date" }, h("span", {}, t("date")), day),
      report.length ? h("div", { class: "cl-report" }, report.map((r) => h("div", { class: `cl-report-row ${r.total && r.done === r.total ? "ok" : ""}` },
        h("b", {}, r.staff_name), h("span", { class: "meta" }, `${r.restaurant} · ${lang === "en" ? r.role_en : r.role_fr} · ${hhmm(r.start_at)}–${hhmm(r.end_at)}`),
        h("span", { class: "cl-score" }, r.total ? `${r.done}/${r.total}` : t("checklistNoPost"), r.submitted && r.done < r.total ? ` ✓ ${t("checklistDoneBtn")}` : ""),
        r.issues?.length ? h("small", { class: "cl-issue" }, r.issues.map((x) => `⚠ ${x.reason === "missing_ingredient" ? t("checklistMissingIng") : t("checklistOtherReason")} : ${x.note} (${lang === "en" ? x.text_en || x.text_fr : x.text_fr})`).join(" · ")) : null,
        r.missing.length && (r.done || r.submitted) ? h("small", { class: "meta" }, `${t("checklistMissing")} : ${r.missing.map((m) => (lang === "en" ? m.text_en || m.text_fr : m.text_fr)).join(" · ")}`) : null))) : h("p", { class: "meta" }, t("checklistNoShifts")));
  }
  load().catch((e) => box.replaceChildren(h("div", { class: "empty" }, errorText(e))));
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
      const bf = resto.breakfast_by_dow?.[i], dn = resto.dinner_by_dow?.[i], dv = resto.delivery_by_dow?.[i];
      const open = timeField(resto.open_by_dow?.[i] ?? resto.open_time), close = timeField(resto.close_by_dow?.[i] ?? resto.close_time);
      const bfOn = h("input", { type: "checkbox", checked: !!bf, "aria-label": `${mealWord()} — ${weekdayName(i)}` }), bfEnd = timeField(bf?.end ?? "11:00");
      const dnOn = h("input", { type: "checkbox", checked: !!dn, "aria-label": `${t("dinnerStarts")} — ${weekdayName(i)}` }), dnAt = timeField(dn ?? "17:00");
      const delivery = timeField(dv ?? resto.open_by_dow?.[i] ?? resto.open_time);
      const sync = () => { bfEnd.hidden = !bfOn.checked; dnAt.hidden = !dnOn.checked; for (const [el, on] of [[bfEnd, bfOn.checked], [dnAt, dnOn.checked]]) if (el.parentElement) el.parentElement.style.visibility = on ? "" : "hidden"; };
      bfOn.addEventListener("change", sync); dnOn.addEventListener("change", sync); sync();
      return { open, close, bfOn, bfEnd, dnOn, dnAt, delivery };
    });
    const copyMonday = () => rows.slice(1).forEach((r) => {
      const m = rows[0]; r.open.value = m.open.value; r.close.value = m.close.value; r.bfOn.checked = m.bfOn.checked; r.bfEnd.value = m.bfEnd.value; r.dnOn.checked = m.dnOn.checked; r.dnAt.value = m.dnAt.value; r.delivery.value = m.delivery.value;
      r.bfOn.dispatchEvent(new Event("change")); r.dnOn.dispatchEvent(new Event("change"));
    });
    box.replaceChildren(
      h("h2", {}, t("hoursTitle")),
      h("p", { class: "meta" }, `${t("hoursHelp")} ${mealText(t("breakfastHelpShort"))}`),
      h("div", { class: "field" }, h("span", {}, t("restaurant")), restaurantSelect({ list: ov.restaurants, value: st.restaurant, onChange: (id) => { st.restaurant = id; draw(); } })),
      h("div", { class: "hrs-table" },
        h("div", { class: "hrs-head" }, h("span"), h("span", {}, t("openTime")), h("span", {}, t("closeTime")), h("span", {}, mealWord()), h("span", {}, t("breakfastUntil")), h("span", {}, t("dinnerWord")), h("span", {}, t("startsAt")), h("span", {}, t("deliveryStarts"))),
        rows.map((r, i) => h("div", { class: "hrs-row" }, h("strong", {}, weekdayName(i)),
          h("label", { class: "mini" }, h("span", {}, t("openTime")), r.open),
          h("label", { class: "mini" }, h("span", {}, t("closeTime")), r.close),
          h("label", { class: "check hrs-bf" }, r.bfOn, h("span", { class: "hrs-until" }, mealWord())),
          h("div", { class: "mini" }, h("span", {}, t("breakfastUntil")), r.bfEnd),
          h("label", { class: "check hrs-bf" }, r.dnOn, h("span", { class: "hrs-until" }, t("dinnerWord"))),
          h("div", { class: "mini" }, h("span", {}, t("startsAt")), r.dnAt),
          h("label", { class: "mini" }, h("span", {}, t("deliveryStarts")), r.delivery)))),
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "button", onClick: copyMonday }, t("copyMonday")),
        h("button", { class: "btn primary", type: "button", onClick: async () => {
          try {
            await api(`/restaurants/${st.restaurant}/hours`, { method: "PUT", body: { open_times: rows.map((r) => r.open.value), close_times: rows.map((r) => r.close.value), dinner_times: rows.map((r) => (r.dnOn.checked ? r.dnAt.value : null)), delivery_times: rows.map((r) => r.delivery.value) } });
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

/** Why a welcome email did not leave, in words. */
function welcomeProblem(r) {
  return r.error === "no_email" ? t("welcomeNoEmail") : r.error === "inactive" ? t("welcomeInactive") : r.error === "email_not_configured" ? t("welcomeNoSmtp") : (r.detail ? `${t("welcomeSendError")} ${r.detail}` : t("welcomeSendError"));
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
      const saved = await api(`/staff/${s.id}`, { method: "PUT", body: { first_name: first.value, last_name: last.value, sex: sex.value || undefined, print_order: printOrder.value || null, email: email.value, phone: phone.value, lang: lang.value, notify_channel: channel.value, color: chosen } });
      const w = await api(`/staff/${s.id}/wage`, { method: "PUT", body: { hourly_rate: rate.value, role_rates: Object.fromEntries(roleRateInputs.map((x) => [x.rid, x.input.value])) } });
      s.hourly_cents = w.hourly_cents; s.role_rates = w.role_rates;
      if (sinInput.value.trim()) { const r = await api(`/staff/${s.id}/sin`, { method: "PUT", body: { sin: sinInput.value } }); s.sin_last3 = r.sin_last3; sinInput.value = ""; sinInput.placeholder = `••• ••• ${r.sin_last3}`; }
      s.email = email.value.trim().toLowerCase() || null;
      toast(saved?.welcome ? (saved.welcome.ok ? t("savedWelcomeSent") : `${t("savedWelcomeFailed")} ${welcomeProblem(saved.welcome)}`) : t("saved"));
    } catch (err) { toast(err.body?.error === "invalid_sin" ? t("invalidSin") : err.body?.error === "sin_already_used" ? t("sinUsed") : err.body?.error === "invalid_rate" ? t("genericError") : errorText(err)); }
  } },
    h("div", { class: "form-row r3" },
      h("label", { class: "field" }, h("span", {}, t("firstName")), first), h("label", { class: "field" }, h("span", {}, t("lastName")), last),
      h("div", { class: "field" }, h("span", {}, t("sexLabel")), sex)),
    h("div", { class: "form-row r2" }, h("label", { class: "field" }, h("span", {}, t("email")), email), h("label", { class: "field" }, h("span", {}, t("phone")), phone)),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: async (e) => {
      if (email.value.trim().toLowerCase() !== (s.email ?? "")) { toast(t("welcomeSaveFirst")); return; }
      const btn = e.currentTarget; btn.disabled = true;
      try { const r = await api(`/staff/${s.id}/welcome`, { method: "POST" }); toast(r.ok ? `${t("welcomeSent")} ${s.email}` : `${t("welcomeFailed")} ${welcomeProblem(r)}`); }
      catch (err) { toast(`${t("welcomeFailed")} ${errorText(err)}`); }
      finally { btn.disabled = false; }
    } }, `✉ ${t("welcomeResend")}`)),
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
    } }), h("span", {}, t("isAdminLabel"))),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!s.deaf_mute, onChange: async (e) => {
      const want = e.target.checked;
      try { await api(`/staff/${s.id}/deaf-mute`, { method: "PUT", body: { deaf_mute: want } }); s.deaf_mute = want ? 1 : 0; toast(t("saved")); } catch (err) { e.target.checked = !want; adminMsg.textContent = errorText(err); }
    } }), h("span", {}, `🧏 ${t("deafMuteLabel")}`)),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!s.voice_assist || !!s.is_admin, disabled: !!s.is_admin, onChange: async (e) => {
      const want = e.target.checked;
      try { await api(`/staff/${s.id}/voice-assist`, { method: "PUT", body: { allowed: want } }); s.voice_assist = want ? 1 : 0; toast(t("saved")); } catch (err) { e.target.checked = !want; adminMsg.textContent = errorText(err); }
    } }), h("span", {}, `📞 ${t("voiceAllowedLabel")}`))),
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
    const tabList = () => [["details", t("details")], ["roles", t("rolesTab")], ...(hasKitchenRole(s) ? [["kitchen", t("kitchenTab")]] : []), ["daysoff", mqDesktop.matches ? t("tabDaysOff") : t("fixedDaysOff")], ["availability", mqDesktop.matches ? t("tabAvailability") : t("availability")], ["timeoff", mqDesktop.matches ? t("tabTimeOff") : t("requestedTimeOff")], ["planning", t("planningTab")], ["attendance", t("attendanceTab")], ["scheduleaccess", mqDesktop.matches ? t("tabSchedules") : t("scheduleAccessTab")], ["communities", t("community")]];
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
      communities: () => [communityAccessPane(s)],
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
    h("span", { class: "who-row" }, summaryAvatar, h("span", { class: `presence ${s.signed_in ? "on" : "off"}`, role: "img", "aria-label": s.signed_in ? t("signedIn") : t("notSignedIn"),
      title: s.signed_in ? `${t("signedIn")} · ${t("lastActivity")} : ${new Date(s.last_seen_at).toLocaleString(getLang() === "en" ? "en-CA" : "fr-CA", { dateStyle: "short", timeStyle: "short", hourCycle: "h23" })}` : t("notSignedIn") }), nameEl), iconBlock,
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

// ---------- Passkeys (biometrics): the browser talks to the device, the server verifies ----------
const b64uToBuf = (x) => Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer;
const bufToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const passkeysSupported = () => !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
const creationOptions = (o) => ({ ...o, challenge: b64uToBuf(o.challenge), user: { ...o.user, id: b64uToBuf(o.user.id) }, excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) });
const requestOptions = (o) => ({ ...o, challenge: b64uToBuf(o.challenge), allowCredentials: (o.allowCredentials ?? []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) });
function credentialJSON(cred) {
  const r = cred.response;
  const base = { id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults?.() ?? {}, authenticatorAttachment: cred.authenticatorAttachment ?? undefined };
  if (r.attestationObject) return { ...base, response: { clientDataJSON: bufToB64u(r.clientDataJSON), attestationObject: bufToB64u(r.attestationObject), transports: r.getTransports?.() ?? [] } };
  return { ...base, response: { clientDataJSON: bufToB64u(r.clientDataJSON), authenticatorData: bufToB64u(r.authenticatorData), signature: bufToB64u(r.signature), userHandle: r.userHandle ? bufToB64u(r.userHandle) : undefined } };
}
async function passkeySignIn() {
  const { cid, options } = await api("/auth/passkey/options", { method: "POST" });
  const cred = await navigator.credentials.get({ publicKey: requestOptions(options) });
  await api("/auth/passkey/verify", { method: "POST", body: { cid, response: credentialJSON(cred) } });
}
function deviceName() {
  const ua = navigator.userAgent;
  return /iPhone|iPad/.test(ua) ? "iPhone / iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows (Windows Hello)" : /Mac/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Appareil";
}
/** Registers this device's biometrics for the signed-in person. Throws on refusal. */
async function registerPasskey() {
  const { cid, options } = await api("/account/passkeys/options", { method: "POST" });
  const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
  await api("/account/passkeys", { method: "POST", body: { cid, response: credentialJSON(cred), name: deviceName() } });
}

// Sign-in screen: biometrics, or email + password, or a 6-digit code sent by email -> session cookie.
function renderLogin(prefill = "") {
  renderChrome();
  document.getElementById("main-tabs").replaceChildren(); // nothing to navigate to before signing in
  const email = h("input", { type: "email", required: true, autocomplete: "username", inputMode: "email", value: prefill, placeholder: "prenom@exemple.com", maxLength: 200 });
  const password = h("input", { type: "password", autocomplete: "current-password", maxLength: 200, "aria-label": t("loginPassword") });
  const code = h("input", { required: true, autocomplete: "one-time-code", inputMode: "numeric", pattern: "[0-9]{6}", maxLength: 6, class: "login-code", "aria-label": t("loginCode") });
  const msg = h("div", { class: "alert", role: "alert" });
  const fail = (e, fallback) => { msg.textContent = e?.body?.error === "too_many_requests" ? t("loginTooMany") : e?.body?.error === "email_not_configured" ? t("loginEmailOff") : fallback; };
  const sendCode = async () => {
    if (!email.value.trim()) { msg.textContent = t("loginNeedEmail"); email.focus(); return; }
    try { await api("/auth/request", { method: "POST", body: { email: email.value, lang: getLang() } }); stepCode(); }
    catch (err) { fail(err, err.body?.error === "invalid_email" ? t("invalidEmail") : t("genericError")); }
  };
  // two pages: the first connection (the e-mail only, then the emailed code) and the usual one (passkey, password, or a code)
  const seen = () => lsGet("amo_login_seen") === "1";
  const stepFirst = () => {
    msg.textContent = ""; password.value = "";
    $app.replaceChildren(h("div", { class: "login-card" }, h("h2", {}, brandText("title") || t("loginTitle")), h("p", { class: "meta" }, t("loginFirstHelp")),
      h("form", { class: "acc-form", onSubmit: (e) => { e.preventDefault(); sendCode(); } },
        h("label", { class: "field" }, h("span", {}, t("loginEmail")), email), msg,
        h("button", { class: "btn primary", type: "submit" }, `✉️ ${t("loginFirstBtn")}`)),
      h("div", { class: "login-or" }, t("loginOr")),
      h("button", { class: "btn", type: "button", onClick: () => { state.loginMode = "returning"; stepEmail(); } }, t("loginGoReturning"))));
    email.focus();
  };
  const stepEmail = () => {
    if ((state.loginMode ?? (seen() || isStandalone() ? "returning" : "first")) === "first") { stepFirst(); return; }
    msg.textContent = ""; password.value = "";
    const usePasskey = async () => {
      msg.textContent = "";
      try { await passkeySignIn(); lsSet("amo_login_seen", "1"); boot(); }
      catch (err) { if (err?.name !== "NotAllowedError" && err?.name !== "AbortError") msg.textContent = t("loginPasskeyFailed"); }
    };
    $app.replaceChildren(h("div", { class: "login-card" }, h("h2", {}, brandText("title") || t("loginTitle")), h("p", { class: "meta" }, brandText("intro") || t("loginIntro")),
      ...(passkeysSupported() ? [h("button", { class: "btn primary", type: "button", onClick: usePasskey }, `🔐 ${t("loginPasskey")}`), h("p", { class: "meta" }, t("loginPasskeyHelp")), h("div", { class: "login-or" }, t("loginOr"))] : []),
      h("form", { class: "acc-form", onSubmit: async (e) => {
        e.preventDefault();
        if (!password.value) { sendCode(); return; } // no password typed: the emailed code is the way in
        try { await api("/auth/password", { method: "POST", body: { email: email.value, password: password.value } }); lsSet("amo_login_seen", "1"); boot(); }
        catch (err) { fail(err, t("loginBadPassword")); password.value = ""; password.focus(); }
      } }, h("label", { class: "field" }, h("span", {}, t("loginEmail")), email), h("label", { class: "field" }, h("span", {}, t("loginPassword")), password), msg,
        h("button", { class: "btn primary", type: "submit" }, t("loginPasswordSubmit"))),
      h("div", { class: "login-or" }, t("loginOr")),
      h("button", { class: "btn", type: "button", onClick: sendCode }, t("loginByCode")),
      h("p", { class: "meta" }, t("loginForgot")),
      h("button", { class: "btn link", type: "button", onClick: () => { state.loginMode = "first"; stepEmail(); } }, t("loginGoFirst"))));
    email.focus();
  };
  const stepCode = () => {
    msg.textContent = ""; code.value = "";
    $app.replaceChildren(h("div", { class: "login-card" }, h("h2", {}, brandText("title") || t("loginTitle")), h("p", { class: "meta" }, t("loginCodeSent")), h("p", {}, h("b", {}, email.value.trim())),
      h("form", { class: "acc-form", onSubmit: async (e) => {
        e.preventDefault();
        try { await api("/auth/verify", { method: "POST", body: { email: email.value, code: code.value } }); lsSet("amo_login_seen", "1"); boot(); }
        catch (err) { fail(err, t("loginBadCode")); code.value = ""; code.focus(); }
      } }, code, msg, h("button", { class: "btn primary", type: "submit" }, t("loginVerify"))),
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "button", onClick: async () => { try { await api("/auth/request", { method: "POST", body: { email: email.value, lang: getLang() } }); toast(t("loginCodeSent").split(":")[0]); } catch (err) { fail(err, t("genericError")); } } }, t("loginResend")),
        h("button", { class: "btn", type: "button", onClick: stepEmail }, t("loginChangeEmail")))));
    code.focus();
  };
  stepEmail();
}

// ---------- First-time guidance ----------
// 1) In the browser: offer to install the app, then to sign in again inside it.
// 2) In the installed app: offer biometrics, then require a password (an employee who signs in with Google would be exempt; Google sign-in does not exist yet).
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent);
const isSafariMac = () => /Macintosh/.test(navigator.userAgent) && /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

function modal(id, content, { dismissible }) {
  return new Promise((resolve) => {
    let dlg = document.getElementById(id);
    if (!dlg) { dlg = h("dialog", { id }); document.body.append(dlg); }
    dlg.replaceChildren(h("div", { class: "modal-body" }, ...content(() => { dlg.close(); resolve(true); })));
    if (!dismissible) dlg.addEventListener("cancel", (e) => e.preventDefault()); // Escape cannot close it
    dlg.addEventListener("close", () => resolve(false), { once: true });
    dlg.showModal();
  });
}

function installOffer() {
  return modal("onboard-modal", (done) => [
    h("h2", {}, t("onbInstallTitle")), h("p", {}, t("onbInstallBody")), installControls(),
    h("ol", { class: "onb-steps" }, h("li", {}, t("onbStep1")), h("li", {}, t("onbStep2")), h("li", {}, t("onbStep3"))),
    h("div", { class: "actions" },
      h("button", { class: "btn", type: "button", onClick: () => { lsSet("install_later", String(Date.now())); done(); } }, t("onbLater")),
      h("button", { class: "btn primary", type: "button", onClick: () => { lsSet("install_later", String(Date.now())); done(); } }, t("onbOk")))], { dismissible: true });
}

function passwordRequired() {
  return modal("password-modal", (done) => {
    const pw1 = h("input", { type: "password", autocomplete: "new-password", minLength: 10, maxLength: 200, required: true });
    const pw2 = h("input", { type: "password", autocomplete: "new-password", minLength: 10, maxLength: 200, required: true });
    const msg = h("div", { class: "alert", role: "alert" });
    return [h("h2", {}, t("onbPasswordTitle")), h("p", {}, t("onbPasswordBody")),
      h("form", { class: "acc-form", onSubmit: async (e) => {
        e.preventDefault(); msg.textContent = "";
        if (pw1.value !== pw2.value) { msg.textContent = t("secPasswordMismatch"); return; }
        try { await api("/account/password", { method: "PUT", body: { password: pw1.value } }); toast(t("secPasswordSaved")); done(); }
        catch (err) { const k = err?.body?.error; msg.textContent = k === "too_short" ? t("secTooShort") : k === "too_common" ? t("secTooCommon") : k === "too_long" ? t("secTooLong") : t("genericError"); }
      } }, h("label", { class: "field" }, h("span", {}, t("secPasswordNew")), pw1), h("label", { class: "field" }, h("span", {}, t("secPasswordConfirm")), pw2), msg,
        h("button", { class: "btn primary", type: "submit" }, t("secSetPassword"))),
      h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onClick: async () => { await api("/auth/logout", { method: "POST" }).catch(() => {}); state.me = null; document.getElementById("password-modal").close(); renderLogin(); } }, t("logout")))];
  }, { dismissible: false });
}

/** The steps done inside the installed app: biometrics (a choice), then the password (required). */
async function appStage(info) {
  // "Later" asks again after a day; it can always be done in Account → Security.
  if (passkeysSupported() && !info.passkeys.length && Date.now() - Number(lsGet("pk_later") ?? 0) > 24 * 3600 * 1000) {
    const yes = await confirmDialog({ title: t("confirmTitle"), message: t("passkeyOffer"), yes: t("passkeyOfferYes"), no: t("onbLater") });
    if (yes) { try { await registerPasskey(); toast(t("secPasskeyAdded")); } catch (err) { lsSet("pk_later", String(Date.now())); toast(err?.name === "InvalidStateError" ? t("secPasskeyAlready") : t("secPasskeyCancelled")); } }
    else { lsSet("pk_later", String(Date.now())); toast(t("passkeyLaterHint")); }
  }
  if (!info.has_password) await passwordRequired();
}

let onboardingStarted = false;
async function onboarding() {
  if (onboardingStarted) return;
  onboardingStarted = true;
  try {
    const info = await api("/account/security");
    if (isStandalone()) { api("/account/installed", { method: "POST" }).catch(() => {}); await appStage(info); return; } // marks this device as running the installed app
    if (!isIos() && !isSafariMac()) for (let i = 0; i < 6 && !installEvent; i++) await wait(250); // Chrome / Edge announce they can install a moment after loading
    const canInstall = isIos() || isSafariMac() || !!installEvent;
    if (!canInstall) { await appStage(info); return; } // a browser that cannot install the app: do the app steps right here
    const later = Number(lsGet("install_later") ?? 0);
    if (!info.installed && Date.now() - later > 3 * 24 * 3600 * 1000) await installOffer();
  } catch { /* guidance is never allowed to get in the way */ }
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
  onboarding();
}
// A notification opens the app on the right screen: /?view=community&c=3, /?view=account&tab=timeoff, /?view=admin&section=timeoff
function openFromLink() {
  const q = new URLSearchParams(location.search);
  const view = q.get("view");
  if (view && ["mine", "schedule", "posts", "checklist", "voice", "community", "account", "admin"].includes(view) && (view !== "admin" || state.me?.me.is_admin)) {
    state.view = view;
    if (q.get("c")) { state.communityId = Number(q.get("c")); state.commTab = "communities"; }
    if (q.get("dm")) { state.commTab = "messages"; state.dmThread = Number(q.get("dm")) || null; }
    if (q.get("sub")) state.listsSub = q.get("sub");
    if (q.get("tab")) state.accountTab = q.get("tab");
    if (q.get("section")) state.adminSection = q.get("section");
  }
  if (view) history.replaceState(null, "", location.pathname);
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { /* notifications simply stay unavailable */ });
boot();
