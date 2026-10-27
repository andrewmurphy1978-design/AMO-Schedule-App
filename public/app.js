import { t, getLang, setLang, locale, roleName } from "./i18n.js";
import { SLOTS, toMin, fromMin, shiftSpan, resolveTargets, targetWindows, targetAt, coverage, shortages, surpluses } from "./coverage.js";
import { resolveForDate, SPECIAL_PRESETS, SEASON_PRESETS } from "./rules.js";
import { staffColor, textOn, SWATCHES } from "./colors.js";

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
  sel: { restaurant: null, department: null, week: mondayOf(new Date()), day: ymd(new Date()) },
};

const DEPTS = ["floor", "kitchen", "delivery"];
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
    // Roles and manager scopes can change in Administration at any time, so never trust the copy loaded at start-up.
    if (state.view !== "admin") {
      [state.me, state.restaurants] = await Promise.all([api("/me"), api("/restaurants")]);
      renderChrome();
    }
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
  // Labour cost: only requested for admins; the server refuses everyone else.
  const payrollReq = state.me.me.is_admin
    ? api(`/admin/payroll?restaurant=${sel.restaurant}&department=${sel.department}&week=${sel.week}`).catch(() => null)
    : Promise.resolve(null);
  const [targets, sets, payroll] = await Promise.all([
    api(`/targets?restaurant=${sel.restaurant}&department=${sel.department}`),
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
          const card = [h("span", { class: "time" }, range(s)), h("span", { class: "who" }, avatar(s.staff_id, s.staff_name, s.staff_color, s.photo_v, 40), s.staff_name),
            h("span", { class: "meta" }, [roleName(s), s.notes].filter(Boolean).join(" · "))];
          return data.editable ? h("button", { class: "card", type: "button", onClick: () => openEditor(s) }, card) : h("div", { class: "card" }, card);
        }))
      : h("div", { class: "empty" }, t("noShifts")));
  const fab = data.editable ? h("button", { class: "fab", type: "button", "aria-label": t("addShift"), onClick: () => openEditor(null, { date: sel.day }) }, "+") : null;

  // Desktop: staff × days grid
  const people = new Map();
  for (const r of roster) people.set(r.staff_id, r.name);
  for (const s of data.shifts) people.set(s.staff_id, s.staff_name);
  const meta = new Map();
  for (const r of roster) meta.set(r.staff_id, { color: r.color, photo_v: r.photo_v });
  for (const sh of data.shifts) meta.set(sh.staff_id, { color: sh.staff_color, photo_v: sh.photo_v });
  const rows = [...people.entries()].sort((a, b) => a[1].localeCompare(b[1], locale()));
  const grid = h("div", { class: "grid-wrap" }, h("table", { class: "grid" },
    h("thead", {}, h("tr", {}, h("th", {}, ""), days.map((d) =>
      h("th", { class: d === today ? "today" : "" },
        // Clicking a day here zooms the coverage view below on that day and scrolls to it.
        h("button", { type: "button", class: "th-zoom", title: t("zoomDay"), "aria-label": `${t("zoomDay")}: ${fmt(d, { weekday: "long", day: "numeric", month: "long" })}`, onClick: () => zoomTo(d) },
          fmt(d, { weekday: "short", day: "numeric", month: "short" })))))),
    h("tbody", {}, rows.length ? rows.map(([id, name]) =>
      h("tr", {}, h("td", { class: "name" }, avatar(id, name, meta.get(id)?.color, meta.get(id)?.photo_v, 36), name), days.map((d) =>
        h("td", {},
          data.shifts.filter((s) => s.staff_id === id && dayOf(s.start_at) === d).map((s) => {
            const body = [h("b", {}, range(s).replace(" – ", "–")), ` ${roleName(s)}`];
            const c = staffColor(s.staff_id, s.staff_color);
            const style = `border-left-color:${c};background:color-mix(in srgb, ${c} 16%, var(--card))`;
            return data.editable ? h("button", { class: "shift-chip", type: "button", style, onClick: () => openEditor(s) }, body) : h("div", { class: "shift-chip", style }, body);
          }),
          data.editable ? h("button", { class: "add-cell", type: "button", "aria-label": t("addShift"), onClick: () => openEditor(null, { date: d, staff_id: id }) }, "+") : null))))
      : h("tr", {}, h("td", { colSpan: 8 }, h("div", { class: "empty" }, t("noShiftsWeek")))))));

  const timeline = renderTimeline({ data, days, targets, sets, payroll, openEditor });
  $app.replaceChildren(...[controls, status, daytabs, daily, timeline, grid, fab].filter(Boolean));
}


