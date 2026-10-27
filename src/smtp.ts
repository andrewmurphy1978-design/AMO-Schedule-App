// A small SMTP client (AUTH PLAIN, optional STARTTLS) written against an abstract channel so the protocol
// can be unit-tested with a scripted fake. The Worker supplies a real socket in smtp-socket.ts.

export interface SmtpChannel {
  write(data: string): Promise<void>;
  readLine(): Promise<string>;          // one line without the trailing CRLF
  startTls?(): Promise<void>;           // upgrade the connection in place
}

export interface Mail { from: string; to: string; subject: string; text: string }
export interface SmtpOptions { user?: string; pass?: string; starttls?: boolean; clientName?: string }

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const b64wrapped = (s: string) => (b64(s).match(/.{1,76}/g) ?? [""]).join("\r\n");
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

export function buildMessage(m: Mail, date = new Date(), id = crypto.randomUUID()): string {
  const domain = (m.from.split("@")[1] ?? "localhost").replace(/[>\s].*$/, "");
  return [
    `From: ${m.from}`, `To: ${m.to}`, `Subject: ${encodeHeader(m.subject)}`, `Date: ${date.toUTCString()}`,
    `Message-ID: <${id}@${domain}>`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64",
    "", b64wrapped(m.text), "",
  ].join("\r\n");
}

async function reply(ch: SmtpChannel): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  for (;;) {
    const line = await ch.readLine();
    lines.push(line);
    if (line.length < 4 || line[3] !== "-") break; // "250-..." continues, "250 ..." ends
  }
  return { code: Number(lines[lines.length - 1].slice(0, 3)), text: lines.join(" | ") };
}

async function expect(ch: SmtpChannel, what: string, ...codes: number[]) {
  const r = await reply(ch);
  if (!codes.includes(r.code)) throw new Error(`SMTP ${what}: ${r.text}`.slice(0, 300));
  return r;
}

const addr = (s: string) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim();

export async function sendMail(ch: SmtpChannel, mail: Mail, opts: SmtpOptions = {}): Promise<void> {
  const name = opts.clientName ?? "amo-schedule";
  await expect(ch, "greeting", 220);
  await ch.write(`EHLO ${name}\r\n`);
  await expect(ch, "EHLO", 250);
  if (opts.starttls) {
    if (!ch.startTls) throw new Error("SMTP: STARTTLS not supported by this channel");
    await ch.write("STARTTLS\r\n");
    await expect(ch, "STARTTLS", 220);
    await ch.startTls();
    await ch.write(`EHLO ${name}\r\n`);
    await expect(ch, "EHLO (after TLS)", 250);
  }
  if (opts.user) {
    await ch.write(`AUTH PLAIN ${b64(`\0${opts.user}\0${opts.pass ?? ""}`)}\r\n`);
    await expect(ch, "AUTH", 235);
  }
  await ch.write(`MAIL FROM:<${addr(mail.from)}>\r\n`);
  await expect(ch, "MAIL FROM", 250);
  await ch.write(`RCPT TO:<${addr(mail.to)}>\r\n`);
  await expect(ch, "RCPT TO", 250, 251);
  await ch.write("DATA\r\n");
  await expect(ch, "DATA", 354);
  await ch.write(`${buildMessage(mail)}\r\n.\r\n`);
  await expect(ch, "message", 250);
  await ch.write("QUIT\r\n").catch(() => {});
}
