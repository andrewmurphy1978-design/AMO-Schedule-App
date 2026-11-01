// Assisted phone calls for a person who cannot speak or hear: what they type is read aloud to the person on the line (text to speech),
// and what that person answers is turned into text (speech to text). Pure helpers: TwiML for Twilio and text clean-up.

export const VOICE_MAX_CHARS = 500;
export const VOICE_IDLE_MS = 150_000; // nobody typed or answered for this long: the line is closed politely
export const VOICE_MAX_SECONDS = 900;

export type VoiceLang = "fr" | "en";
const LOCALE: Record<VoiceLang, string> = { fr: "fr-CA", en: "en-CA" };

export const xmlEscape = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Text typed by the owner or heard on the line: no control characters, single spaces, a sensible length. */
export function cleanSpeech(text: unknown, max = VOICE_MAX_CHARS): string {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export const intro = (lang: VoiceLang, callerFirstName: string) => lang === "fr"
  ? `Bonjour. Ceci est un appel de ${callerFirstName}, qui ne peut ni parler ni entendre. Son message écrit est lu par un ordinateur. Répondez à voix haute après le message : votre réponse lui sera envoyée par texto. Voici son message.`
  : `Hello. This is a call from ${callerFirstName}, who can neither speak nor hear. The written message is read by a computer. Answer out loud after the message: your answer will be sent to them as a text. Here is the message.`;

export const goodbye = (lang: VoiceLang) => lang === "fr" ? "Je n'entends plus personne. Merci et au revoir." : "I can no longer hear anyone. Thank you, goodbye.";

const head = '<?xml version="1.0" encoding="UTF-8"?>';
const say = (text: string, lang: VoiceLang) => `<Say voice="alice" language="${LOCALE[lang]}">${xmlEscape(text)}</Say>`;
const gather = (lang: VoiceLang, actionUrl: string, timeout: number, inner = "") =>
  `<Gather input="speech" language="${LOCALE[lang]}" speechTimeout="auto" timeout="${timeout}" action="${xmlEscape(actionUrl)}" method="POST" actionOnEmptyResult="false">${inner}</Gather>`;

/** Say a written message, then listen for the answer; when nothing is said, come back to see whether something new was typed. */
export function sayAndListen(text: string, lang: VoiceLang, heardUrl: string, talkUrl: string): string {
  return `${head}<Response>${gather(lang, heardUrl, 10, say(text, lang))}<Redirect method="POST">${xmlEscape(talkUrl)}</Redirect></Response>`;
}
/** Nothing to say right now: listen for a few seconds, then check again. */
export function listenOnly(lang: VoiceLang, heardUrl: string, talkUrl: string): string {
  return `${head}<Response>${gather(lang, heardUrl, 4)}<Redirect method="POST">${xmlEscape(talkUrl)}</Redirect></Response>`;
}
export const hangUp = (lang: VoiceLang, text?: string) => `${head}<Response>${text ? say(text, lang) : ""}<Hangup/></Response>`;
export const redirectTo = (url: string) => `${head}<Response><Redirect method="POST">${xmlEscape(url)}</Redirect></Response>`;
