/**
 * A build made outside the app, published with its source: the Code tab shows that
 * source, read only, instead of saying there is none.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { API_URL, call, newPerson } from '../support/stack.js';
import { signIn } from '../support/ui.js';

test('the Code tab shows the source kept beside a classic build', async ({ page }) => {
  const { createClient } = (await import('../../../sdk/dist/sdk.js' as string)) as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the built SDK, imported untyped
    createClient: (o: { token: string; baseUrl: string }) => any;
  };
  const owner = await newPerson('Vite');
  const { key: token } = await call(owner, 'apiKeyCreate', {
    name: 'publish',
    kind: 'account',
    scopes: ['artifacts:read', 'artifacts:write'],
  });
  const tm = createClient({ token, baseUrl: API_URL });
  const dir = mkdtempSync(join(tmpdir(), 'tm-src-'));
  mkdirSync(join(dir, 'dist'), { recursive: true });
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'dist', 'index.html'), '<h1>built</h1>');
  writeFileSync(join(dir, 'src', 'main.ts'), 'export const fromTheSource = "kept";\n');
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
  const art = await tm.artifacts.create({ name: 'Built elsewhere' });
  await tm.artifacts.publish(art.id, join(dir, 'dist'), { source: dir, message: 'one' });

  await signIn(page, owner.email, `/x/${art.id}?tab=code`);
  await expect(page.locator('[data-source-view]')).toContainText('read only');
  await expect(page.locator('[data-source-view] .monaco-editor').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-source-view]')).toContainText('fromTheSource');
  await expect(page.locator('[data-source-view]')).toContainText('package.json');
});
