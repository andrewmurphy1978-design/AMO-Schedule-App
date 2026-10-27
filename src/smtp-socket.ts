// Real SMTP connection for Cloudflare Workers (TCP sockets). secure: 'implicit' = TLS from the start (port 465),
// 'starttls' = upgrade after EHLO (port 587), 'none' = plain (local testing only).
import { connect } from "cloudflare:sockets";
import { sendMail, type Mail, type SmtpChannel } from "./smtp.ts";

export interface SmtpConfig { host: string; port: number; secure: "implicit" | "starttls" | "none"; user?: string; pass?: string }

export async function sendMailOverSocket(cfg: SmtpConfig, mail: Mail): Promise<void> {
  let socket = connect({ hostname: cfg.host, port: cfg.port }, { secureTransport: cfg.secure === "implicit" ? "on" : cfg.secure === "starttls" ? "starttls" : "off", allowHalfOpen: false });
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buf = "";
  const channel: SmtpChannel = {
    write: (data) => writer.write(enc.encode(data)),
    async readLine() {
      for (;;) {
        const i = buf.indexOf("\r\n");
        if (i >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); return line; }
        const { value, done } = await reader.read();
        if (done) throw new Error("SMTP: connection closed");
        buf += dec.decode(value, { stream: true });
      }
    },
    async startTls() {
      reader.releaseLock(); writer.releaseLock();
      socket = socket.startTls();
      reader = socket.readable.getReader(); writer = socket.writable.getWriter();
      buf = "";
    },
  };
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("SMTP: timeout")), 20000));
  try {
    await Promise.race([sendMail(channel, mail, { user: cfg.user, pass: cfg.pass, starttls: cfg.secure === "starttls" }), timeout]);
  } finally {
    try { await socket.close(); } catch { /* already closed */ }
  }
}
