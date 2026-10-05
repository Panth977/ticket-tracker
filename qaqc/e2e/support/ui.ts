/**
 * Browser helpers. Sign-in is the real email-link flow: the Auth emulator
 * keeps every link it "sent" at /emulator/v1/projects/{p}/oobCodes, and the
 * link lands on /login in the same browser (the address is in localStorage),
 * exactly as opening the email would.
 */
import { expect, type Page } from '@playwright/test';
import { eventually, PROJECT_ID } from './stack.js';

interface OobCode {
  email: string;
  oobLink: string;
  requestType: string;
}

async function signInLinks(email: string): Promise<OobCode[]> {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST!;
  const r = await fetch(`http://${host}/emulator/v1/projects/${PROJECT_ID}/oobCodes`);
  const { oobCodes } = (await r.json()) as { oobCodes: OobCode[] };
  return oobCodes.filter(
    (c) => c.email.toLowerCase() === email.toLowerCase() && c.requestType === 'EMAIL_SIGNIN',
  );
}

/** Request a sign-in link on /login and open it. Resolves once the app moved past /login. */
export async function signIn(page: Page, email: string, next?: string): Promise<void> {
  const before = (await signInLinks(email)).length;
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByText('We sent a sign-in link')).toBeVisible();
  const link = await eventually('sign-in link', async () => {
    const links = await signInLinks(email);
    return links.length > before ? links[links.length - 1]!.oobLink : null;
  });
  await page.goto(link);
  await page.waitForURL(
    (u) => !u.pathname.startsWith('/login') && !u.pathname.startsWith('/emulator'),
    { timeout: 30_000 },
  );
}

// ─── access (frontend/src/lib/access): Subscriptions / Subscribers ──────────

/** The open two-step Add / Edit dialog. */
export const subscribeDialog = (page: Page) =>
  // The nearest <dialog> around the step (it may sit inside another dialog, e.g. the workspace form).
  page.locator('[data-subscribe-step]').locator('xpath=ancestor::dialog[1]');

/** Tick exactly these permission boxes (by key: read, write, view, comment, edit, admin, build). */
export async function setPerms(page: Page, keys: string[]): Promise<void> {
  const dlg = subscribeDialog(page);
  const boxes = dlg.locator('input[data-perm]');
  const all = await boxes.evaluateAll((els) => els.map((e) => e.getAttribute('data-perm')!));
  for (const k of all) if (keys.includes(k)) await dlg.locator(`input[data-perm="${k}"]`).check();
  for (const k of [...all].reverse())
    if (!keys.includes(k)) await dlg.locator(`input[data-perm="${k}"]`).uncheck();
  for (const k of all)
    await expect(dlg.locator(`input[data-perm="${k}"]`)).toBeChecked({ checked: keys.includes(k) });
}

/**
 * Subscriptions › Add: pick `candidate` ('memory:<id>', 'board:<id>'…) and, when
 * the relation has permissions, tick `perms` and press Add. `list` is the
 * data-subscriptions name ('board', 'artifact', 'agent', 'workspace').
 */
export async function subscribe(
  page: Page,
  list: string,
  candidate: string,
  perms?: string[],
  before?: () => Promise<void>,
): Promise<void> {
  await page
    .locator(`[data-subscriptions="${list}"]`)
    .getByRole('button', { name: 'Add', exact: true })
    .click();
  const dlg = subscribeDialog(page);
  await dlg.locator(`[data-candidate="${candidate}"]`).click();
  if (!perms) {
    await expect(dlg).toHaveCount(0);
    return;
  }
  await setPerms(page, perms);
  if (before) await before();
  await dlg.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dlg).toHaveCount(0);
}
