/**
 * Tokens of the local identity: compact JWTs (HS256) signed with a key
 * derived from the server's signing key, and scrypt password hashes.
 *
 *   ID token       1 hour, what `Authorization: Bearer` carries (as a
 *                  Firebase ID token does)
 *   custom token   5 minutes, exchanged once for a session
 *
 * Each kind has its own key (HMAC(signingKey, purpose)), so one can never
 * stand in for another.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { signingKey } from '../../platform/crypto.js';
import { IdentityError } from '../types.js';

export const ISSUER = 'taskmanager';
export const ID_TOKEN_TTL_S = 3600;
export const CUSTOM_TOKEN_TTL_S = 300;

type Purpose = 'id' | 'custom';

const keyFor = (purpose: Purpose) =>
  createHmac('sha256', signingKey()).update(`identity/${purpose}`).digest();
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signJwt(purpose: Purpose, payload: Record<string, unknown>): string {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: purpose }));
  const body = b64(JSON.stringify(payload));
  const sig = createHmac('sha256', keyFor(purpose)).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** Verify signature, issuer and expiry; answers the payload. */
export function verifyJwt(
  purpose: Purpose,
  token: string,
  nowS = Math.floor(Date.now() / 1000),
): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new IdentityError('auth/argument-error', 'Malformed token');
  const [head, body, sig] = parts as [string, string, string];
  const want = createHmac('sha256', keyFor(purpose)).update(`${head}.${body}`).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want))
    throw new IdentityError('auth/argument-error', 'Invalid token signature');
  let payload: Record<string, unknown>;
  try {
    const h = JSON.parse(Buffer.from(head, 'base64url').toString()) as {
      alg?: string;
      kid?: string;
    };
    if (h.alg !== 'HS256' || h.kid !== purpose) throw new Error('alg');
    payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>;
  } catch {
    throw new IdentityError('auth/argument-error', 'Malformed token');
  }
  if (payload.iss !== ISSUER) throw new IdentityError('auth/argument-error', 'Wrong token issuer');
  if (typeof payload.exp !== 'number' || payload.exp <= nowS)
    throw new IdentityError(
      purpose === 'id' ? 'auth/id-token-expired' : 'auth/argument-error',
      'Token has expired',
    );
  return payload;
}

/** A random opaque secret (refresh tokens, e-mail link tokens). */
export const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');

// ─── passwords ───────────────────────────────────────────────────────────────

const N = 16384;
const R = 8;
const P = 1;
const LEN = 32;

function scryptAsync(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, LEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (e, k) =>
      e ? reject(e) : resolve(k),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function checkPassword(
  password: string,
  stored: string | undefined | null,
): Promise<boolean> {
  if (!stored) return false;
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const key = await scryptAsync(
    password,
    Buffer.from(salt, 'base64url'),
    Number(n),
    Number(r),
    Number(p),
  );
  const want = Buffer.from(hash, 'base64url');
  return key.length === want.length && timingSafeEqual(key, want);
}
