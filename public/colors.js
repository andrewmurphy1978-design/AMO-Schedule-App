// Employee colours. Pure functions shared by the browser and the tests.

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`;
}

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };


/**
 * Automatic colours: a palette chosen by farthest-point sampling in Lab colour space, so any two entries are
 * clearly different (dark, vivid and light, each readable with white or dark text). Each employee gets the colour
 * at their rank among all employees (see setStaffOrder), so nobody on the same schedule shares a colour until
 * there are more employees than palette entries.
 */
export const PALETTE = ["#c22929", "#1ded1d", "#1d1ded", "#1dc3ed", "#edc31d", "#141b5d", "#145d1b", "#f155d2", "#ddaca6", "#39efb8", "#51291f", "#8e8ef6", "#daea9a", "#085568", "#a0650d", "#840b54", "#89bd0f", "#650da0", "#f47198", "#a6ddcd", "#1d5bed", "#0da039", "#a6acdd", "#829438", "#ea9ae2", "#0da083", "#ed701d", "#f4b371", "#0f77bd", "#ae1ded"];
let order = new Map();
/** Remember every employee id (sorted) so the colour follows a stable rank instead of the raw id. */
export function setStaffOrder(ids) { order = new Map([...ids].sort((a, b) => a - b).map((id, i) => [id, i])); }
export function defaultColor(id) {
  const rank = order.has(id) ? order.get(id) : id - 1;
  if (rank >= 0 && rank < PALETTE.length) return PALETTE[rank];
  const n = rank - PALETTE.length;
  const hue = (n * 137.508 + 20) % 360;
  if (n % 2 === 0) return hslToHex(hue, 70, 72);
  for (let l = 42; l >= 20; l--) {
    const hex = hslToHex(hue, 62, l);
    if (contrast(hex, "#ffffff") >= 4.6) return hex;
  }
  return hslToHex(hue, 62, 20);
}
export const staffColor = (id, color) => color || defaultColor(id);

/** Readable text colour (white or near-black) for a given background. */
export const textOn = (hex) => (contrast(hex, "#ffffff") >= contrast(hex, "#1f1f23") ? "#ffffff" : "#1f1f23");

/** Swatches offered in Administration. */
export const SWATCHES = [...PALETTE, "#c8102e", "#c2410c", "#e67700", "#b58900", "#527f0b", "#237a35", "#0b7285", "#1971c2", "#3b5bdb", "#6741d9", "#9c36b5", "#c2255c", "#495057", "#6d4c41"].filter((c, i, all) => all.indexOf(c) === i);
