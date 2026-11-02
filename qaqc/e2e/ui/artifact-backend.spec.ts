/**
 * THE BACKEND TAB: the typed editor, a real Build with its error on the right line,
 * Publish, and the route answering from outside. Needs a gateway (TM_GATEWAY_URL).
 */
import { expect, test } from '@playwright/test';
import { call, newPerson } from '../support/stack.js';
import { signIn } from '../support/ui.js';

const GATEWAY = process.env.TM_GATEWAY_URL;

test('frontend and backend in one tree, one Publish', async ({ page }) => {
  test.skip(!GATEWAY, 'needs a gateway');
  test.setTimeout(180_000);
  const owner = await newPerson('Editor');
  const { artifactId } = await call(owner, 'artifactCreate', { name: 'Both' });
  await signIn(page, owner.email, `/x/${artifactId}?tab=code`);

  await page.getByRole('button', { name: 'JavaScript', exact: true }).click();
  const tree = page.locator('.sbx-dev__tree, .sbx-tree').first();
  await expect(page.locator('[data-kit-dev] .monaco-editor').first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Add backend' }).click();
  await expect(tree).toContainText('backend');
  await expect(page.locator('[data-kit-dev]')).toContainText('sandboxApi');

  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.locator('[data-backend-routes]').getByText('/hello')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const url = page.locator('[data-backend-url]');
  await expect(url).toContainText(`/sandbox/${artifactId}`, { timeout: 60_000 });
  const res = await fetch(`${await url.innerText()}/hello?name=Panth`);
  expect(await res.json()).toEqual({ message: 'Hi!', from: 'Panth' });
  // One Publish made the website build too.
  await expect.poll(async () => (await call(owner, 'artifactOpen', { artifactId })).buildId, { timeout: 30_000 }).toBeTruthy();
  await expect(page.getByRole('link', { name: 'Backend', exact: true })).toHaveCount(0);

  await page.goto(`/x/${artifactId}?tab=backend`);
  await expect(page.locator('[data-kit-dev] .monaco-editor').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-backend-routes]').getByText('/hello')).toBeVisible();
});

test('a backend alone', async ({ page }) => {
  test.skip(!GATEWAY, 'needs a gateway');
  test.setTimeout(120_000);
  const owner = await newPerson('Alone');
  const { artifactId } = await call(owner, 'artifactCreate', { name: 'Only backend' });
  await signIn(page, owner.email, `/x/${artifactId}?tab=code`);
  await page.getByRole('button', { name: 'Backend only' }).click();
  await expect(page.locator('[data-kit-dev] .monaco-editor').first()).toBeVisible({ timeout: 60_000 });
  // The provided files type-check in the editor, with no problems to wade through.
  await expect(page.locator('.sbx-dev').getByText('Types ready')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(3000);
  await expect(page.locator('.sbx-dev')).toContainText('Problems');
  await expect(page.locator('.sbx-dev').getByText(/implicitly|Cannot find module/)).toHaveCount(0);
  await expect(page.locator('.sbx-dev').getByText(/^Problems \(\d+\)$/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.locator('[data-backend-url]')).toContainText(artifactId, { timeout: 60_000 });
});
