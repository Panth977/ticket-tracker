/**
 * The allow list's pure rules (§X). Everything the doors and the screens ask
 * about who may use this app comes through these five functions, so they are
 * worth pinning on their own.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ADMIN_EMAIL,
  EmailInputSchema,
  adminEmail,
  allowEntries,
  isAdminEmail,
  isAllowedEmail,
  normalizeEmail,
  notAllowedDetails,
  withAllowed,
  withoutAllowed,
  type AllowList,
} from './config.js';

const ADMIN = DEFAULT_ADMIN_EMAIL;
const list = (...emails: string[]): AllowList => ({
  emails: emails.map((email, i) => ({ email, addedAt: i + 1, addedBy: 'u_admin' })),
  updatedAt: emails.length,
});

describe('the admin', () => {
  it('is one configured address, compared without case or spaces', () => {
    expect(isAdminEmail(` ${ADMIN.toUpperCase()} `)).toBe(true);
    expect(isAdminEmail('someone@else.com')).toBe(false);
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail('')).toBe(false);
    expect(adminEmail({ TM_ADMIN_EMAIL: 'Owner@Example.com' })).toBe('owner@example.com');
    expect(adminEmail({})).toBe(ADMIN);
    expect(adminEmail()).toBe(ADMIN);
  });

  it('is allowed whatever the list says — even when there is no list at all', () => {
    expect(isAllowedEmail(ADMIN, null)).toBe(true);
    expect(isAllowedEmail(ADMIN, list())).toBe(true);
    expect(isAllowedEmail('owner@example.com', null, { admin: 'owner@example.com' })).toBe(true);
  });

  it('is always the first row, with or without a stored one', () => {
    expect(allowEntries(null)[0]).toMatchObject({ email: ADMIN, addedBy: 'config' });
    const withStored = allowEntries({
      emails: [{ email: ADMIN, addedAt: 7, addedBy: 'u' }],
      updatedAt: 7,
    });
    expect(withStored).toHaveLength(1); // never twice
    expect(withStored[0]).toMatchObject({ email: ADMIN, addedAt: 7, addedBy: 'config' });
  });
});

describe('who else is allowed', () => {
  it('is exactly who the list names', () => {
    const l = list('a@x.com', 'b@x.com');
    expect(isAllowedEmail('A@X.com', l)).toBe(true);
    expect(isAllowedEmail('c@x.com', l)).toBe(false);
    expect(isAllowedEmail('', l)).toBe(false);
    expect(isAllowedEmail(null, l)).toBe(false);
  });

  it('is nobody when the list has never been written — unless the caller opens it', () => {
    expect(isAllowedEmail('a@x.com', null)).toBe(false);
    expect(isAllowedEmail('a@x.com', null, { openWhenUnset: true })).toBe(true);
    // An empty list is a decision, not an absent one.
    expect(isAllowedEmail('a@x.com', list(), { openWhenUnset: true })).toBe(false);
  });

  it('is added and removed idempotently, and never twice over', () => {
    let l = withAllowed(null, { email: 'A@x.com', addedAt: 5, addedBy: 'u_admin' });
    l = withAllowed(l, { email: 'a@x.com', addedAt: 9, addedBy: 'u_admin', note: 'again' });
    expect(l.emails).toHaveLength(1);
    expect(l.emails[0]).toMatchObject({ email: 'a@x.com', addedAt: 9, note: 'again' });
    l = withoutAllowed(l, 'A@X.COM', 10);
    expect(l.emails).toHaveLength(0);
    expect(l.updatedAt).toBe(10);
    // Removing somebody who is not there changes nothing but the stamp.
    expect(withoutAllowed(l, 'ghost@x.com', 11).emails).toHaveLength(0);
  });

  it('is listed oldest first, after the admin', () => {
    const rows = allowEntries(list('b@x.com', 'a@x.com'));
    expect(rows.map((r) => r.email)).toEqual([ADMIN, 'b@x.com', 'a@x.com']);
  });
});

describe('the refusal', () => {
  it('names who to ask, and is specific enough to act on', () => {
    expect(notAllowedDetails()).toEqual({ reason: 'notAllowed', admin: ADMIN });
  });
});

describe('an address on its way in', () => {
  it('is lower-cased and must look like one', () => {
    expect(EmailInputSchema.parse('  Priya@Example.COM ')).toBe('priya@example.com');
    expect(EmailInputSchema.safeParse('not-an-address').success).toBe(false);
    expect(EmailInputSchema.safeParse('two@@x.com').success).toBe(false);
    expect(normalizeEmail(undefined)).toBe('');
  });
});
