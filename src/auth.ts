// In-app sign-in helpers: 6-digit one-time codes, session tokens, cookies. Pure / Web Crypto only, so they can be tested.

export const CODE_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const MAX_CODES_PER_HOUR = 5;
export const MIN_GAP_MS = 30 * 1000;
export const COOKIE_NAME = "sid";

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Uniformly random 6-digit code (rejection sampling, no modulo bias). */
export function newCode(): string {
  const a = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
  do crypto.getRandomValues(a); while (a[0] >= limit);
  return String(a[0] % 1_000_000).padStart(6, "0");
}

export function newSessionToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const codeHash = (pepper: string, email: string, code: string) => sha256Hex(`${pepper}:${email.toLowerCase()}:${code}`);

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

export const sessionCookie = (token: string, secure: boolean) =>
  `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`;
export const clearCookie = (secure: boolean) => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

export const looksLikeEmail = (s: string) => s.length <= 200 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

export function loginMessage(lang: "fr" | "en", code: string, brand = "Mikes"): { subject: string; text: string } {
  return lang === "en"
    ? { subject: `Your ${brand} sign-in code: ${code}`, text: `Your sign-in code is ${code}.\nIt is valid for 10 minutes. If you did not ask for it, ignore this message.` }
    : { subject: `Ton code de connexion ${brand} : ${code}`, text: `Ton code de connexion est ${code}.\nIl est valide 10 minutes. Si tu ne l’as pas demandé, ignore ce message.` };
}
