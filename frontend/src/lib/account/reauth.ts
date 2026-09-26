/**
 * Recent login, for account deletion and password changes. Firebase wants a
 * sign-in within the last few minutes; we re-authenticate with whichever
 * provider the account uses, then force a fresh ID token so the server sees
 * the new auth_time.
 */
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  type User as FbUser,
} from 'firebase/auth';
import { getAuthClient } from '$lib/firebase/client';
import { auth } from '$lib/firebase/auth.svelte';

/** Firebase's own threshold for sensitive operations is 5 minutes. */
export const RECENT_MS = 5 * 60 * 1000;

export type ReauthMethod = 'google' | 'microsoft' | 'password' | 'emailLink';

export function currentUser(): FbUser | null {
  return getAuthClient().currentUser;
}

export function providerIds(u: FbUser | null = currentUser()): string[] {
  return u?.providerData.map((p) => p.providerId) ?? [];
}

/** The best way to re-authenticate this account, in order of least friction. */
export function reauthMethod(providers: string[]): ReauthMethod {
  if (providers.includes('google.com')) return 'google';
  if (providers.includes('microsoft.com')) return 'microsoft';
  if (providers.includes('password')) return 'password';
  return 'emailLink';
}

export function signedInRecently(
  lastSignInTime: string | undefined | null,
  now = Date.now(),
): boolean {
  if (!lastSignInTime) return false;
  const t = Date.parse(lastSignInTime);
  return Number.isFinite(t) && now - t < RECENT_MS;
}

/**
 * Re-authenticate. For 'password' pass the password. 'emailLink' cannot be
 * done in place: returns false and the caller sends the person through a new
 * link (sign out → /login?next=…).
 */
export async function reauthenticate(password?: string): Promise<boolean> {
  const u = currentUser();
  if (!u) return false;
  const m = reauthMethod(providerIds(u));
  if (m === 'google') await reauthenticateWithPopup(u, new GoogleAuthProvider());
  else if (m === 'microsoft') await reauthenticateWithPopup(u, new OAuthProvider('microsoft.com'));
  else if (m === 'password') {
    if (!u.email || !password) return false;
    await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, password));
  } else {
    if (!signedInRecently(u.metadata.lastSignInTime)) return false;
  }
  await auth.idToken(true);
  return true;
}
