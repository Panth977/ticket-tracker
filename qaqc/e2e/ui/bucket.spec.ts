/**
 * BUCKET, end to end (docs/plan/bucket.html §F) — the app as a person uses it:
 *
 *   M1  create a bucket, a folder, upload a Markdown file into it; preview
 *       renders it; Code mode edits and saves a new version (⌘S)
 *   M2  Tree ⇄ Folders; rename, move to…, delete from a node's menu
 *   M5  right-click menus (new / delete file and folder, on a node and on the
 *       empty space), a rename with '/' that moves, the upload dialog's path
 *       field, and the drop target lighting up while a node is dragged
 *   M3  it lives under its owner: under me in the sidebar, a card on my page
 *       (`/bucket` lands there); nothing hides it
 *   M4  an org owns it: its card is on the org's page, and opening it shows
 *       "Org ›" and the switcher of the org's things
 *
 * And the consistency asks that came with it:
 *   C1  artifacts are cards too (on my page); an artifact's header (and its settings)
 *       has the same title dropdown as a board's
 */
import { expect, test, type Page } from '@playwright/test';
import { admin, call, eventually, newBoard, newPerson } from '../support/stack.js';
import { signIn, thingIdAt } from '../support/ui.js';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main' });

/** The node row in the tree, or a tile in the folders view. */
const nodeEl = (page: Page, path: string) => page.locator(`[data-node="${path}"]`).first();

