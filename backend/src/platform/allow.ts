/**
 * THE ALLOW LIST, SERVER SIDE (docs/plan/agents.html §X).
 *
 * TaskManager is private. Signing in is open; DOING anything is not. One
 * address — the admin's, from configuration — is allowed by definition and
 * manages everyone else.
 *
 *   _config/allow          the list. Server-owned: no rule lets a client near
 *                          it, and nothing caches it, so removing an address
 *                          takes effect on that person's NEXT request.
 *   users/{uid}.allowed    the mirror the security rules read in one hop
 *                          (firestore.rules, storage.rules). Kept in step by
 *                          onUserCreated, userAllow and userDisallow.
 *
 * WHAT A REQUEST COSTS. The admin's own requests cost NOTHING extra: their
 * address is in the ID token and matching it is a string compare. Everyone
 * else costs ONE document read (the list) — the price of "taking access away
 * bites on the next request", which a cache would trade away.
 *
 * IN THE EMULATORS the suites make dozens of throwaway accounts and never
 * write a list, so an address the list does not name is still welcome there —
 * unless a document explicitly says `allowed: false`, which is how the
 * allow-list tests and the e2e refuse an account. `TM_ALLOW_STRICT=1` turns
 * that convenience off and gives a test the production behaviour;
 * `TM_ALLOW_DOC` moves the list to another document so a test can own one.
 * Neither can loosen anything in production: `openByDefault()` is false there
 * whatever the environment says.
 */
import type { UserRecord } from 'firebase-admin/auth';
import { errors, paths, type AllowedUser, type User } from '@tm/shared';
import {
  ALLOW_DOC,
  AllowListSchema,
  adminEmail,
  allowEntries,
  isAdminEmail,
  isAllowedEmail,
  normalizeEmail,
  notAllowedDetails,
  notAllowedMessage,
  withAllowed,
  withoutAllowed,
  type AllowEntry,
  type AllowList,
} from '@tm/shared/config';
import { auth, db, isEmulated } from '../runtime/firebase.js';

/** The configured admin address. Never editable from inside the app. */
export const theAdmin = (): string => adminEmail(process.env);

/** Where the list lives (a test may own its own copy — see the header). */
export const allowDocPath = (): string => process.env.TM_ALLOW_DOC?.trim() || ALLOW_DOC;

/**
 * Is an address the list does not name still welcome? Only under the
 * emulators, and only while TM_ALLOW_STRICT is not set. NEVER in production.
 */
export const openByDefault = (): boolean => isEmulated() && process.env.TM_ALLOW_STRICT !== '1';

/** The list, or null when it has never been written. Nothing is cached. */
export async function readAllowList(): Promise<AllowList | null> {
  const snap = await db().doc(allowDocPath()).get();
  if (!snap.exists) return null;
  const parsed = AllowListSchema.safeParse(snap.data());
  if (!parsed.success) {
    // A malformed list must not open the app up: treat it as empty (admin only).
    console.error('[allow] _config/allow is malformed — falling back to the admin alone');
    return { emails: [], updatedAt: 0 };
  }
  return parsed.data;
}

async function writeAllowList(list: AllowList): Promise<void> {
  await db().doc(allowDocPath()).set(list);
}

/** The list as the Users module shows it (the admin first, always present). */
export const listEntries = (list: AllowList | null): AllowEntry[] => allowEntries(list, theAdmin());

/**
 * THE USERS MODULE'S ANSWER: the list, joined with what Auth already knows.
 *
 * Who has signed in, under what name and WHEN THEY LAST SIGNED IN all come
 * from the Auth records themselves — there is no document to keep in step and
 * no sign-in write on the hot path. `mirrored` is the users/{uid}.allowed flag
 * the rules read, so the admin can see the two agree.
 */
