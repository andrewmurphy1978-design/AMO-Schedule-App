// SMS text cleaning. A text made only of the standard GSM characters costs one segment per 160 characters (153 when it has several);
// a single other character (an emoji, a curly apostrophe, « », …) switches the whole message to Unicode: 70 characters per segment (67).
// We replace what has a plain equivalent and drop the emojis. The letters ê â î ô û ç (and the like) are kept on purpose:
// they are part of correct French, even though a message that has one still counts as Unicode.

const MAP: Record<string, string> = {
  "’": "'", "‘": "'", "‚": ",", "´": "'", "`": "'", "ʼ": "'",
  "«": '"', "»": '"', "“": '"', "”": '"', "„": '"', "‹": "'", "›": "'",
  "…": "...", "–": "-", "—": "-", "‑": "-", "−": "-", "→": "->", "←": "<-", "·": "-", "•": "-", "×": "x", "°": "o", "½": "1/2",
  " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ",
};
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}‍️⃣​‌⁠]/gu;

export function smsClean(text: string): string {
  let s = text.replace(EMOJI, "").replace(/«\s*/g, '"').replace(/\s*»/g, '"').replace(/[‘’‚´`ʼ«»“”„‹›…–—‑−→←·•×°½      ]/g, (c) => MAP[c] ?? c);
  s = s.split("\n").map((l) => l.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, "")).join("\n");
  return s.replace(/ +([,.!?;:])/g, (m, p) => (p === ":" || p === "!" || p === "?" || p === ";" ? m : p)).trim();
}

const GSM = new Set(Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"));
const GSM_EXT = new Set(Array.from("^{}\\[~]|€\f"));

/** How a text is sent: standard GSM characters or Unicode, its length in the units that count, and the number of segments. */
export function smsInfo(text: string): { unicode: boolean; units: number; segments: number } {
  const chars = Array.from(text);
  const unicode = chars.some((c) => !GSM.has(c) && !GSM_EXT.has(c));
  const units = unicode ? chars.reduce((n, c) => n + (c.codePointAt(0)! > 0xffff ? 2 : 1), 0) : chars.reduce((n, c) => n + (GSM_EXT.has(c) ? 2 : 1), 0);
  const single = unicode ? 70 : 160, multi = unicode ? 67 : 153;
  return { unicode, units, segments: units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi) };
}
