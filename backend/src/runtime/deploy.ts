/**
 * Deploy-time configuration: the region every function runs in, the optional
 * Secret Manager bindings, and the server's own signing secrets.
 *
 *   TM_REGION    region of every function, task queue and schedule. Unset →
 *                us-central1 (what the emulators, vite proxy and test harness
 *                address). Production sets it in backend/.env.<projectId>,
 *                which the Firebase CLI loads both when it analyses the code
 *                at deploy and in the running functions.
 *   TM_SECRETS   comma-separated Secret Manager secrets to expose as env vars
 *                (e.g. "RESEND_API_KEY,WHATSAPP_TOKEN"). OPTIONAL on purpose:
 *                a required defineSecret() fails the deploy when the secret
 *                does not exist, and every third-party integration here is
 *                off-by-default. Create the secret first
 *                (`firebase functions:secrets:set NAME`), then list it here.
 *
 * SERVER SECRETS. TM_SIGNING_KEY (platform/crypto.ts) and NOTIFY_SIGNING_SECRET
 * (notify/config.ts) sign webhook secrets, OAuth state, ICS tokens, reply and
 * unsubscribe tokens. They are ours, not a provider's, so production must not
 * depend on someone having set them: when absent (and not under the
 * emulators), ensureServerSecrets() loads them from _config/serverSecrets —
 * creating random ones once, in a transaction, so every instance agrees.
 * Rules deny every '_' collection, so only the Admin SDK can read them.
 * index.ts awaits it before any handler runs; the synchronous getters then
 * find them in process.env.
 */
import { randomBytes } from 'node:crypto';
import { db, isEmulated } from './firebase.js';

export const DEFAULT_REGION = 'us-central1';

/** The region functions are deployed to (and task queues are addressed in). */
export function region(): string {
  return process.env.TM_REGION?.trim() || DEFAULT_REGION;
}

/** Secret Manager secrets to bind (TM_SECRETS), [] when none. */
export function boundSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.TM_SECRETS ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^[A-Z][A-Z0-9_]*$/.test(s));
}

export const SERVER_SECRETS_DOC = '_config/serverSecrets';
const SERVER_SECRET_NAMES = ['TM_SIGNING_KEY', 'NOTIFY_SIGNING_SECRET'] as const;

let ensured: Promise<void> | undefined;

/** Make sure the server's signing secrets are in process.env (no-op when set or emulated). */
export function ensureServerSecrets(): Promise<void> {
  if (isEmulated() || SERVER_SECRET_NAMES.every((n) => process.env[n])) return Promise.resolve();
  return (ensured ??= load().catch((e) => {
    ensured = undefined; // retry on the next invocation
    throw e;
  }));
}

async function load(): Promise<void> {
  const ref = db().doc(SERVER_SECRETS_DOC);
  const values = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const have = (snap.data() ?? {}) as Record<string, string>;
    const missing = SERVER_SECRET_NAMES.filter((n) => !have[n]);
    if (missing.length === 0) return have;
    const next = { ...have };
    for (const n of missing) next[n] = randomBytes(32).toString('base64url');
    tx.set(ref, { ...next, updatedAt: Date.now() }, { merge: true });
    return next;
  });
  for (const n of SERVER_SECRET_NAMES) process.env[n] ||= values[n];
}

/** Wrap a handler so the server secrets are loaded before it runs. */
export function withServerSecrets<A extends unknown[], R>(
  fn: (...args: A) => R | Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    await ensureServerSecrets();
    return fn(...args);
  };
}