export async function usersView(
  list: AllowList | null,
): Promise<{ users: AllowedUser[]; admin: string }> {
  const admin = theAdmin();
  const entries = listEntries(list);
  const records = await authRecords(entries.map((e) => e.email));
  const uids = entries
    .map((e) => records.get(e.email)?.uid)
    .filter((u): u is string => typeof u === 'string');
  const mirror = new Map<string, boolean | null>();
  if (uids.length) {
    const snaps = await db().getAll(...uids.map((u) => db().doc(paths.user(u))));
    for (const s of snaps) mirror.set(s.id, (s.data() as User | undefined)?.allowed ?? null);
  }
  const millis = (iso?: string): number | null => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const users = entries.map((e) => {
    const rec = records.get(e.email);
    return {
      email: e.email,
      addedAt: e.addedAt,
      addedBy: e.addedBy,
      ...(e.note ? { note: e.note } : {}),
      admin: e.email === admin,
      uid: rec?.uid ?? null,
      name: rec?.displayName ?? null,
      lastSignInAt: millis(rec?.metadata.lastSignInTime),
      createdAt: millis(rec?.metadata.creationTime),
      mirrored: rec ? (mirror.get(rec.uid) ?? null) : null,
    } satisfies AllowedUser;
  });
  return { users, admin };
}

/** Auth records for a handful of addresses, in one call (never throws). */
async function authRecords(emails: string[]): Promise<Map<string, UserRecord>> {
  const out = new Map<string, UserRecord>();
  if (!emails.length) return out;
  try {
    const { users } = await auth().getUsers(emails.slice(0, 100).map((email) => ({ email })));
    for (const u of users) if (u.email) out.set(normalizeEmail(u.email), u);
  } catch (e) {
    console.warn('[allow] could not read Auth records for the Users list', e);
  }
  return out;
}

/** THE QUESTION, for a principal that has already been identified. */
export async function allowVerdict(
  uid: string | null,
  email: string | null | undefined,
  emailVerified = true,
): Promise<'allow' | 'deny'> {
  const admin = theAdmin();
  // An UNVERIFIED address is no address at all here: the list is written in
  // addresses, so honouring one would let anyone sign up as the admin with a
  // password provider and let themselves in.
  const addr = emailVerified ? email : null;
  if (isAdminEmail(addr, admin)) return 'allow'; // allowed by definition, no reads
  const list = await readAllowList();
  if (isAllowedEmail(addr, list, { admin })) return 'allow';
  if (!openByDefault()) return 'deny';
  // Emulators only (see the header): welcome unless something said otherwise.
  if (!uid) return 'allow';
  const snap = await db().doc(paths.user(uid)).get();
  return (snap.data() as User | undefined)?.allowed === false ? 'deny' : 'allow';
}

/** The refusal every door gives: specific, and it names who to ask. */
export const notAllowed = (): Error =>
  errors.forbidden(notAllowedMessage(theAdmin()), notAllowedDetails(theAdmin()));

/** Throw unless this principal may do anything at all. */
export async function assertAllowed(
  uid: string | null,
  email: string | null | undefined,
  emailVerified = true,
): Promise<void> {
  if ((await allowVerdict(uid, email, emailVerified)) === 'deny') throw notAllowed();
}

/**
 * WHICH UID IS THE ADMIN. An address belongs to one account, and that never
 * changes while the app runs — so an instance remembers it rather than paying
 * a lookup per call. Remembered for ten minutes only: long enough to make the
 * owner's own orchestrators free (§W), short enough that reassigning the admin
 * address is not an hour-long window.
 *
 * NOTHING IS TRUSTED TO THIS but "which uid signs in as the admin". Who is
 * ALLOWED is still read from the list on every request.
 */
const ADMIN_UID_TTL_MS = 10 * 60_000;
let adminUidMemo: { address: string; uid: string | null; at: number } | null = null;

export function forgetAdminUid(): void {
  adminUidMemo = null;
}

async function adminUid(now = Date.now()): Promise<string | null> {
  const address = theAdmin();
  if (adminUidMemo && adminUidMemo.address === address && now - adminUidMemo.at < ADMIN_UID_TTL_MS)
    return adminUidMemo.uid;
  const uid = await uidForEmail(address);
  adminUidMemo = { address, uid, at: now };
  return uid;
}

