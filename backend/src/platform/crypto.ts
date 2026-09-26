/**
 * Small crypto helpers for the platform doors: hashing credentials (API keys,
 * OAuth tokens, intake secrets are stored ONLY as sha256), random base62
 * secrets, HMAC signatures and constant-time comparison.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isEmulated } from '../runtime/firebase.js';

export const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export const sha256b64url = (s: string): string =>
  createHash('sha256').update(s).digest('base64url');

export const hmacHex = (key: string | Buffer, data: string): string =>
  createHmac('sha256', key).update(data).digest('hex');

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** `len` uniformly random base62 characters (rejection sampling: no modulo bias). */
export function base62(len: number): string {
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < 248) out += B62[b % 62];
      if (out.length === len) break;
    }
  }
  return out;
}

/** Constant-time string equality (false on length mismatch, without leaking where). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const DEV_SIGNING_KEY = 'tm-dev-signing-key--never-use-in-production';

/**
 * The server's own secret for derived values (webhook signing secrets, OAuth
 * install `state`, ICS feed tokens). TM_SIGNING_KEY in production; a fixed dev
 * key under the emulators so derived values are stable across restarts.
 */
export function signingKey(): string {
  const k = process.env.TM_SIGNING_KEY;
  if (k) return k;
  if (isEmulated()) return DEV_SIGNING_KEY;
  throw new Error('TM_SIGNING_KEY is not set');
}

/** HMAC with the server key, namespaced by purpose so one derivation can never stand in for another. */
export const serverMac = (purpose: string, data: string): string =>
  createHmac('sha256', signingKey()).update(`${purpose}\n${data}`).digest('base64url');
