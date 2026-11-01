// Speech to text for the voice and video messages of communities (Cloudflare Workers AI, Whisper). Best effort: no AI binding or a failure = no transcript.

export interface AiBinding { run(model: string, input: Record<string, unknown>): Promise<unknown> }
export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const MAX_TRANSCRIBE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 25_000;

const toBase64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

export async function transcribe(ai: AiBinding | undefined, bytes: Uint8Array, lang: "fr" | "en"): Promise<string | null> {
  if (!ai || !bytes.length || bytes.length > MAX_TRANSCRIBE_BYTES) return null;
  try {
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS));
    const out = (await Promise.race([ai.run(WHISPER_MODEL, { audio: toBase64(bytes), language: lang }), timeout])) as { text?: unknown } | null;
    const text = typeof out?.text === "string" ? out.text.replace(/\s+/g, " ").trim() : "";
    return text ? text.slice(0, 4000) : null;
  } catch { return null; }
}
