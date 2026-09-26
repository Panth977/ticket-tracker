/**
 * sessionRevokeAll (extra; Account › Security › 'Sign out everywhere').
 * Revokes every refresh token of the caller's account. The user middleware
 * verifies ID tokens with checkRevoked, so every session — this browser's
 * too — is refused from its next request and signs in again.
 * (Added by integration: the screen called an /api command nobody served.)
 */
import { auth } from '../runtime/firebase.js';
import { defineCommand } from './_registry.js';

export default defineCommand('sessionRevokeAll', async (ctx) => {
  await auth().revokeRefreshTokens(ctx.actor);
  return { ok: true as const };
});
