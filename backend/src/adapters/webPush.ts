/**
 * WEB PUSH on a VM — what FCM does for the Firebase deploy, straight to the
 * browser's push service (RFC 8030), encrypted (RFC 8291, aes128gcm) and
 * signed with this server's VAPID key (RFC 8292). node:crypto only.
 *
 * A device's `fcmToken` on a VM is `webpush:` + base64url(JSON of the
 * browser's PushSubscription) — the VM build's firebase/messaging shim
 * writes it. The VAPID key pair is TM_VAPID_PUBLIC_KEY / TM_VAPID_PRIVATE_KEY
 * (base64url, raw P-256), or generated once and kept in _config/vapid
 * (ensureVapid, called by the VM server at start).
 */
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto';
import type { PushMessage, PushResult, PushSender } from '@tm/shared';
import { db } from '../db/index.js';

export const WEBPUSH_PREFIX = 'webpush:';
const VAPID_DOC = '_config/vapid';

interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

/** Make sure a VAPID key pair is in process.env (from the database, made once). */
export async function ensureVapid(): Promise<{ publicKey: string }> {
  if (!process.env.TM_VAPID_PUBLIC_KEY || !process.env.TM_VAPID_PRIVATE_KEY) {
    const ref = db().doc(VAPID_DOC);
    const keys = await db().runTransaction(async (tx) => {
      const have = (await tx.get(ref)).data() as { publicKey?: string; privateKey?: string } | undefined;
      if (have?.publicKey && have.privateKey) return have as { publicKey: string; privateKey: string };
      const fresh = newVapidKeys();
      tx.set(ref, { ...fresh, createdAt: Date.now() });
      return fresh;
    });
    process.env.TM_VAPID_PUBLIC_KEY ||= keys.publicKey;
    process.env.TM_VAPID_PRIVATE_KEY ||= keys.privateKey;
  }
  return { publicKey: process.env.TM_VAPID_PUBLIC_KEY! };
}

export function newVapidKeys(): { publicKey: string; privateKey: string } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x!), unb64u(jwk.y!)])),
    privateKey: jwk.d!,
  };
}

/** The VAPID Authorization header for a push service origin. */
function vapidAuth(endpoint: string, publicKey: string, privateKey: string, subject: string): string {
  const pub = unb64u(publicKey);
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(
    Buffer.from(
      JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }),
    ),
  );
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

/** RFC 8291: the payload encrypted for one subscription (one aes128gcm record). */
export function encryptPayload(sub: Subscription, payload: Buffer, salt = randomBytes(16)): Buffer {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const ecdh = createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

export function parseWebPushToken(token: string): Subscription | null {
  if (!token.startsWith(WEBPUSH_PREFIX)) return null;
  try {
    const s = JSON.parse(unb64u(token.slice(WEBPUSH_PREFIX.length)).toString('utf8')) as Subscription;
    const url = new URL(s.endpoint);
    if (url.protocol !== 'https:' || !s.keys?.p256dh || !s.keys.auth) return null;
    return s;
  } catch {
    return null;
  }
}

export function webPush(fetchImpl: typeof fetch = fetch): PushSender {
  return {
    async send(tokens: string[], msg: PushMessage): Promise<PushResult[]> {
      if (tokens.length === 0) return [];
      const { publicKey } = await ensureVapid();
      const privateKey = process.env.TM_VAPID_PRIVATE_KEY!;
      const subject = process.env.TM_VAPID_SUBJECT || `mailto:${process.env.TM_ADMIN_EMAIL || 'admin@localhost'}`;
      // The shape the service worker (static/firebase-messaging-sw.js) shows.
      const payload = Buffer.from(
        JSON.stringify({
          notification: { title: msg.title, body: msg.body, ...(msg.tag ? { tag: msg.tag } : {}) },
          data: { ...(msg.data ?? {}), ...(msg.url ? { url: msg.url } : {}) },
        }),
      );
      return Promise.all(
        tokens.map(async (token): Promise<PushResult> => {
          const sub = parseWebPushToken(token);
          if (!sub) return { token, ok: false, unregistered: true, error: 'webpush/invalid-subscription' };
          try {
            const res = await fetchImpl(sub.endpoint, {
              method: 'POST',
              headers: {
                authorization: vapidAuth(sub.endpoint, publicKey, privateKey, subject),
                'content-encoding': 'aes128gcm',
                'content-type': 'application/octet-stream',
                ttl: '86400',
                urgency: 'high',
              },
              body: encryptPayload(sub, payload),
            });
            if (res.ok) return { token, ok: true, providerId: res.headers.get('location') };
            const gone = res.status === 404 || res.status === 410;
            return { token, ok: false, unregistered: gone, error: `webpush/http-${res.status}` };
          } catch (e) {
            return { token, ok: false, error: `webpush/network: ${(e as Error).message}` };
          }
        }),
      );
    },
  };
}
