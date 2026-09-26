/**
 * onUserCreated (Auth onCreate) — a new account, by any provider. SIGNING UP
 * IS STILL OPEN (anyone can press "Continue with Google"); what a new account
 * may DO is not (§X). So this is where the allow list is read for the first
 * time and mirrored onto the profile:
 *
 *   users/{uid}.allowed = is this address on _config/allow (or the admin's)?
 *
 * That is how "add someone before they have ever signed in" works: the admin
 * writes the address now, and the flag the security rules read appears the
 * moment that person arrives. An account that is not allowed still gets a
 * profile document — it needs one to be shown its own address on the "ask for
 * access" screen — and nothing else.
 *
 *   users/{uid} = name + e-mail from the provider, notify defaults
 *     (timezone starts as UTC; the client's first profileUpdate sets it)
 *   the provider's photo (Google) is COPIED into users/{uid}/avatar/ as a
 *     256px webp, so the picture never depends on a third-party URL
 *   pending invites for this (verified) address → an 'invited' inbox row each
 *
 * Idempotent (Auth events can be delivered twice): the users/ doc is only
 * created, never overwritten — profileUpdate may have created it first.
 */
import type { UserRecord } from 'firebase-admin/auth';
import { isAgentId, MAX_AVATAR_BYTES, storage } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { attachInvitesToInbox } from '../commands/inviteShared.js';
import { newUserDoc, userRef } from '../commands/profileShared.js';
import { allowVerdict } from '../platform/allow.js';
import { defineTrigger } from '../runtime/functions.js';

type Fetch = typeof fetch;

/**
 * Download a provider photo and store it as our own 256px webp avatar.
 * Returns the Storage path, or null when anything about it is off (never
 * fails the sign-up over a picture).
 */
export async function copyProviderPhoto(
  uid: string,
  url: string,
  now: number,
  fetchImpl: Fetch = fetch,
): Promise<string | null> {
  try {
    if (!/^https?:\/\//i.test(url)) return null;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
    if (!res.ok) return null;
    if (!(res.headers.get('content-type') ?? '').startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_AVATAR_BYTES) return null;
    const { default: sharp } = await import('sharp');
    const webp = await sharp(buf)
      .rotate()
      .resize(256, 256, { fit: 'cover' })
      .webp({ quality: 85 })
      .toBuffer();
    const path = storage.avatar(uid, now);
    await ports().files.write(path, new Uint8Array(webp), 'image/webp');
    return path;
  } catch (e) {
    console.warn(`[onUserCreated] provider photo for ${uid} not copied`, e);
    return null;
  }
}

export async function handleUserCreated(user: UserRecord, fetchImpl: Fetch = fetch): Promise<void> {
  // Phase 17 (§W): GET /v1/live signs an AGENT in with a custom token so it
  // can stream the RTDB, which creates an Auth user for 'ag_…'. Agents never
  // get a users/ profile or an allow-list verdict — they are not people.
  if (isAgentId(user.uid)) return;
  const now = ports().clock.now();
  const ref = userRef(user.uid);
  const email = (user.email ?? '').toLowerCase();
  // §X — the allow-list mirror, decided here and written with the profile.
  const allowed = (await allowVerdict(user.uid, email, user.emailVerified)) === 'allow';
  try {
    await ref.create({ ...newUserDoc({ name: user.displayName, email }, now), allowed });
  } catch (e) {
    if ((e as { code?: number }).code !== 6) throw e; // ALREADY_EXISTS: someone was first
    // A profileUpdate got in ahead of us: the flag is still ours to state.
    await ref.set({ allowed }, { merge: true });
  }
  if (user.photoURL) {
    const path = await copyProviderPhoto(user.uid, user.photoURL, now, fetchImpl);
    if (path) {
      // Only when they have not picked a picture of their own meanwhile.
      const cur = (await ref.get()).data();
      if (cur && cur.avatarPath === null) await ref.update({ avatarPath: path });
      else
        await ports()
          .files.delete(path)
          .catch(() => {});
    }
  }
  if (email && user.emailVerified) await attachInvitesToInbox(user.uid, email, now);
}

defineTrigger('onUserCreated', (user) => handleUserCreated(user));
