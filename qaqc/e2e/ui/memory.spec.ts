/**
 * MEMORY, end to end (docs/plan/memory.html §F) — the app as a person uses it:
 *
 *   M1  create a memory, a folder, upload a Markdown file into it; preview
 *       renders it; Code mode edits and saves a new version (⌘S)
 *   M2  Tree ⇄ Folders; rename, move to…, delete from a node's menu
 *   M3  the list page is cards; hiding takes it out of the sidebar's root
 *   M4  a workspace bundles it: the card is there (no hide / show on a
 *       workspace page), and opening it keeps "Workspace ›" and the switcher
 *
 * And the consistency asks that came with it:
 *   C1  All artifacts is cards too; an artifact's header (and its settings)
 *       has the same title dropdown as a board's
 */
import { expect, test, type Page } from '@playwright/test';
import { admin, call, eventually, newBoard, newPerson, read } from '../support/stack.js';
import { signIn } from '../support/ui.js';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main' });

/** The node row in the tree, or a tile in the folders view. */
const nodeEl = (page: Page, path: string) => page.locator(`[data-node="${path}"]`).first();

async function nodeByPath(
  memoryId: string,
  path: string,
): Promise<{ id: string; file: { fileId: string } | null } | null> {
  const q = await admin()
    .db.collection(`memories/${memoryId}/nodes`)
    .where('path', '==', path)
    .get();
  const d = q.docs[0];
  return d ? { id: d.id, file: (d.get('file') as { fileId: string } | null) ?? null } : null;
}

