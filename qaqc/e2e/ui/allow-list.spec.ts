/**
 * PHASE 16 (docs/plan/agents.html §X) — WHOSE APP THIS IS, end to end.
 *
 * A second account signs in, is refused, is allowed by the admin, and gets in
 * — all through the browser, both sides open at once, so the moment the admin
 * presses Allow is the moment the other window stops being refused.
 *
 * WHAT THIS TEST TOUCHES, AND WHAT IT LEAVES ALONE. The guest is refused the
 * way production refuses them: `users/{uid}.allowed = false`, exactly what the
 * sign-up trigger writes for an address the list does not name. Pressing Allow
 * does write the real `_config/allow`, which is global — but under the
 * emulators an address the list does not name is still welcome unless a
 * document says otherwise (backend/src/platform/allow.ts), so no other suite
 * running beside this one is affected. The list is removed again at the end.
 */
import { expect, test } from '@playwright/test';
import { admin, eventually, newPerson, person, read } from '../support/stack.js';
import { DEFAULT_ADMIN_EMAIL } from '@tm/shared/config';
import { signIn } from '../support/ui.js';

/** The configured admin address (TM_ADMIN_EMAIL for the emulated backend), else the default. */
const ADMIN_EMAIL = process.env.TM_ADMIN_EMAIL ?? DEFAULT_ADMIN_EMAIL;

test.afterAll(async () => {
  await admin().db.doc('_config/allow').delete();
});

test('a second account signs in, is refused, is allowed by the admin, and gets in', async ({
  page,
  browser,
}) => {
  const owner = await person('Owner', ADMIN_EMAIL);
  const guest = await newPerson('Guest');
  // What onUserCreated writes in production for an address nobody allowed.
  await admin().db.doc(`users/${guest.uid}`).set({ allowed: false }, { merge: true });

  // ── the guest: signed in, and nowhere to go ──────────────────────────────
  const guestCtx = await browser.newContext();
  const guestPage = await guestCtx.newPage();
  await signIn(guestPage, guest.email);
  await expect(guestPage).toHaveURL(/\/welcome\/access/);
  const panel = guestPage.getByTestId('ask-for-access');
  await expect(panel.getByRole('heading', { name: 'This TaskManager is private' })).toBeVisible();
  await expect(guestPage.getByTestId('ask-for-access-email')).toContainText(guest.email);
  await expect(panel.getByRole('link', { name: ADMIN_EMAIL })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Sign out' })).toBeVisible();
  // No sidebar, no boards — and no way to reach one by typing its address.
  await expect(guestPage.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await guestPage.goto('/inbox');
  await expect(guestPage).toHaveURL(/\/welcome\/access/);

  // ── the admin: the Users module, beside Agents ──────────────────────────
  await signIn(page, owner.email, '/account/users');
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible();
  const list = page.getByRole('list', { name: 'People who may use this TaskManager' });
  const adminRow = list.getByRole('listitem').filter({ hasText: ADMIN_EMAIL });
  await expect(adminRow).toBeVisible();
  await expect(adminRow.getByText('Admin', { exact: true })).toBeVisible();
  // The admin is on the list by definition: there is nothing to press.
  await expect(adminRow.getByRole('button', { name: 'Take access away' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Add someone' }).click();
  await page.getByLabel('Email address').fill(guest.email);
  await page.getByLabel('Note (optional)').fill('The second tester');
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  const guestRow = list.getByRole('listitem').filter({ hasText: guest.email });
  await expect(guestRow).toBeVisible();
  await expect(guestRow).toContainText('The second tester');

  // the list is written where the server reads it, and the mirror with it
  const stored = await eventually('the allow list', async () =>
    read<{ emails: { email: string }[] }>('_config/allow'),
  );
  expect(stored.emails.map((e) => e.email)).toContain(guest.email);
  await eventually(
    'the mirrored flag',
    async () => (await read(`users/${guest.uid}`))?.allowed === true,
  );

  // ── the guest, in the window that was refused a moment ago ──────────────
  await expect(guestPage).not.toHaveURL(/\/welcome\/access/, { timeout: 30_000 });
  await expect(guestPage.getByTestId('ask-for-access')).toHaveCount(0);

  // ── and taking it away again ────────────────────────────────────────────
  await guestRow.getByRole('button', { name: 'Take access away' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Take access away' }).click();
  await expect(list.getByRole('listitem').filter({ hasText: guest.email })).toHaveCount(0);
  await eventually(
    'the mirror to say no',
    async () => (await read(`users/${guest.uid}`))?.allowed === false,
  );

  await guestCtx.close();
});

test('the Users module is the admin’s alone', async ({ page }) => {
  const other = await newPerson('Ordinary');
  await signIn(page, other.email, '/account/profile');
  // Not in the menu…
  await expect(
    page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Users' }),
  ).toHaveCount(0);
  // …and nothing to see for anyone who types the address.
  await page.goto('/account/users');
  await expect(page.getByRole('heading', { name: 'Only the admin manages access' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add someone' })).toHaveCount(0);
});
