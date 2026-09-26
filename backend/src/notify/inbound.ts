/**
 * Pure helpers for the inbound hooks (/hooks/email, /hooks/whatsapp):
 * provider signatures, address parsing, and cutting a reply down to what the
 * person actually wrote.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// ─── signatures ──────────────────────────────────────────────────────────────

const safeEq = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Svix (Resend webhooks) tolerates this much clock skew. */
export const SVIX_TOLERANCE_S = 5 * 60;

/**
 * Resend signs webhooks with Svix: `svix-signature: v1,<base64 hmac>` over
 * `${svix-id}.${svix-timestamp}.${body}`, keyed by the base64 part of 'whsec_…'.
 */
export function verifySvix(
  headers: {
    id?: string | undefined;
    timestamp?: string | undefined;
    signature?: string | undefined;
  },
  body: string,
  secret: string,
  nowMs: number,
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > SVIX_TOLERANCE_S) return false;
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const want = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return signature
    .split(' ')
    .map((s) => s.split(',', 2))
    .some(([v, sig]) => v === 'v1' && !!sig && safeEq(sig, want));
}

/** Svix headers for a body — what our tests (and a local replay tool) send. */
export function signSvix(
  body: string,
  secret: string,
  id: string,
  timestampS: number,
): Record<string, string> {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${timestampS}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(timestampS), 'svix-signature': `v1,${sig}` };
}

/** Meta: `X-Hub-Signature-256: sha256=<hex hmac(appSecret, rawBody)>`. */
export function verifyMetaSignature(
  header: string | undefined,
  body: string,
  appSecret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const want = createHmac('sha256', appSecret).update(body).digest('hex');
  return safeEq(header.slice(7).toLowerCase(), want);
}
export const signMeta = (body: string, appSecret: string): string =>
  `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`;

// ─── addresses and ids ───────────────────────────────────────────────────────

/** 'Priya Shah <Priya@X.com>' → { name: 'Priya Shah', email: 'priya@x.com' }. */
export function parseAddress(raw: string): { name: string | null; email: string } | null {
  const s = raw.trim();
  const m = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(s);
  const email = (m ? m[2]! : s).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  const name = m
    ? m[1]!
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .trim() || null
    : null;
  return { name, email };
}

/** 'a@x, B <b@y>' or an array of either → parsed addresses. */
export function parseAddressList(v: unknown): { name: string | null; email: string }[] {
  const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return items
    .map((x) =>
      typeof x === 'string'
        ? parseAddress(x)
        : x && typeof x === 'object' && 'email' in x
          ? parseAddress(String((x as { email: unknown }).email))
          : null,
    )
    .filter((x): x is { name: string | null; email: string } => !!x);
}

/** A stable command clientId ([A-Za-z0-9_-], ≤ 64) from a provider message id. */
export const clientIdFrom = (prefix: string, key: string): string =>
  `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;

// ─── reply text ──────────────────────────────────────────────────────────────

/** The line that introduces quoted history, in the clients people actually use. */
const QUOTE_HEADERS: RegExp[] = [
  /^On .{0,300}wrote:\s*$/i, // Gmail / Apple Mail
  /^-{2,}\s*Original Message\s*-{2,}/i, // Outlook
  /^_{5,}\s*$/, // Outlook web separator
  /^From:\s.+/i, // Outlook headers block
  /^Sent from my /i, // mobile signatures
  /^Le .{0,300}a écrit\s*:\s*$/i,
  /^Am .{0,300}schrieb .{0,200}:\s*$/i,
];

/**
 * Keep what the person wrote above the quoted history (talon-style, the
 * common cases): stop at a quote header, drop '>' lines and the '-- '
 * signature, trim trailing blank lines.
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  // Gmail wraps a long "On … wrote:" over two lines; join it for the test.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const joined = i + 1 < lines.length ? `${line} ${lines[i + 1]}` : line;
    if (line.trim() === '--' || line === '-- ') break;
    if (
      QUOTE_HEADERS.some((re) => re.test(line.trim())) ||
      (/^On /i.test(line.trim()) && /wrote:\s*$/i.test(joined.trim()))
    )
      break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out
    .join('\n')
    .replace(/\s+$/, '')
    .replace(/^\s*\n/, '');
}

/** Minimal HTML → text for mails without a text part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A file name safe as one Storage path segment. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const clean = base
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return clean || 'file';
}