async function nodeByPath(
  bucketId: string,
  path: string,
): Promise<{ id: string; file: { fileId: string } | null } | null> {
  const q = await admin()
    .db.collection(`buckets/${bucketId}/nodes`)
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

test('M1–M4: a bucket — upload, preview, edit as code, views, rename / move / delete, hide, org', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  await signIn(page, ada.email, '/bucket');

  // ── M1: create it ──────────────────────────────────────────────────────────
  await page.getByRole('link', { name: 'New bucket' }).first().click();
  const dialog = page.getByRole('main');
  await dialog.getByLabel('Name').fill('Brand kit');
  await dialog.getByRole('button', { name: 'Create' }).click();
  const bucketId = await thingIdAt(page, ada, 'bucket');
  await expect(page.locator('[data-bucket-switcher]')).toContainText('Brand kit');
  // the sidebar lists it
  await expect(sidebar(page).locator(`[data-bucket="${bucketId}"]`)).toBeVisible();

  // Tree view for the start (the toggle is remembered per browser).
  await page.getByRole('button', { name: 'Tree' }).click();

  // a folder
  await page.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  const named = page.getByRole('dialog', { name: 'New folder' });
  await named.getByLabel('Name or path').fill('docs');
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
    buffer: Buffer.from('# Hello bucket\n\nFirst version.\n'),
  });
  // it asks where first: one path field, the open folder filled in
  const up = page.getByRole('dialog', { name: 'Upload a file' });
  await expect(up.getByLabel('Path')).toHaveValue('/docs/readme.md');
  await up.getByRole('button', { name: 'Upload' }).click();
  await expect(nodeEl(page, 'docs/readme.md')).toBeVisible({ timeout: 20_000 });
  const first = await eventually('the node', () => nodeByPath(bucketId, 'docs/readme.md'));
  const firstFileId = first.file!.fileId;

  // preview renders it
  await nodeEl(page, 'docs/readme.md')
    .getByRole('button', { name: 'readme.md', exact: true })
    .click();
  await page.waitForURL(/path=docs%2Freadme\.md/);
  await expect(page.getByRole('heading', { name: 'Hello bucket' })).toBeVisible();

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
  const saved = await call(ada, 'bucketFileRead', { bucketId, path: 'docs/readme.md' });
  expect(saved.text).toContain('Second line, from code mode.');
  expect(saved.node.file?.fileId).not.toBe(firstFileId);
  // …and the preview shows it
  await page.getByRole('tab', { name: 'Preview' }).click();
  await expect(page.getByText('Second line, from code mode.')).toBeVisible();

  // ── M2: Folders view; rename, move, delete ─────────────────────────────────
  await call(ada, 'bucketFolderCreate', { bucketId, path: 'archive' });
  await page.getByRole('button', { name: 'Folders' }).click();
  await expect(page.locator('[data-bucket-page]')).toHaveAttribute('data-view', 'folders');
  await page.locator('[data-breadcrumb]').getByRole('button', { name: 'docs' }).click();
  await expect(page.locator('[data-folder-view="docs"]')).toBeVisible();
  await expect(nodeEl(page, 'docs/readme.md')).toBeVisible();

  await menuAction(page, 'docs/readme.md', 'Rename F2');
  const rename = page.getByRole('dialog', { name: /Rename/ });
  await rename.getByLabel('Name or path').fill('intro.md');
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(nodeEl(page, 'docs/intro.md')).toBeVisible();

  await menuAction(page, 'docs/intro.md', 'Move to…');
  const move = page.getByRole('dialog', { name: /Move/ });
  await move.getByRole('option', { name: 'archive' }).click();
  await move.getByRole('button', { name: 'Move here' }).click();
  await eventually('moved', async () =>
    (await nodeByPath(bucketId, 'archive/intro.md')) ? true : null,
  );
  await expect(nodeEl(page, 'docs/intro.md')).toHaveCount(0);

  await page.locator('[data-breadcrumb]').getByRole('button', { name: 'Brand kit' }).click();
  await menuAction(page, 'archive', 'Delete folder');
  await page
    .getByRole('dialog', { name: /Delete archive/ })
    .getByRole('button', { name: 'Delete' })
    .click();
  await eventually('deleted', async () =>
    (await nodeByPath(bucketId, 'archive/intro.md')) ? null : true,
  );
  await expect(nodeEl(page, 'archive')).toHaveCount(0);

  // ── M3: under its owner — me — in the sidebar and as a card on my page ──
  await expect(
    sidebar(page).locator('[data-owners="users"]').locator(`[data-bucket="${bucketId}"]`),
  ).toBeVisible();
  await page.goto('/bucket');
  await page.waitForURL((u) => u.pathname !== '/bucket');
  const card = page.locator(`main a[data-bucket="${bucketId}"]`);
  await expect(card).toHaveClass(/rounded-xl/);
  await expect(card).toContainText('Owner');
  await expect(card.getByRole('button', { name: /Hide/ })).toHaveCount(0);

  // ── M4: an org owns it ───────────────────────────────────────────────────
  const handle = `st-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const { orgId } = await call(ada, 'orgCreate', { handle, name: 'Studio' });
  const b = await newBoard(ada, { name: 'Design' });
  await call(ada, 'ownerTransfer', {
    thing: { kind: 'board', id: b.id },
    to: { kind: 'org', id: orgId },
  });
  await call(ada, 'ownerTransfer', {
    thing: { kind: 'bucket', id: bucketId },
    to: { kind: 'org', id: orgId },
  });
  await page.goto(`/${handle}`);
  await expect(page.getByRole('heading', { name: 'Studio', level: 1 })).toBeVisible();
  const orgCard = page.locator(`main a[data-bucket="${bucketId}"]`);
  await expect(orgCard).toBeVisible();
  await orgCard.click();
  await page.waitForURL(`**/${handle}/bucket/**`);
  await expect(page.locator('[data-org-crumb]')).toHaveText('Studio');
  // …and in the sidebar under the org now, not under me.
  await expect(
    sidebar(page).locator('[data-owners="orgs"]').locator(`[data-bucket="${bucketId}"]`),
  ).toBeVisible();
  await expect(
    sidebar(page).locator('[data-owners="users"]').locator(`[data-bucket="${bucketId}"]`),
  ).toHaveCount(0);
  await page.locator('[data-bucket-switcher]').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: `${b.key} · Design` })).toBeVisible();
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

test('M5: right-click, rename with /, the upload path, and the drop target', async ({ page }) => {
  const ada = await newPerson('Ada');
  const { bucketId } = await call(ada, 'bucketCreate', { name: 'Notes' });
  await call(ada, 'bucketFileWrite', { bucketId, path: 'docs/a.md', text: '# A' });
  await call(ada, 'bucketFolderCreate', { bucketId, path: 'archive' });
  await signIn(page, ada.email, `/bucket/${bucketId}`);
  await page.getByRole('button', { name: 'Tree' }).click();
  await expect(nodeEl(page, 'docs')).toBeVisible();

  // ── right-click the empty space: new folder, at the top level ─────────────
  await page.locator('[data-drop-root]').click({ button: 'right', position: { x: 40, y: 200 } });
  await page.getByRole('menuitem', { name: 'New folder', exact: true }).click();
  const nf = page.getByRole('dialog', { name: 'New folder' });
  await nf.getByLabel('Name or path').fill('drafts/2026');
  await expect(nf.locator('[data-resolved-path]')).toContainText('/drafts/2026');
  await nf.getByRole('button', { name: 'Create' }).click();
  await eventually('nested folder', async () =>
    (await nodeByPath(bucketId, 'drafts/2026')) ? true : null,
  );

  // ── right-click a folder: new file inside it ──────────────────────────────
  await nodeEl(page, 'docs').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New file', exact: true }).click();
  const nfile = page.getByRole('dialog', { name: 'New file' });
  await nfile.getByLabel('Name or path').fill('b.md');
  await nfile.getByRole('button', { name: 'Create' }).click();
  await eventually('new file', async () =>
    (await nodeByPath(bucketId, 'docs/b.md')) ? true : null,
  );

  // ── rename with '/': it moves, creating the folder ─────────────────────────
  await nodeEl(page, 'docs/a.md').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const rn = page.getByRole('dialog', { name: /Rename/ });
  await rn.getByLabel('Name or path').fill('old/a-v1.md');
  await expect(rn.locator('[data-resolved-path]')).toContainText('/docs/old/a-v1.md');
  await rn.getByRole('button', { name: 'Rename' }).click();
  await eventually('renamed into a new folder', async () =>
    (await nodeByPath(bucketId, 'docs/old/a-v1.md')) ? true : null,
  );
  // a clash is caught in the dialog
  await nodeEl(page, 'docs/b.md').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await rn.getByLabel('Name or path').fill('/archive');
  await expect(rn.getByText('A folder with that name is already there')).toBeVisible();
  await rn.getByRole('button', { name: 'Cancel' }).click();

  // ── right-click a file: delete it ─────────────────────────────────────────
  await nodeEl(page, 'docs/b.md').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete file' }).click();
  await page
    .getByRole('dialog', { name: /Delete b\.md/ })
    .getByRole('button', { name: 'Delete' })
    .click();
  await eventually('deleted', async () =>
    (await nodeByPath(bucketId, 'docs/b.md')) ? null : true,
  );

  // ── upload: the path field renames and places it ─────────────────────────
  await page.locator('[data-drop-root]').click({ button: 'right', position: { x: 40, y: 200 } });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Upload files…' }).click();
  await (
    await chooser
  ).setFiles([
    { name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') },
    { name: 'todo.txt', mimeType: 'text/plain', buffer: Buffer.from('x') },
  ]);
  const up = page.getByRole('dialog', { name: 'Upload 2 files' });
  await expect(up.getByLabel('Path for logo.svg')).toHaveValue('/logo.svg');
  await up.getByLabel('Path for logo.svg').fill('/brand/mark.svg');
  await up.getByLabel('Path for todo.txt').fill('/archive');
  await expect(up.getByText('A folder is already at that path')).toBeVisible();
  await up.getByRole('button', { name: "Don't upload todo.txt" }).click();
  await up.getByRole('button', { name: 'Upload' }).click();
  await eventually('uploaded where asked', async () =>
    (await nodeByPath(bucketId, 'brand/mark.svg')) ? true : null,
  );

  // ── drag: the folder it would land in lights up, then takes it ────────────
  await expect(nodeEl(page, 'brand/mark.svg')).toBeVisible();
  const src = nodeEl(page, 'brand/mark.svg');
  const dst = nodeEl(page, 'archive');
  await src.hover();
  await page.mouse.down();
  const box = (await dst.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await expect(page.locator('li[data-drop-target]')).toHaveCount(1);
  await expect(page.locator('li[data-drop-target] > [data-node="archive"]')).toBeVisible();
  await expect(page.locator('[data-drag-label]')).toContainText('into /archive');
  await page.mouse.up();
  await eventually('dropped into archive', async () =>
    (await nodeByPath(bucketId, 'archive/mark.svg')) ? true : null,
  );
  await expect(page.locator('[data-drop-target]')).toHaveCount(0);
});

test('M6: the open file follows a move of its folder (from anywhere)', async ({ page }) => {
  const ada = await newPerson('Ada');
  const { bucketId } = await call(ada, 'bucketCreate', { name: 'Health' });
  await call(ada, 'bucketFileWrite', { bucketId, path: 'a/b/c.md', text: '# Follow me' });
  await signIn(page, ada.email, `/bucket/${bucketId}?path=a%2Fb%2Fc.md`);
  await page.getByRole('button', { name: 'Tree' }).click();
  await expect(page.getByRole('heading', { name: 'Follow me' })).toBeVisible();

  // moved somewhere else (another tab, an agent): a/b → b
  await call(ada, 'bucketMove', { bucketId, path: 'a/b', toPath: 'b' });
  await page.waitForURL(/path=b%2Fc\.md$/);
  await expect(page.getByRole('heading', { name: 'Follow me' })).toBeVisible();
  await expect(page.getByText('Not in this bucket')).toHaveCount(0);

  // and a rename of the file itself, too
  await call(ada, 'bucketMove', { bucketId, path: 'b/c.md', toPath: 'b/d.md' });
  await page.waitForURL(/path=b%2Fd\.md$/);
  await expect(page.getByText('Not in this bucket')).toHaveCount(0);
});

test('M7: the open folder and its parents can be folded', async ({ page }) => {
  const ada = await newPerson('Ada');
  const { bucketId } = await call(ada, 'bucketCreate', { name: 'Folds' });
  await call(ada, 'bucketFileWrite', { bucketId, path: 'a/b/c.md', text: '# C' });
  await signIn(page, ada.email, `/bucket/${bucketId}?path=a%2Fb`);
  await page.getByRole('button', { name: 'Tree' }).click();
  const tree = page.getByRole('tree', { name: 'Files' });
  await expect(tree.locator('[data-node="a/b/c.md"]')).toBeVisible();

  // fold the open folder itself: it stays folded
  await tree.getByRole('button', { name: 'Fold b' }).click();
  await expect(tree.locator('[data-node="a/b/c.md"]')).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(tree.locator('[data-node="a/b/c.md"]')).toHaveCount(0);
  // and its parent
  await tree.getByRole('button', { name: 'Fold a' }).click();
  await expect(tree.locator('[data-node="a/b"]')).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(tree.locator('[data-node="a/b"]')).toHaveCount(0);
  // opening something again unfolds the way to it
  await page.goto(`/bucket/${bucketId}?path=a%2Fb%2Fc.md`);
  await expect(tree.locator('[data-node="a/b/c.md"]')).toBeVisible();
});
