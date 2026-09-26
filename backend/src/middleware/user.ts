/**
 * `user` middleware — a Firebase ID token from the Svelte app
 * (app/backend.json middleware.user):
 *
 *   token = bearer(req)                  → 401 if absent
 *   verifyIdToken(token, checkRevoked)   → { uid, email }
 *   ctx = { actor: uid, via: 'app', email, now, ids }
 *
 * AUTHORIZATION IS NOT HERE. Who you are is a token fact; what you may do is
 * a BOARD fact, answered per command by can() after the board is loaded.
 *
 * WITH ONE EXCEPTION (§X): may you do ANYTHING? This app is private, so every
 * principal that enters through the app door is checked against the allow list
 * right here — one place, so no route can forget it (/api/{command}, the file
 * URL route, the OAuth consent screens, the usage panel). The refusal is
 * specific — `forbidden` with `reason: 'notAllowed'` and the admin's address —
 * so the app can send the person to "ask for access" instead of showing them a
 * permission error they cannot act on.
 *
 * Under the Auth emulator the Admin SDK accepts the emulator's unsigned
 * tokens (FIREBASE_AUTH_EMULATOR_HOST) — nothing to branch on here.
 */
import type { MiddlewareHandler } from 'hono';
import { errors } from '@tm/shared';
import type { AppEnv } from '../http/env.js';
import { assertAllowed } from '../platform/allow.js';
import { makeCtx } from '../runtime/context.js';
import { auth } from '../runtime/firebase.js';

/** The token from `Authorization: Bearer <token>`, or null. */
export function bearer(header: string | undefined | null): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return m ? m[1]! : null;
}

export const userAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c.req.header('authorization'));
  if (!token) throw errors.unauthenticated('Missing bearer token');
  let decoded;
  try {
    decoded = await auth().verifyIdToken(token, true);
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    // Revoked / disabled / expired are all "sign in again"; never echo token details.
    throw errors.unauthenticated(
      code === 'auth/id-token-revoked' || code === 'auth/user-disabled'
        ? 'Session revoked — sign in again'
        : 'Invalid or expired ID token',
    );
  }
  // §X — the allow list. Before any command, any board, any document.
  await assertAllowed(decoded.uid, decoded.email ?? null, decoded.email_verified ?? false);
  c.set(
    'ctx',
    makeCtx({
      actor: decoded.uid,
      via: 'app',
      email: decoded.email ?? null,
      emailVerified: decoded.email_verified ?? false,
      requestId: c.get('requestId'),
    }),
  );
  await next();
};
