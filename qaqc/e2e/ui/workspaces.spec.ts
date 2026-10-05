/**
 * WORKSPACES END TO END (docs/plan/agents.html §AB).
 *
 *   AB1  a workspace bundles boards and artifacts I already have; it grants
 *        nothing and moves nothing (they stay in the root lists too)
 *   AB2  the sidebar shows it, folded or unfolded; HIDING takes an item out of
 *        the root lists only — the All pages and the workspace still show it
 *   AB3  a board opened THROUGH a workspace shows "Workspace › Board", and its
 *        switcher lists only the workspace's boards and artifacts; opening a
 *        board from the root list leaves the workspace
 */
import { expect, test, type Page } from '@playwright/test';
import { call, eventually, newBoard, newPerson, read } from '../support/stack.js';
import { signIn } from '../support/ui.js';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const section = (page: Page, name: string) =>
  sidebar(page).locator('div.flex.flex-col.gap-px', {
    has: page.getByRole('heading', { name, exact: true }),
  });

test('AB1–AB3: create a workspace, work inside it, hide a board from the root', async ({ page }) => {
  const ada = await newPerson('Ada');
  const fl = await newBoard(ada, { name: 'FreeLance' });
  const fr = await newBoard(ada, { name: 'FreeLance Review' });
  const hea = await newBoard(ada, { name: 'Health' });
  const { artifactId } = await call(ada, 'artifactCreate', { name: 'FreeLance Dashboard' });

  await signIn(page, ada.email, '/me');
  const nav = sidebar(page);

  // AB1 — make one from the sidebar: two boards and the dashboard.
  await nav.getByRole('button', { name: 'New workspace' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New workspace' });
  await dialog.getByLabel('Name').fill('Freelance');
  await dialog.getByLabel(`${fl.key} · FreeLance`, { exact: true }).check();
  await dialog.getByLabel(`${fr.key} · FreeLance Review`, { exact: true }).check();
  await dialog.getByLabel(/FreeLance Dashboard/).check();
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL('**/w/**');
  const workspaceId = new URL(page.url()).pathname.split('/')[2]!;
  await expect(page.getByRole('heading', { name: 'Freelance', level: 1 })).toBeVisible();
  const ws = await read<{ boardIds: string[]; artifactIds: string[] }>(
    `users/${ada.uid}/workspaces/${workspaceId}`,
  );
  expect(ws).toMatchObject({ boardIds: [fl.id, fr.id], artifactIds: [artifactId] });

  // …and nothing moved: the root BOARDS list still has all three.
  const boards = section(page, 'Boards');
  for (const key of [fl.key, fr.key, hea.key])
    await expect(boards.locator(`[data-board="${key}"]`)).toBeVisible();

  // AB3 — through the workspace page: breadcrumb + a switcher of the workspace only.
  await page.locator(`main [data-board="${fr.key}"]`).click();
  await page.waitForURL(`**/b/${fr.key}/**`);
  await expect(page.locator('[data-workspace-crumb]')).toHaveText('Freelance');
  await page.locator('[data-board-switcher]').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: `${fl.key} · FreeLance`, exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /FreeLance Dashboard/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: new RegExp(hea.key) })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The artifact's title is a switcher too: inside the workspace, the same list.
  await menu.getByRole('menuitem', { name: /FreeLance Dashboard/ }).waitFor({ state: 'detached' });
  await page.goto(`/w/${workspaceId}`);
  await page.locator(`main [data-artifact="${artifactId}"]`).click();
  await page.waitForURL(`**/x/${artifactId}`);
  await expect(page.locator('[data-workspace-crumb]')).toHaveText('Freelance');
  await page.locator('[data-artifact-switcher]').click();
  const amenu = page.getByRole('menu');
  await expect(amenu.getByRole('menuitem', { name: `${fr.key} · FreeLance Review` })).toBeVisible();
  await expect(amenu.getByRole('menuitem', { name: 'Show all artifacts' })).toBeVisible();
  await expect(amenu.getByRole('menuitem', { name: new RegExp(hea.key) })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // From the root list: the workspace is left, the switcher is every board again.
  await boards.locator(`[data-board="${hea.key}"]`).click();
  await page.waitForURL(`**/b/${hea.key}/**`);
  await expect(page.locator('[data-workspace-crumb]')).toHaveCount(0);
  await page.locator('[data-board-switcher]').click();
  await expect(page.getByRole('menu').getByRole('menuitem', { name: new RegExp(fr.key) })).toBeVisible();
  await page.keyboard.press('Escape');

  // AB2 — hide FreeLance Review from the root: gone from BOARDS, still in the workspace.
  await nav.getByRole('link', { name: 'All boards & archived' }).click();
  await page.locator(`main [data-board="${fr.key}"]`).hover();
  await page
    .locator(`main [data-board="${fr.key}"]`)
    .getByRole('button', { name: /Hide .* from the sidebar/ })
    .click();
  await expect(boards.locator(`[data-board="${fr.key}"]`)).toHaveCount(0);
  await eventually('hidden saved', async () => {
    const side = await read<{ hiddenBoardIds: string[] }>(`users/${ada.uid}/ui/sidebar`);
    return side?.hiddenBoardIds.includes(fr.id);
  });
  // Hiding is UI only: not archived, still on the All page and in the workspace.
  expect((await read<{ archivedAt: unknown }>(`boards/${fr.id}`))!.archivedAt).toBeNull();
  await expect(page.locator(`main [data-board="${fr.key}"]`)).toContainText('Hidden from sidebar');
  const wsRow = nav.locator(`[data-workspace="${workspaceId}"]`);
  await nav.getByRole('button', { name: 'Unfold Freelance' }).click();
  await expect(nav.locator(`[data-board="${fr.key}"]`)).toBeVisible();
  await expect(wsRow).toBeVisible();

  // …and shown again.
  await page
    .locator(`main [data-board="${fr.key}"]`)
    .getByRole('button', { name: /Show .* in the sidebar/ })
    .click();
  await expect(boards.locator(`[data-board="${fr.key}"]`)).toBeVisible();
});
