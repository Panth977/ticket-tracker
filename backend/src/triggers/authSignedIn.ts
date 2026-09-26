/**
 * onUserSignedIn (blocking beforeUserSignedIn) — runs on every sign-in,
 * before the token is issued.
 *
 * HOW AN E-MAIL CHANGE REACHES THE DATA. Firebase has no 'email changed'
 * trigger; the next sign-in after a verified change is the first moment we
 * can see it (and the token it mints carries the new address anyway). So:
 * a verified e-mail that differs from users/{uid}.email → users/{uid}.email
 * and every boards/{b}/members/{uid}.email are updated.
 *
 * Also: invites waiting for this verified address get their inbox rows (a
 * password sign-up verifies AFTER onUserCreated ran). Idempotent.
 *
 * Never blocks a sign-in: failures are logged, the sign-in proceeds.
 */
import type { AuthBlockingEvent } from 'firebase-functions/v2/identity';
import { isAgentId } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { attachInvitesToInbox } from '../commands/inviteShared.js';
import { fanOutToMembers, userRef } from '../commands/profileShared.js';
import { defineTrigger } from '../runtime/functions.js';

export async function syncSignIn(u: {
  uid: string;
  email?: string | null;
  emailVerified?: boolean;
}): Promise<void> {
  const email = (u.email ?? '').toLowerCase();
  // Phase 17: an agent signing in for its live credential (GET /v1/live) is not a person.
  if (isAgentId(u.uid) || !email || !u.emailVerified) return;
  const now = ports().clock.now();
  const ref = userRef(u.uid);
  const snap = await ref.get();
  if (snap.exists) {
    const cur = snap.data()!;
    if (cur.deletedAt === null && cur.email !== email) {
      await ref.update({ email });
      await fanOutToMembers(u.uid, { email });
    }
  }
  await attachInvitesToInbox(u.uid, email, now);
}

defineTrigger('beforeUserSignedIn', async (event: AuthBlockingEvent) => {
  try {
    await syncSignIn(event.data ?? { uid: '' });
  } catch (e) {
    console.error('[beforeUserSignedIn] sync failed (sign-in continues)', e);
  }
});
