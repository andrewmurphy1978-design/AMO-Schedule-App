// Password sign-in: PBKDF2-SHA256 (Workers allow at most 100 000 iterations), a random salt per password, constant-time compare.
import { safeEqual } from "./auth.ts";

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
export const PBKDF2_ITERATIONS = 100_000;
export const MAX_PASSWORD_FAILS = 5;
export const PASSWORD_LOCK_MS = 15 * 60 * 1000;

const toB64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return toB64(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256));
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string; iterations: number }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: await derive(password, salt, PBKDF2_ITERATIONS), salt: toB64(salt), iterations: PBKDF2_ITERATIONS };
}

export async function verifyPassword(password: string, rec: { hash: string; salt: string; iterations: number }): Promise<boolean> {
  return safeEqual(await derive(password, fromB64(rec.salt), rec.iterations), rec.hash);
}

/** Why a new password is refused, or null when it is acceptable. */
export function passwordProblem(password: unknown, email?: string): "too_short" | "too_long" | "too_common" | "invalid" | null {
  if (typeof password !== "string") return "invalid";
  if (password.length < PASSWORD_MIN) return "too_short";
  if (password.length > PASSWORD_MAX) return "too_long";
  const low = password.toLowerCase();
  if (/^(.)\1+$/.test(password) || ["0123456789", "1234567890", "password12", "motdepasse", "azertyuiop", "qwertyuiop"].some((w) => low.includes(w))) return "too_common";
  const local = (email ?? "").toLowerCase().split("@")[0].replace(/\d+$/, "");
  if (local.length >= 4 && low.includes(local)) return "too_common"; // contains the name from the email address
  return null;
}