/**
 * THE TOKEN PATH (§X): a token is only as good as the person behind it, so an
 * API key or an OAuth grant works only while its OWNER is still allowed.
 * Removing someone therefore stops their orchestrators too, on their next
 * call, without hunting down their tokens.
 *
 * WHAT IT COSTS. Nothing at all for the admin's own tokens — which is every
 * token this app has most days, and the one path an orchestrator walks twice a
 * minute (§W): their uid is remembered, and a uid comparison is free. For
 * anyone else: their profile (for the address a token cannot carry) and the
 * list. Never a cached ANSWER — only a cached identity.
 */
export async function assertAllowedOwner(ownerUid: string): Promise<void> {
  if (ownerUid === (await adminUid())) return;
  const snap = await db().doc(paths.user(ownerUid)).get();
  const u = snap.data() as User | undefined;
  let email = normalizeEmail(u?.email);
  if (!email) {
    // No profile document yet (or an account deleted its address): ask Auth.
    email = normalizeEmail(await emailForUid(ownerUid));
  }
  const admin = theAdmin();
  if (isAdminEmail(email, admin)) return;
  const list = await readAllowList();
  if (isAllowedEmail(email, list, { admin })) return;
  if (openByDefault() && u?.allowed !== false) return;
  throw notAllowed();
}

/** The address behind a uid, or null. */
export async function emailForUid(uid: string): Promise<string | null> {
  try {
    return (await auth().getUser(uid)).email ?? null;
  } catch {
    return null;
  }
}

/** Only the admin may change the list — one configured, VERIFIED address. */
export function assertAdmin(email: string | null | undefined, emailVerified = true): void {
  if (!emailVerified || !isAdminEmail(email, theAdmin()))
    throw errors.forbidden(
      `Only ${theAdmin()} can manage who may use this TaskManager.`,
      notAllowedDetails(theAdmin()),
    );
}

/**
 * Mirror the answer onto users/{uid}, for the security rules. Missing account
 * (added by address before they ever signed in) is not an error — the flag is
 * written by onUserCreated when they arrive.
 */
export async function mirrorAllowed(email: string, allowed: boolean): Promise<string | null> {
  const uid = await uidForEmail(email);
  if (!uid) return null;
  await db()
    .doc(paths.user(uid))
    .set({ allowed }, { merge: true })
    .catch((e: unknown) => {
      console.error(`[allow] could not mirror allowed=${allowed} onto users/${uid}`, e);
      throw e;
    });
  return uid;
}

/** The uid behind an address, or null when nobody has ever signed in with it. */
export async function uidForEmail(email: string): Promise<string | null> {
  try {
    return (await auth().getUserByEmail(normalizeEmail(email))).uid;
  } catch {
    return null;
  }
}

/** Add an address. Returns the new list. */
export async function allowEmail(
  email: string,
  by: string,
  now: number,
  note?: string,
): Promise<AllowList> {
  const list = withAllowed(await readAllowList(), {
    email,
    addedAt: now,
    addedBy: by,
    ...(note ? { note } : {}),
  });
  await writeAllowList(list);
  await mirrorAllowed(email, true);
  return list;
}

/**
 * Take access away. The list is the truth, so this bites on their next
 * request; the mirror is updated for the rules and their sessions are revoked
 * so the ID token they hold stops verifying too.
 */
export async function disallowEmail(email: string, now: number): Promise<AllowList> {
  const list = withoutAllowed(await readAllowList(), email, now);
  await writeAllowList(list);
  const uid = await mirrorAllowed(email, false);
  if (uid) {
    // verifyIdToken(token, true) in the user middleware checks revocation, so
    // the next app request is a 401 "sign in again" even before the gate.
    await auth()
      .revokeRefreshTokens(uid)
      .catch((e: unknown) => console.warn(`[allow] could not revoke sessions for ${uid}`, e));
  }
  return list;
}
