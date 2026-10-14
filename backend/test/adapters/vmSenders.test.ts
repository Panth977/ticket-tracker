/**
 * The VM's own senders: SMTP (adapters/smtp.ts) against a fake SMTP server,
 * and Web Push (adapters/webPush.ts) checked the way a browser's push
 * service and the browser itself check it — the VAPID signature verifies
 * with the public key, and the subscription's private key decrypts the body.
 */
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMime, parseSmtpUrl, smtpEmail } from '../../src/adapters/smtp.js';
import { encryptPayload, newVapidKeys, parseWebPushToken, webPush, WEBPUSH_PREFIX } from '../../src/adapters/webPush.js';

// ─── SMTP ────────────────────────────────────────────────────────────────────

const received: { auth: string[]; from: string; to: string[]; data: string }[] = [];
const server = createServer((s: Socket) => {
  const cur = { auth: [] as string[], from: '', to: [] as string[], data: '' };
  let inData = false;
  let buf = '';
  s.write('220 fake ESMTP\r\n');
  s.on('data', (d) => {
    buf += d.toString('utf8');
    for (;;) {
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        cur.data = buf.slice(0, end);
        buf = buf.slice(end + 5);
        inData = false;
        received.push(cur);
        s.write('250 2.0.0 queued as ABC\r\n');
        continue;
      }
      const nl = buf.indexOf('\r\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      if (line.startsWith('EHLO')) s.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
      else if (line.startsWith('AUTH PLAIN')) {
        cur.auth = Buffer.from(line.slice(11), 'base64').toString().split('\0');
        s.write(cur.auth[2] === 'secret' ? '235 ok\r\n' : '535 bad\r\n');
      } else if (line.startsWith('MAIL FROM:')) {
        cur.from = line.slice(10);
        s.write('250 ok\r\n');
      } else if (line.startsWith('RCPT TO:')) {
        cur.to.push(line.slice(8));
        s.write('250 ok\r\n');
      } else if (line === 'DATA') {
        inData = true;
        s.write('354 go\r\n');
      } else if (line === 'QUIT') s.end('221 bye\r\n');
      else s.write('500 ?\r\n');
    }
  });
});
let port = 0;
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('smtp sender', () => {
  it('parses SMTP_URL', () => {
    expect(parseSmtpUrl('smtps://a%40b.c:p%40ss@mail.x:465')).toMatchObject({ host: 'mail.x', port: 465, secure: true, user: 'a@b.c', pass: 'p@ss' });
    expect(parseSmtpUrl('smtp://mail.x')).toMatchObject({ port: 587, secure: false, startTls: 'require' });
    expect(parseSmtpUrl('smtp://mail.x:25?tls=off').startTls).toBe('off');
  });

  it('sends a multipart message with auth; UTF-8 survives', async () => {
    const mail = smtpEmail(`smtp://me:secret@127.0.0.1:${port}?tls=off`, 'TaskManager <notify@example.test>');
    const r = await mail.send({ to: 'Zoë <zoe@example.test>', subject: 'Héllo ✓', text: 'line one\n.\nline three — ✓', html: '<p>hi ✓</p>', headers: { 'List-Unsubscribe': '<https://x/u>' } });
    expect(r.providerId).toContain('queued');
    const m = received.at(-1)!;
    expect(m.auth).toEqual(['', 'me', 'secret']);
    expect(m.from).toBe('<notify@example.test>');
    expect(m.to).toEqual(['<zoe@example.test>']);
    expect(m.data).toContain('Subject: =?UTF-8?B?');
    expect(m.data).toContain('List-Unsubscribe: <https://x/u>');
    const parts = [...m.data.matchAll(/base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)].map((x) => Buffer.from(x[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8'));
    expect(parts).toEqual(['line one\n.\nline three — ✓', '<p>hi ✓</p>']);
  });

  it('refuses a plain-text server unless told to allow it; bad password fails', async () => {
    await expect(smtpEmail(`smtp://127.0.0.1:${port}`, 'a@b.c').send({ to: 'x@y.z', subject: 's', text: 't' })).rejects.toThrow(/STARTTLS/);
    await expect(smtpEmail(`smtp://me:wrong@127.0.0.1:${port}?tls=off`, 'a@b.c').send({ to: 'x@y.z', subject: 's', text: 't' })).rejects.toThrow(/535/);
  });

  it('never lets a header value inject lines', () => {
    const mime = buildMime({ to: 'x@y.z', from: 'a@b.c', subject: 'a\r\nBcc: evil@x', text: 't' }, 'h');
    expect(mime).not.toMatch(/^Bcc:/m);
  });
});

// ─── Web Push ────────────────────────────────────────────────────────────────

/** The browser's side: a subscription key pair and the auth secret. */
function browser() {
  const ecdh = createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const auth = randomBytes(16);
  const sub = { endpoint: 'https://push.example.test/send/abc', keys: { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') } };
  return { ecdh, pub, auth, sub, token: WEBPUSH_PREFIX + Buffer.from(JSON.stringify(sub)).toString('base64url') };
}

/** RFC 8291 decryption, as the browser does it. */
function decrypt(b: ReturnType<typeof browser>, body: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = b.ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, b.auth, Buffer.concat([Buffer.from('WebPush: info\0'), b.pub, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  expect(plain.at(-1)).toBe(2); // the last-record delimiter
  return plain.subarray(0, -1).toString('utf8');
}

describe('web push sender', () => {
  it('encrypts so the subscription can decrypt', () => {
    const b = browser();
    expect(decrypt(b, encryptPayload(b.sub, Buffer.from('hello ✓')))).toBe('hello ✓');
  });

  it('sends a VAPID-signed, encrypted notification; 410 = unregistered', async () => {
    const keys = newVapidKeys();
    process.env.TM_VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.TM_VAPID_PRIVATE_KEY = keys.privateKey;
    const b = browser();
    const gone = browser();
    gone.sub.endpoint = 'https://push.example.test/send/gone';
    const goneToken = WEBPUSH_PREFIX + Buffer.from(JSON.stringify(gone.sub)).toString('base64url');
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: url.endsWith('gone') ? 410 : 201, headers: { location: 'm1' } });
    }) as unknown as typeof fetch;
    const res = await webPush(fake).send([b.token, goneToken, 'webpush:garbage'], { title: 'T', body: 'B', url: '/t/1', tag: 'x' });
    expect(res.map((r) => [r.ok, !!r.unregistered])).toEqual([[true, false], [false, true], [false, true]]);

    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h['content-encoding']).toBe('aes128gcm');
    const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h.authorization!)!;
    expect(k).toBe(keys.publicKey);
    const [head, claims, sig] = t!.split('.');
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({ aud: 'https://push.example.test' });
    const pub = Buffer.from(k!, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'))).toBe(true);

    const shown = JSON.parse(decrypt(b, Buffer.from(calls[0]!.init.body as Uint8Array)));
    expect(shown).toEqual({ notification: { title: 'T', body: 'B', tag: 'x' }, data: { url: '/t/1' } });
  });

  it('only https endpoints are subscriptions', () => {
    const b = browser();
    b.sub.endpoint = 'http://169.254.169.254/latest';
    expect(parseWebPushToken(WEBPUSH_PREFIX + Buffer.from(JSON.stringify(b.sub)).toString('base64url'))).toBeNull();
  });
});
