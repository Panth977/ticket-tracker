/**
 * THE BACKEND TAB: the typed editor, a real Build with its error on the right line,
 * Publish, and the route answering from outside. Needs a gateway (TM_GATEWAY_URL).
 */
import { expect, test } from '@playwright/test';
import { call, newPerson } from '../support/stack.js';
import { signIn } from '../support/ui.js';

const GATEWAY = process.env.TM_GATEWAY_URL;

test('write, build and publish a backend in the browser', async ({ page }) => {
  test.skip(!GATEWAY, 'needs a gateway');
  test.setTimeout(180_000);
  const owner = await newPerson('Editor');
  const { artifactId } = await call(owner, 'artifactCreate', { name: 'Typed backend' });
  await signIn(page, owner.email, `/x/${artifactId}?tab=backend`);

  await expect(page.locator('[data-artifact-tab="backend"] .monaco-editor').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Not live yet')).toBeVisible();
  // sandboxApi types reach the editor: the starter has no red squiggles.
  await expect(page.locator('.sbx-dev__panel, .sbx-dev').getByText(/Cannot find module/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Build', exact: true }).click();
  await expect(page.locator('[data-backend-routes]').getByText('/hello')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const url = page.locator('[data-backend-url]');
  await expect(url).toContainText(`/sandbox/${artifactId}`, { timeout: 60_000 });
  const res = await fetch(`${await url.innerText()}/hello?name=Panth`);
  expect(await res.json()).toEqual({ message: 'Hi!', from: 'Panth' });

  await page.reload();
  await expect(page.locator('[data-artifact-tab="backend"] .monaco-editor').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-backend-routes]').getByText('/hello')).toBeVisible();
});
