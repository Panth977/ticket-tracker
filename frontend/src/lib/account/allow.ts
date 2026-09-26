/**
 * THE ALLOW LIST, IN THE APP (docs/plan/agents.html §X).
 *
 * This tracker is private. Two questions the screens ask:
 *
 *   amIAllowed(profile)  may I do anything at all? The answer is the MIRROR on
 *                        my own profile, users/{uid}.allowed — the same flag
 *                        the security rules read, so the app and the database
 *                        can never disagree about it.
 *   amIAdmin(email)      do I see the Users module? One configured address.
 *
 * NOTHING HERE IS A PERMISSION. Every refusal that matters is the server's:
 * the app door checks the list on every request and answers `forbidden` with
 * `reason: 'notAllowed'`. These helpers only decide what to DRAW — a screen
 * that hides a button it has no right to would still be refused if it pressed
 * it, and a screen that shows one by mistake cannot do any harm.
 */
import type { AllowedUser, User } from '@tm/shared';
import {
  DEFAULT_ADMIN_EMAIL,
  NOT_ALLOWED_REASON,
  isAdminEmail,
  normalizeEmail,
} from '@tm/shared/config';
import { env } from '$env/dynamic/public';
import { command, isAppError } from '$lib/api';

/**
 * The admin's address as the app knows it: PUBLIC_TM_ADMIN_EMAIL at build time
 * (the same address the backend gets as TM_ADMIN_EMAIL), else the placeholder.
 */
export const ADMIN_EMAIL = normalizeEmail(env.PUBLIC_TM_ADMIN_EMAIL) || DEFAULT_ADMIN_EMAIL;

/** Is this the admin? (Who sees the Users module.) */
export const amIAdmin = (email: string | null | undefined): boolean =>
  isAdminEmail(email, ADMIN_EMAIL);

/**
 * Has this account been refused? Only an explicit `false` refuses — an absent
 * flag means "nothing decided here" (see shared/src/schema/user.ts), and a
 * profile that has not arrived yet decides nothing either.
 */
export const isRefused = (profile: Pick<User, 'allowed'> | null | undefined): boolean =>
  profile?.allowed === false;

/** Is the refusal on this error the allow list's (rather than a board permission)? */
export function isNotAllowedError(e: unknown): boolean {
  if (!isAppError(e)) return false;
  return (
    e.code === 'forbidden' &&
    (e.details as { reason?: string } | undefined)?.reason === NOT_ALLOWED_REASON
  );
}

export type { AllowedUser };

/** Who may use this app (admin only). */
export const fetchUsers = (): Promise<{ users: AllowedUser[]; admin: string }> =>
  command('userList', {}, { toast: 'Could not load who may use this app' });

/** Let an address in — before that person has ever signed in. */
export const allowUser = (email: string, note?: string) =>
  command(
    'userAllow',
    { email: normalizeEmail(email), ...(note ? { note } : {}) },
    { toast: 'Could not add them' },
  );

/** Take access away; it stops working on their next request. */
export const disallowUser = (email: string) =>
  command(
    'userDisallow',
    { email: normalizeEmail(email) },
    { toast: 'Could not take access away' },
  );

/** 'Signed in 3 hours ago' / 'Never signed in' — the one fact worth a glance. */
export function signInLabel(
  u: Pick<AllowedUser, 'uid' | 'lastSignInAt'>,
  relative: (ms: number) => string,
): string {
  if (!u.uid) return 'Never signed in';
  return u.lastSignInAt ? `Last signed in ${relative(u.lastSignInAt)}` : 'Signed up, never used it';
}
