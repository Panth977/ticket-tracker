/**
 * WHOSE APP THIS IS (docs/plan/agents.html §X) — the allow list.
 *
 * TaskManager is one person's private tracker. Signing in is open (anyone can
 * press "Continue with Google"), but only accounts on the ALLOW LIST can DO
 * anything: no boards, no tickets, no API, no MCP. Everyone else lands on one
 * "ask for access" screen.
 *
 *   _config/allow            the list itself, SERVER-OWNED (like the signing
 *                            secrets in _config/serverSecrets): no client, and
 *                            no rule, can read or write it.
 *   users/{uid}.allowed      a MIRROR of the same answer for one person, so
 *                            firestore.rules / storage.rules can check it in
 *                            ONE hop, and so the app's middleware costs one
 *                            document read instead of a list scan.
 *
 * THE ADMIN IS THE OWNER, NOT A ROLE. One address, set in configuration
 * (TM_ADMIN_EMAIL on the backend, PUBLIC_TM_ADMIN_EMAIL in the SPA; the default
 * below is a placeholder nobody owns), never editable from inside the
 * app, allowed by definition and impossible to remove. Everything below is
 * pure so the backend (which knows the env) and the frontend (which only
 * knows the default) share one set of rules.
 *
 * This module is imported as '@tm/shared/config' — deliberately NOT from the
 * package root, so a screen that only wants the admin address does not pull in
 * the whole registry.
 */
import { z } from 'zod';
import { MillisSchema } from './types/index.js';

/**
 * The admin address, when nothing overrides it. The backend passes
 * `TM_ADMIN_EMAIL` to `adminEmail()`; the frontend reads PUBLIC_TM_ADMIN_EMAIL
 * (it only decides what to SHOW — every refusal is the server's). Until one of
 * them is set, nobody is the admin.
 */
export const DEFAULT_ADMIN_EMAIL = 'owner@example.com';

/** Addresses are compared lower-cased and trimmed, everywhere. */
export const normalizeEmail = (email: string | null | undefined): string =>
  (email ?? '').trim().toLowerCase();

/** The configured admin address (server: `adminEmail(process.env)`). */
export const adminEmail = (env?: { TM_ADMIN_EMAIL?: string | undefined }): string =>
  normalizeEmail(env?.TM_ADMIN_EMAIL) || DEFAULT_ADMIN_EMAIL;

/** Is this the admin? (The one comparison that decides who sees the Users module.) */
export const isAdminEmail = (
  email: string | null | undefined,
  admin = DEFAULT_ADMIN_EMAIL,
): boolean => {
  const e = normalizeEmail(email);
  return e !== '' && e === normalizeEmail(admin);
};

/** The document the list lives in. Server-owned; never in paths used by a client. */
export const ALLOW_DOC = '_config/allow';

/**
 * One row of the list. The address is the identity: the admin adds people
 * BEFORE they have ever signed in, so there is no uid to key on yet (the uid,
 * the name and the last sign-in are read live from Auth by `userList`).
 */
export const AllowEntrySchema = z.object({
  /** Lower-cased. */
  email: z.string().min(3).max(320),
  addedAt: MillisSchema,
  /** The admin's uid, or 'config' for the admin's own row (allowed by definition). */
  addedBy: z.string().min(1),
  /** Free-form reminder of who this is ('Priya, design'). */
  note: z.string().max(200).optional(),
});
export type AllowEntry = z.infer<typeof AllowEntrySchema>;

/** _config/allow — the whole list in one small document. */
export const AllowListSchema = z.object({
  emails: z.array(AllowEntrySchema),
  updatedAt: MillisSchema,
});
export type AllowList = z.infer<typeof AllowListSchema>;

export const EMPTY_ALLOW_LIST: AllowList = { emails: [], updatedAt: 0 };

/** The admin's row, which exists whether or not it was ever written down. */
export const adminEntry = (admin: string): AllowEntry => ({
  email: normalizeEmail(admin),
  addedAt: 0,
  addedBy: 'config',
});

/**
 * The list as the Users module shows it: the admin first (always there), then
 * everyone else, newest addition last. Never two rows for one address.
 */
export function allowEntries(list: AllowList | null, admin = DEFAULT_ADMIN_EMAIL): AllowEntry[] {
  const adminAddr = normalizeEmail(admin);
  const rest = (list?.emails ?? [])
    .map((e) => ({ ...e, email: normalizeEmail(e.email) }))
    .filter((e) => e.email !== '' && e.email !== adminAddr);
  const seen = new Set<string>();
  const unique = rest.filter((e) => (seen.has(e.email) ? false : (seen.add(e.email), true)));
  unique.sort((a, b) => a.addedAt - b.addedAt || a.email.localeCompare(b.email));
  const stored = (list?.emails ?? []).find((e) => normalizeEmail(e.email) === adminAddr);
  return [{ ...adminEntry(adminAddr), ...(stored ? { addedAt: stored.addedAt } : {}) }, ...unique];
}

/**
 * MAY THIS ADDRESS DO ANYTHING? The one answer every door asks.
 *
 * `openWhenUnset` is for the EMULATORS only: with no `_config/allow` document
 * at all, a local emulator suite (and `pnpm seed`) behaves as it always did,
 * while a real deployment with no list lets in nobody but the admin. The
 * backend passes `isEmulated()`; production can never pass true.
 */
export function isAllowedEmail(
  email: string | null | undefined,
  list: AllowList | null,
  opts: { admin?: string; openWhenUnset?: boolean } = {},
): boolean {
  const e = normalizeEmail(email);
  if (e === '') return false;
  const admin = normalizeEmail(opts.admin ?? DEFAULT_ADMIN_EMAIL);
  if (e === admin) return true; // allowed by definition
  if (!list) return opts.openWhenUnset === true;
  return list.emails.some((x) => normalizeEmail(x.email) === e);
}

/** Add an address (idempotent). Returns the new list; the admin is never stored twice. */
export function withAllowed(
  list: AllowList | null,
  entry: { email: string; addedAt: number; addedBy: string; note?: string },
): AllowList {
  const email = normalizeEmail(entry.email);
  const emails = (list?.emails ?? []).filter((x) => normalizeEmail(x.email) !== email);
  return {
    emails: [...emails, { ...entry, email }],
    updatedAt: entry.addedAt,
  };
}

/** Remove an address. The caller refuses the admin's own before calling this. */
export function withoutAllowed(list: AllowList | null, email: string, now: number): AllowList {
  const addr = normalizeEmail(email);
  return {
    emails: (list?.emails ?? []).filter((x) => normalizeEmail(x.email) !== addr),
    updatedAt: now,
  };
}

/** Enough of an address to be worth a round trip (the real check is the provider's). */
export const EmailInputSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .regex(/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/, 'That does not look like an email address')
  .transform((s) => s.toLowerCase());

/**
 * The refusal, in words, for a signed-in account that is not on the list. It
 * is a SPECIFIC error — `forbidden` with `reason: 'notAllowed'` — so the app
 * can send the person to the "ask for access" screen instead of showing a
 * generic "you can't do that".
 */
export const NOT_ALLOWED_REASON = 'notAllowed';
export const notAllowedMessage = (admin = DEFAULT_ADMIN_EMAIL): string =>
  `This TaskManager is private. Ask ${normalizeEmail(admin)} for access.`;
/** The details object carried by every not-allowed refusal. */
export const notAllowedDetails = (
  admin = DEFAULT_ADMIN_EMAIL,
): { reason: string; admin: string } => ({
  reason: NOT_ALLOWED_REASON,
  admin: normalizeEmail(admin),
});
