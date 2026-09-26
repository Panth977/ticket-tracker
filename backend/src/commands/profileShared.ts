/**
 * users/{uid} helpers shared by profileUpdate, accountDelete and the auth
 * triggers (onUserCreated / beforeUserSignedIn).
 */
import { DEFAULT_DUE_SOON_LEAD_MINUTES, defaultChannelMatrix, paths, type User } from '@tm/shared';
import { typedDoc } from '../runtime/converters.js';
import { auth, db } from '../runtime/firebase.js';
import { inBatches } from './boardShared.js';

export const userRef = (uid: string) => typedDoc('users', paths.user(uid));

/** A new account's users/ doc: notify defaults, no WhatsApp, UTC until the client says otherwise. */
export function newUserDoc(
  p: { name?: string | null; email?: string | null; avatarPath?: string | null },
  now: number,
): User {
  const email = (p.email ?? '').toLowerCase();
  const name = (p.name?.trim() || email.split('@')[0] || 'New user').slice(0, 60);
  return {
    name,
    email,
    avatarPath: p.avatarPath ?? null,
    timezone: 'UTC',
    locale: 'en',
    theme: 'system',
    whatsapp: null,
    notify: {
      channels: defaultChannelMatrix(),
      quietHours: null,
      digest: 'off',
      dueSoonLeadMinutes: DEFAULT_DUE_SOON_LEAD_MINUTES,
      commitmentReminders: true,
    },
    createdAt: now,
    deletedAt: null,
  };
}

/**
 * The users/ doc, created from the Auth record when the trigger has not run
 * yet (the welcome screen's first profileUpdate can race onUserCreated).
 */
export async function ensureUserDoc(uid: string, now: number): Promise<User> {
  const ref = userRef(uid);
  const snap = await ref.get();
  if (snap.exists) return snap.data()!;
  const rec = await auth().getUser(uid);
  const doc = newUserDoc({ name: rec.displayName, email: rec.email }, now);
  try {
    await ref.create(doc);
    return doc;
  } catch {
    return (await ref.get()).data()!; // created concurrently
  }
}

/**
 * Copy profile fields onto every boards/{b}/members/{uid} row
 * (collectionGroup('members') where uid == uid). Mentions and assignees hold
 * the uid, so nothing else needs rewriting.
 */
export async function fanOutToMembers(
  uid: string,
  patch: Partial<{ name: string; email: string; avatarPath: string | null }>,
): Promise<number> {
  if (Object.keys(patch).length === 0) return 0;
  const snap = await db().collectionGroup('members').where('uid', '==', uid).get();
  await inBatches(snap.docs, (b, d) => b.update(d.ref, patch));
  return snap.size;
}

/** Is this an IANA zone the runtime knows? */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
