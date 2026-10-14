/**
 * EmailSender over SMTP — for a VM that sends through its own mail server or
 * any provider's SMTP relay instead of Resend. node:net / node:tls only.
 *
 *   SMTP_URL = smtp://user:pass@host:587    (STARTTLS when offered; required unless ?tls=off)
 *            | smtps://user:pass@host:465   (TLS from the first byte)
 *
 * User and password are URL-encoded in the URL. One connection per message:
 * transactional volume, no pool to go stale.
 */
import { randomBytes } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { EmailMessage, EmailSender } from '@tm/shared';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  startTls: 'require' | 'try' | 'off';
  user?: string;
  pass?: string;
  /** Tests: accept a self-signed server certificate. */
  rejectUnauthorized?: boolean;
}

export function parseSmtpUrl(raw: string): SmtpConfig {
  const u = new URL(raw);
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') throw new Error('SMTP_URL must be smtp:// or smtps://');
  const secure = u.protocol === 'smtps:';
  const tls = u.searchParams.get('tls');
  return {
    host: u.hostname,
    port: Number(u.port || (secure ? 465 : 587)),
    secure,
    startTls: secure ? 'off' : tls === 'off' ? 'off' : tls === 'try' ? 'try' : 'require',
    ...(u.username ? { user: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { pass: decodeURIComponent(u.password) } : {}),
    rejectUnauthorized: u.searchParams.get('verify') !== 'off',
  };
}

/** A line reader over a socket: reads whole SMTP replies (multi-line included). */
class Conversation {
  private buf = '';
  private waiters: (() => void)[] = [];
  private closed: Error | null = null;
  constructor(public socket: Socket | TLSSocket) {
    this.attach(socket);
  }
  attach(socket: Socket | TLSSocket): void {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => {
      this.buf += d;
      this.wake();
    });
    socket.on('error', (e) => {
      this.closed = e;
      this.wake();
    });
    socket.on('close', () => {
      this.closed ??= new Error('SMTP connection closed');
      this.wake();
    });
  }
  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }
  async reply(): Promise<{ code: number; lines: string[] }> {
    for (;;) {
      const lines = this.buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i]!) || /^\d{3}$/.test(lines[i]!)) {
          const all = lines.slice(0, i + 1);
          this.buf = lines.slice(i + 1).join('\r\n');
          return { code: Number(all[i]!.slice(0, 3)), lines: all.map((l) => l.slice(4)) };
        }
      }
      if (this.closed) throw this.closed;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
  async cmd(line: string, expect: number[], secret = false): Promise<string[]> {
    this.socket.write(`${line}\r\n`);
    const r = await this.reply();
    if (!expect.includes(r.code))
      throw new Error(`SMTP ${secret ? line.split(' ')[0] : line.slice(0, 40)} → ${r.code} ${r.lines.join(' ').slice(0, 200)}`);
    return r.lines;
  }
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const wrap = (s: string) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();
const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
/** "Name <a@b>" → encoded display name, address kept. */
function encodeAddress(a: string): string {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(a);
  return m && m[1] ? `${encodeWord(m[1].replace(/^"|"$/g, ''))} <${m[2]}>` : a.trim();
}
const bareAddress = (a: string) => (/<([^>]+)>/.exec(a)?.[1] ?? a).trim();
const noCrlf = (s: string) => s.replace(/[\r\n]+/g, ' ');

/** The RFC 5322 message, base64 bodies (any UTF-8 is safe; no dot-stuffing surprises). */
export function buildMime(msg: EmailMessage & { from: string }, host: string): string {
  const to = [msg.to].flat();
  const own = new Set(Object.keys(msg.headers ?? {}).map((k) => k.toLowerCase()));
  const headers: string[] = [
    `From: ${encodeAddress(noCrlf(msg.from))}`,
    `To: ${to.map((t) => encodeAddress(noCrlf(t))).join(', ')}`,
    `Subject: ${encodeWord(noCrlf(msg.subject))}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
  ];
  if (!own.has('message-id')) headers.push(`Message-ID: <${randomBytes(12).toString('hex')}@${host}>`);
  if (msg.replyTo) headers.push(`Reply-To: ${encodeAddress(noCrlf(msg.replyTo))}`);
  for (const [k, v] of Object.entries(msg.headers ?? {}))
    if (/^[A-Za-z0-9-]+$/.test(k)) headers.push(`${k}: ${noCrlf(String(v))}`);
  const part = (type: string, body: string) =>
    [`Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', wrap(b64(body))].join('\r\n');
  if (!msg.html) return [...headers, part('text/plain', msg.text)].join('\r\n');
  const boundary = `tm_${randomBytes(12).toString('hex')}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    part('text/plain', msg.text),
    `--${boundary}`,
    part('text/html', msg.html),
    `--${boundary}--`,
  ].join('\r\n');
}

function open(cfg: SmtpConfig): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = cfg.secure
      ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized ?? true }, () => resolve(s))
      : netConnect({ host: cfg.host, port: cfg.port }, () => resolve(s));
    s.setTimeout(30_000, () => s.destroy(new Error('SMTP timeout')));
    s.once('error', reject);
  });
}

export async function sendSmtp(cfg: SmtpConfig, msg: EmailMessage & { from: string }): Promise<string> {
  const me = 'taskmanager.local';
  const c = new Conversation(await open(cfg));
  try {
    const hello = await c.reply();
    if (hello.code !== 220) throw new Error(`SMTP greeting ${hello.code}`);
    let caps = await c.cmd(`EHLO ${me}`, [250]);
    if (!cfg.secure && cfg.startTls !== 'off') {
      if (caps.some((l) => /^STARTTLS\b/i.test(l))) {
        await c.cmd('STARTTLS', [220]);
        const plain = c.socket;
        plain.removeAllListeners('data');
        const secured = await new Promise<TLSSocket>((resolve, reject) => {
          const t = tlsConnect({ socket: plain, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized ?? true }, () => resolve(t));
          t.once('error', reject);
        });
        c.attach(secured);
        caps = await c.cmd(`EHLO ${me}`, [250]);
      } else if (cfg.startTls === 'require') throw new Error('SMTP server does not offer STARTTLS (add ?tls=off to allow plain text)');
    }
    if (cfg.user) {
      const auth = caps.find((l) => /^AUTH\b/i.test(l)) ?? '';
      if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth))
        await c.cmd(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass ?? ''}`).toString('base64')}`, [235], true);
      else {
        await c.cmd('AUTH LOGIN', [334]);
        await c.cmd(b64(cfg.user), [334], true);
        await c.cmd(b64(cfg.pass ?? ''), [235], true);
      }
    }
    await c.cmd(`MAIL FROM:<${bareAddress(msg.from)}>`, [250]);
    for (const t of [msg.to].flat()) await c.cmd(`RCPT TO:<${bareAddress(t)}>`, [250, 251]);
    await c.cmd('DATA', [354]);
    const mime = buildMime(msg, me).replace(/^\./gm, '..');
    const done = await c.cmd(`${mime}\r\n.`, [250]);
    await c.cmd('QUIT', [221]).catch(() => {});
    return done.join(' ').slice(0, 200);
  } finally {
    c.socket.destroy();
  }
}

export function smtpEmail(url: string, defaultFrom: string): EmailSender {
  const cfg = parseSmtpUrl(url);
  return {
    async send(msg: EmailMessage) {
      const providerId = await sendSmtp(cfg, { ...msg, from: msg.from ?? defaultFrom });
      return { providerId };
    },
  };
}