async function menuAction(page: Page, path: string, action: string) {
  const el = nodeEl(page, path);
  await el.hover();
  await el.getByRole('button', { name: /^Actions for / }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

test('M1–M4: a memory — upload, preview, edit as code, views, rename / move / delete, hide, workspace', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  await signIn(page, ada.email, '/m');

  // ── M1: create it ──────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'New memory' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New memory' });
  await dialog.getByLabel('Name').fill('Brand kit');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(/\/m\/[A-Za-z0-9_-]+$/);
  const memoryId = new URL(page.url()).pathname.split('/')[2]!;
  await expect(page.locator('[data-memory-switcher]')).toContainText('Brand kit');
  // the sidebar lists it
  await expect(sidebar(page).locator(`[data-memory="${memoryId}"]`)).toBeVisible();

  // Tree view for the start (the toggle is remembered per browser).
  await page.getByRole('button', { name: 'Tree' }).click();

  // a folder
  await page.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  const named = page.getByRole('dialog', { name: 'New folder' });
  await named.getByLabel('Name').fill('docs');
  await named.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(/path=docs$/);
  await expect(nodeEl(page, 'docs')).toBeVisible();

  // upload a Markdown file into it (the folder that is open)
  await page.getByRole('button', { name: 'Add' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Upload files…' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'readme.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Hello memory\n\nFirst version.\n'),
  });
  await expect(nodeEl(page, 'docs/readme.md')).toBeVisible({ timeout: 20_000 });
  const first = await eventually('the node', () => nodeByPath(memoryId, 'docs/readme.md'));
  const firstFileId = first.file!.fileId;

  // preview renders it
  await nodeEl(page, 'docs/readme.md')
    .getByRole('button', { name: 'readme.md', exact: true })
    .click();
  await page.waitForURL(/path=docs%2Freadme\.md/);
  await expect(page.getByRole('heading', { name: 'Hello memory' })).toBeVisible();

  // Code mode: edit, ⌘S → a new version
  await page.getByRole('tab', { name: 'Code' }).click();
  const editor = page.locator('[data-code-editor] .cm-content');
  await expect(editor).toContainText('First version.');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Second line, from code mode.');
  await expect(page.locator('[data-dirty]')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('[data-dirty]')).toHaveCount(0);
  const saved = await call(ada, 'memoryFileRead', { memoryId, path: 'docs/readme.md' });
  expect(saved.text).toContain('Second line, from code mode.');
  expect(saved.node.file?.fileId).not.toBe(firstFileId);
  // …and the preview shows it
  await page.getByRole('tab', { name: 'Preview' }).click();
  await expect(page.getByText('Second line, from code mode.')).toBeVisible();

  // ── M2: Folders view; rename, move, delete ─────────────────────────────────
  await call(ada, 'memoryFolderCreate', { memoryId, path: 'archive' });
  await page.getByRole('button', { name: 'Folders' }).click();
  await expect(page.locator('[data-memory-page]')).toHaveAttribute('data-view', 'folders');
  await page.locator('[data-breadcrumb]').getByRole('button', { name: 'docs' }).click();
  await expect(page.locator('[data-folder-view="docs"]')).toBeVisible();
  await expect(nodeEl(page, 'docs/readme.md')).toBeVisible();

  await menuAction(page, 'docs/readme.md', 'Rename');
  const rename = page.getByRole('dialog', { name: /Rename/ });
  await rename.getByLabel('Name').fill('intro.md');
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(nodeEl(page, 'docs/intro.md')).toBeVisible();

  await menuAction(page, 'docs/intro.md', 'Move to…');
  const move = page.getByRole('dialog', { name: /Move/ });
  await move.getByRole('option', { name: 'archive' }).click();
  await move.getByRole('button', { name: 'Move here' }).click();
  await eventually('moved', async () =>
    (await nodeByPath(memoryId, 'archive/intro.md')) ? true : null,
  );
  await expect(nodeEl(page, 'docs/intro.md')).toHaveCount(0);

  await page.locator('[data-breadcrumb]').getByRole('button', { name: 'Brand kit' }).click();
  await menuAction(page, 'archive', 'Delete');
  await page
    .getByRole('dialog', { name: /Delete archive/ })
    .getByRole('button', { name: 'Delete' })
    .click();
  await eventually('deleted', async () =>
    (await nodeByPath(memoryId, 'archive/intro.md')) ? null : true,
  );
  await expect(nodeEl(page, 'archive')).toHaveCount(0);

  // ── M3: the list is cards; hide from the sidebar ──────────────────────────
  await sidebar(page).getByRole('link', { name: 'All memory' }).click();
  const card = page.locator(`main a[data-memory="${memoryId}"]`);
  await expect(card).toHaveClass(/rounded-xl/);
  await card.hover();
  await card.getByRole('button', { name: /Hide .* from the sidebar/ }).click();
  await expect(sidebar(page).locator(`[data-memory="${memoryId}"]`)).toHaveCount(0);
  await eventually('hidden saved', async () => {
    const side = await read<{ hiddenMemoryIds?: string[] }>(`users/${ada.uid}/ui/sidebar`);
    return side?.hiddenMemoryIds?.includes(memoryId) ? true : null;
  });
  await expect(card).toContainText('Hidden from sidebar');

  // ── M4: a workspace bundles it ────────────────────────────────────────────
  const b = await newBoard(ada, { name: 'Design' });
  const { workspaceId } = await call(ada, 'workspaceCreate', {
    name: 'Studio',
    boardIds: [b.id],
    memoryIds: [memoryId],
  });
  await page.goto(`/w/${workspaceId}`);
  await expect(page.getByRole('heading', { name: 'Studio', level: 1 })).toBeVisible();
  const wsCard = page.locator(`main a[data-memory="${memoryId}"]`);
  await expect(wsCard).toBeVisible();
  // No hide / show on a workspace page — for anything on it.
  await expect(page.locator('main [data-hide-toggle]')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('Hidden from sidebar');
  await wsCard.click();
  await page.waitForURL(`**/m/${memoryId}`);
  await expect(page.locator('[data-workspace-crumb]')).toHaveText('Studio');
  await page.locator('[data-memory-switcher]').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: `${b.key} · Design` })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Show all memory' })).toBeVisible();
});

test('C1: artifacts are cards, and an artifact has the board’s title dropdown — on its settings too', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const { artifactId } = await call(ada, 'artifactCreate', { name: 'Pulse' });
  await call(ada, 'artifactCreate', { name: 'Ledger' });
  await signIn(page, ada.email, '/x');
  const card = page.locator(`main a[data-artifact="${artifactId}"]`);
  await expect(card).toHaveClass(/rounded-xl/);
  await expect(card).toContainText('Pulse');
  await expect(card).toContainText('Owner');

  await card.click();
  await page.waitForURL(`**/x/${artifactId}`);
  const sw = page.locator('[data-artifact-switcher]');
  await expect(sw).toBeVisible();
  // the same control as a board's: the name is the page title
  await expect(sw.getByRole('heading', { level: 1 })).toHaveText('Pulse');
  await sw.click();
  await expect(page.getByRole('menu').getByRole('menuitem', { name: /Ledger/ })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto(`/x/${artifactId}/settings/general`);
  await expect(page.locator('[data-artifact-switcher]')).toBeVisible();
  await page.locator('[data-artifact-switcher]').click();
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: /Ledger/ })
    .click();
  await page.waitForURL(/\/x\/[A-Za-z0-9_-]+$/);
  expect(page.url()).not.toContain(artifactId);
});
