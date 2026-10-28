// Twilio / SMTP connection settings. Values come from environment variables (preferred) or from the `settings`
// table (entered by an admin in the app). Pure so it can be tested; secrets are never returned to the browser.
import type { TwilioConfig } from "./twilio.ts";

export interface SmtpSettings { host: string; port: number; secure: "implicit" | "starttls" | "none"; user?: string; pass?: string; from: string }
export interface Connections { twilio: TwilioConfig | null; smtp: SmtpSettings | null; appUrl: string; brand?: string }

export interface ConnEnv {
  TWILIO_ACCOUNT_SID?: string; TWILIO_AUTH_TOKEN?: string; TWILIO_FROM?: string; TWILIO_API_BASE?: string;
  SMTP_HOST?: string; SMTP_PORT?: string; SMTP_SECURE?: string; SMTP_USER?: string; SMTP_PASS?: string; SMTP_FROM?: string;
  APP_URL?: string;
}

export const CONN_KEYS = ["conn_twilio_sid", "conn_twilio_token", "conn_twilio_from", "conn_smtp_host", "conn_smtp_port", "conn_smtp_secure", "conn_smtp_user", "conn_smtp_pass", "conn_smtp_from"] as const;

export function parseConnections(rows: { key: string; value: string }[], env: ConnEnv): Connections {
  const db = new Map(rows.map((r) => [r.key, r.value]));
  const pick = (envVal: string | undefined, key: string) => (envVal && envVal.trim() ? envVal.trim() : db.get(key)?.trim() || undefined);
  const sid = pick(env.TWILIO_ACCOUNT_SID, "conn_twilio_sid"), token = pick(env.TWILIO_AUTH_TOKEN, "conn_twilio_token"), from = pick(env.TWILIO_FROM, "conn_twilio_from");
  const host = pick(env.SMTP_HOST, "conn_smtp_host"), mailFrom = pick(env.SMTP_FROM, "conn_smtp_from");
  const secureRaw = pick(env.SMTP_SECURE, "conn_smtp_secure");
  const secure = secureRaw === "starttls" || secureRaw === "none" ? secureRaw : "implicit";
  const port = Number(pick(env.SMTP_PORT, "conn_smtp_port")) || (secure === "starttls" ? 587 : secure === "none" ? 25 : 465);
  return {
    twilio: sid && token && from ? { sid, token, from, apiBase: env.TWILIO_API_BASE } : null,
    smtp: host && mailFrom ? { host, port, secure, user: pick(env.SMTP_USER, "conn_smtp_user"), pass: pick(env.SMTP_PASS, "conn_smtp_pass"), from: mailFrom } : null,
    appUrl: (env.APP_URL ?? "").replace(/\/+$/, ""),
  };
}

/** What the admin screen may see: whether each channel is set up and the non-secret details. */
export function publicConnectionView(c: Connections) {
  return {
    sms: { configured: !!c.twilio, sid_hint: c.twilio ? `…${c.twilio.sid.slice(-4)}` : null, from: c.twilio?.from ?? null },
    email: { configured: !!c.smtp, host: c.smtp?.host ?? null, port: c.smtp?.port ?? null, secure: c.smtp?.secure ?? null, user: c.smtp?.user ?? null, from: c.smtp?.from ?? null },
    app_url: c.appUrl || null,
  };
}

export type Channel = "sms" | "email";
export interface Contactable { phone: string | null; email: string | null; notify_channel: string }

/** The employee's preferred channel if it works; otherwise the other one; otherwise null (nothing can be sent). */
export function pickChannel(person: Contactable, available: { sms: boolean; email: boolean }): Channel | null {
  const ok: Record<Channel, boolean> = { sms: available.sms && !!person.phone, email: available.email && !!person.email };
  const preferred: Channel = person.notify_channel === "email" ? "email" : "sms";
  const other: Channel = preferred === "sms" ? "email" : "sms";
  return ok[preferred] ? preferred : ok[other] ? other : null;
}