// Zoom the coverage view on one day (desktop) or just select it (phone), then bring it into view.
async function zoomTo(day) {
  state.sel.day = day;
  if (mqDesktop.matches) state.zoomDay = day;
  await render();
  document.querySelector("section.timeline")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- coverage timeline (vertical) ----------
const slotLabel = (slot) => (slot === "close" ? t("closeSlot") : slot.replace(/^0/, ""));
const mqDesktop = window.matchMedia("(min-width: 900px)");
mqDesktop.addEventListener("change", () => { if (state.me) render(); });

// Side-by-side lanes for overlapping bars: greedy interval partitioning.
function assignLanes(items) {
  const ends = [];
  for (const it of items) {
    let lane = ends.findIndex((e) => e <= it.from);
    if (lane === -1) { lane = ends.length; ends.push(0); }
    ends[lane] = it.to;
    it.lane = lane;
  }
  return Math.max(1, ends.length);
}

function renderTimeline({ data, days, targets, sets, payroll, openEditor }) {
  const sel = state.sel;
  const desktop = mqDesktop.matches;
  const zoom = !!(desktop && state.zoomDay && days.includes(state.zoomDay));
  const shown = zoom ? [state.zoomDay] : desktop ? days : [sel.day];

  const perDay = shown.map((day) => {
    const { targets: dayTargets, labels } = resolveForDate(targets, sets, day);
    const openMin = toMin(openOf(sel.restaurant, (parseYmd(day).getDay() + 6) % 7));
    const closeMin = toMin(closeOf(sel.restaurant, dowOf(day)));
    const wins = targetWindows(dayTargets, closeMin);
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
    const buckets = coverage(d.items.map((x) => x.s), d.day, startMin, endMin);
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
        class: `vtl-bar ${wide ? "" : "vertical"}`,
        title: `${x.s.staff_name} · ${range} · ${roleName(x.s)}`,
        style: `top:${y(x.from)}px;height:${height}px;left:${(x.lane / lanes) * 100}%;width:${100 / lanes}%;background:${fill};color:${textOn(color)}`,
      };
      // Picture size follows the room available in this lane; skip it on very short bars.
      const size = Math.max(14, Math.min(zoom ? 44 : 30, Math.floor(laneArea / lanes) - 6));
      const pic = height >= size + 14 ? avatar(x.s.staff_id, x.s.staff_name, x.s.staff_color, x.s.photo_v, size) : null;
      const body = zoom
        ? [h("b", { class: "bar-name" }, pic, x.s.staff_name), `${range} · ${roleName(x.s)}`, x.s.notes ? h("em", {}, x.s.notes) : null]
        : wide
        ? [h("b", { class: "bar-name" }, pic, x.s.staff_name), range]
        : [pic, h("span", { class: "bar-text" }, `${x.s.staff_name} ${range}`)];
      return data.editable ? h("button", { ...props, type: "button", onClick: () => openEditor(x.s) }, body) : h("div", props, body);
    });
    const shade = (from, to) => (to > from ? h("div", { class: "vtl-closed", title: t("beforeOpen"), style: `top:${y(from)}px;height:${y(to) - y(from)}px` }) : null);
    const hourly = payroll && state.showHourlyCost && d.cost;
    const costCol = hourly
      ? h("div", { class: "vtl-costcol" }, Array.from({ length: hours }, (_, i) => {
          const c = d.cost.by_hour[(startMin / 60 + i) % 24];
          return h("div", { class: "vtl-costcell", style: `top:${i * ph}px;height:${ph}px`, title: `${(startMin / 60 + i) % 24}h` }, c > 0 ? money(c) : "");
        }))
      : null;
    return h("div", { class: `vtl-day ${hourly ? "with-cost" : ""}` }, shade(startMin, d.openMin), shade(d.closeMin, endMin), h("div", { class: "vtl-cov" }, cells), costCol, h("div", { class: "vtl-lanes" }, bars));
  });

  const heads = perDay.map((d) => {
    const kids = [fmt(d.day, { weekday: "short" }), h("small", {}, fmt(d.day, { day: "numeric", month: "short" })),
      d.labels.length ? h("span", { class: "tag" }, d.labels.join(" · ")) : null,
      d.cost ? h("span", { class: "cost" }, money(d.cost.cents)) : null];
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

  const payrollBox = payroll ? (() => {
    const today = payroll.department.days.find((x) => x.date === sel.day);
    return h("div", { class: "payroll" },
      shown.length === 1 && today ? h("div", { class: "row" }, h("span", {}, `${t("costDay")} — ${t("costDept")}`), h("b", {}, `${money(today.cents, true)} · ${today.hours} ${t("hoursShort")}`)) : null,
      h("div", { class: "row" }, h("span", {}, `${t("costWeek")} — ${t("costDept")}`), h("b", {}, `${money(payroll.department.total_cents, true)} · ${payroll.department.total_hours} ${t("hoursShort")}`)),
      h("div", { class: "row" }, h("span", {}, `${t("costWeek")} — ${t("costRestaurant")}`), h("b", {}, `${money(payroll.restaurant.total_cents, true)} · ${payroll.restaurant.total_hours} ${t("hoursShort")}`)),
      payroll.restaurant.unrated_hours > 0 ? h("div", { class: "warn" }, `${payroll.restaurant.unrated_hours} ${t("unratedHours")}`) : null,
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
  const start = timeField(initial.start);
  const end = timeField(initial.end);
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
    const endTime = untilClose.checked ? closeOf(sel.restaurant, dowOf(date.value)) : end.value;
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
const ADMIN_SECTIONS = [["restaurants", "adminRestaurants"], ["targets", "adminTargets"], ["staff", "adminStaff"]];
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

  const sections = {
    restaurants: () => [restaurantsPanel, hoursPanel(ov)],
    targets: () => [targetsPanel(ov)],
    staff: () => [staffPanel, ...staffList],
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

    const slotInputs = SLOTS.map((slot) => {
      const mine = own.find((r) => r.slot === slot)?.count;
      const dflt = fallback[slot];
      const input = h("input", { type: "number", min: 0, max: 99, inputMode: "numeric", value: mine ?? "", placeholder: dflt !== undefined ? String(dflt) : "" });
      inputs[slot] = input;
      return h("label", { class: "field" }, h("span", {}, slotLabel(slot)), input);
    });
    const saveTargets = async (slots) => {
      try { await api("/targets", { method: "PUT", body: { restaurant_id: st.restaurant, department_id: st.department, set_id: st.setId, dow: st.dow, slots } }); toast(t("saved")); reload(); }
      catch (e) { toast(errorText(e)); }
    };

    const periodOpts = [[0, t("basePeriod")],
      ...sets.filter((x) => x.kind === "season").map((x) => [x.id, `${t("seasonWord")} · ${x.name}`]),
      ...sets.filter((x) => x.kind === "special").map((x) => [x.id, `${t("specialWord")} · ${x.name}`])];

    box.replaceChildren(...[
      h("h2", {}, t("targets")), h("p", { class: "meta" }, t("targetsHelp")),
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
          for (const slot of SLOTS) if (inputs[slot].value !== "") slots[slot] = Number(inputs[slot].value);
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
  const name = h("input", { value: s.name, required: true });
  const email = h("input", { type: "email", value: s.email ?? "" });
  const phone = h("input", { type: "tel", value: s.phone ?? "" });
  const lang = h("select", {}, ["fr", "en"].map((l) => h("option", { value: l, selected: s.lang === l }, l === "fr" ? "Français" : "English")));
  const channel = h("select", {}, [["sms", t("sms")], ["email", t("emailCh")]].map(([v, l]) => h("option", { value: v, selected: s.notify_channel === v }, l)));
  const rate = h("input", { type: "number", min: 0, max: 1000, step: "0.05", inputMode: "decimal", placeholder: t("noRate"), value: s.hourly_cents != null ? (s.hourly_cents / 100).toFixed(2) : "" });
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
  const details = h("form", { class: "inline-form", style: "grid-template-columns:1fr", onSubmit: async (e) => {
    e.preventDefault();
    try {
      await api(`/staff/${s.id}`, { method: "PUT", body: { name: name.value, email: email.value, phone: phone.value, lang: lang.value, notify_channel: channel.value, color: chosen } });
      const w = await api(`/staff/${s.id}/wage`, { method: "PUT", body: { hourly_rate: rate.value } });
      s.hourly_cents = w.hourly_cents; toast(t("saved"));
    } catch (err) { toast(err.body?.error === "invalid_rate" ? t("genericError") : errorText(err)); }
  } },
    h("label", { class: "field" }, h("span", {}, t("name")), name), h("label", { class: "field" }, h("span", {}, t("email")), email),
    h("label", { class: "field" }, h("span", {}, t("phone")), phone), h("label", { class: "field" }, h("span", {}, t("language")), lang),
    h("label", { class: "field" }, h("span", {}, t("notifyBy")), channel),
    h("label", { class: "field" }, h("span", {}, t("hourlyRate")), rate, h("span", { class: "meta" }, t("adminOnlyField"))),
    photoRow,
    h("div", { class: "field" }, h("span", {}, t("colour")), h("div", { class: "colour-row" }, dot, picker), swatches),
    h("button", { class: "btn primary", type: "submit" }, t("save")));

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
            return h("label", { class: "check" }, input, roleName(ro));
          }),
          (() => {
            const body = { staff_id: s.id, restaurant_id: r.id, department_id: d };
            const on = s.managers.some((x) => x.restaurant_id === r.id && x.department_id === d);
            return h("label", { class: "check", style: "border-color:var(--brand)" }, h("input", { type: "checkbox", checked: on, onChange: toggle(on,
              () => api("/managers", { method: "POST", body }), () => api("/managers", { method: "DELETE", body })) }), `★ ${t("managerOf")}`);
          })()));
    })));

  return h("details", { class: "staff" },
    h("summary", {}, h("span", { class: "who-row" }, summaryAvatar, s.name), s.is_admin ? h("span", { class: "badge" }, t("admin_flag")) : h("span", { class: "meta" }, s.email ?? "")),
    h("div", { class: "staff-body" }, h("h3", {}, t("details")), details, h("h3", {}, t("assignments")), blocks));
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
