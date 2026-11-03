/**
 * Profile picture: Account › Profile › Upload → crop → Save picture, and the
 * picture SHOWS (the <img> decodes) — after the upload, and after a reload.
 * ORCH-35: on the IceBase server the upload saved but the picture never showed.
 */
import { expect, test } from '@playwright/test';
import { newPerson } from '../support/stack.js';
import { signIn } from '../support/ui.js';

test('a new profile picture shows, and still shows after a reload', async ({ page }) => {
  const ada = await newPerson('Ada', 'Lovelace');
  const failed: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  await signIn(page, ada.email, '/account');
  await page.getByRole('button', { name: /Upload a picture|Change picture/ }).click();
  await page
    .locator('input[type=file][accept="image/*"]')
    .setInputFiles(new URL('../fixtures/avatar.png', import.meta.url).pathname);
  await page.getByRole('button', { name: 'Save picture' }).click();
  await expect(page.getByText('Picture updated')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change picture' })).toBeVisible();

  const shown = page.locator('img[src*="avatar"]').first();
  const decoded = async () =>
    shown.evaluate(
      (el: { complete: boolean; naturalWidth: number }) => el.complete && el.naturalWidth > 0,
    );
  await expect(shown, `failed requests: ${failed.join('\n')}`).toBeVisible({ timeout: 15_000 });
  await expect.poll(decoded, { timeout: 15_000 }).toBe(true);

  await page.reload();
  await expect(shown, `failed requests: ${failed.join('\n')}`).toBeVisible({ timeout: 15_000 });
  await expect.poll(decoded, { timeout: 15_000 }).toBe(true);
});
