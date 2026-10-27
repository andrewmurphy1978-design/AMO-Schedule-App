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
 * Automatic colours come first from a hand-picked palette that mixes hue AND lightness (dark, vivid and light
 * colours) and is ordered so that consecutive ids are far apart on the colour wheel. Beyond the palette,
 * golden-angle hues are used, lightness alternating, always readable with white or dark text.
 */
export const PALETTE = [
  "#c92a2a", "#1971c2", "#237a35", "#9c36b5", "#e8590c", "#0b7285", "#c2255c", "#5f3dc4",
  "#ffd43b", "#364fc7", "#69db7c", "#7f4f24", "#66d9e8", "#a61e4d", "#527f0b", "#da77f2",
  "#087f5b", "#ffa8a8", "#862e9c", "#74c0fc", "#8f6a00", "#495057",
];
export function defaultColor(id) {
  if (id >= 1 && id <= PALETTE.length) return PALETTE[id - 1];
  const n = id - PALETTE.length;
  const hue = (n * 137.508 + 20) % 360;
  if (n % 2 === 0) { // light variant (dark text)
    return hslToHex(hue, 70, 72);
  }
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
