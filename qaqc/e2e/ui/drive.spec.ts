/**
 * BUCKETS IN GOOGLE DRIVE, end to end (docs/plan/bucket.html §K) — the app as
 * a person uses it, against the emulators' fake Drive:
 *
 *   D1  the new-bucket form asks where files live; Google Drive needs a
 *       connection first — the round trip comes back to where it started
 *   D2  a Drive bucket: the badge, a folder, an upload; nothing in Firestore
 *       but the bucket document (Drive is the truth)
 *   D3  the new-board form makes the board's ticket-file bucket (managed by
 *       default) and sets it as the attachment bucket
 *   D4  a ticket file into a Drive bucket, from the composer
 *
 * Drive buckets never touch our object store: every test fails on a request
 * to Storage (the browser's uploads go straight to Drive's session URL).
 */
import { expect, test, type Page } from '@playwright/test';
import { admin, call, eventually, newBoard, newPerson } from '../support/stack.js';
import { signIn, thingIdAt } from '../support/ui.js';

const nodeEl = (page: Page, path: string) => page.locator(`[data-node="${path}"]`).first();

/** Every request the page makes to Cloud Storage (emulator or real). */
function storageCalls(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/\/v0\/b\/|\/upload\/storage\/|firebasestorage|:9199|:9309\//.test(u)) seen.push(u);
  });
  return seen;
}

test('D1–D2: connect Drive from the bucket form, then a bucket that lives in Drive', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const storage = storageCalls(page);
  await signIn(page, ada.email, '/bucket');

  // ── D1: Drive is offered, but needs a connection ──────────────────────────
  await page.getByRole('button', { name: 'New bucket' }).first().click();
  let dialog = page.getByRole('dialog', { name: 'New bucket' });
  await dialog.getByTestId('storage-drive').click();
  await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Connect Google Drive' }).click();
  // Google (faked) → /integrations/drive/callback → back here.
  await expect(page.getByText('Google Drive connected')).toBeVisible({ timeout: 20_000 });
  expect(new URL(page.url()).searchParams.get('drive')).toBeNull();
  expect((await call(ada, 'driveStatus', {})).connected).toBe(true);

  // ── D2: the bucket ───────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'New bucket' }).first().click();
  dialog = page.getByRole('dialog', { name: 'New bucket' });
  await dialog.getByLabel('Name').fill('Drive notes');
  await dialog.getByTestId('storage-drive').click();
  await expect(dialog.getByTestId('storage-drive-path')).toBeVisible();
  await dialog.getByRole('button', { name: 'Create' }).click();
  const bucketId = await thingIdAt(page, ada, 'bucket');
  await expect(page.getByTestId('bucket-drive-badge')).toBeVisible();

  const doc = (await admin().db.doc(`buckets/${bucketId}`).get()).data()!;
  expect(doc.storage).toMatchObject({ kind: 'drive', folderName: 'Drive notes' });

  await page.getByRole('button', { name: 'Tree' }).click();
  await page.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  const named = page.getByRole('dialog', { name: 'New folder' });
  await named.getByLabel('Name or path').fill('docs');
  await named.getByRole('button', { name: 'Create' }).click();
  await expect(nodeEl(page, 'docs')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Add' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Upload files…' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'readme.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Hello Drive\n\nStored in Drive.\n'),
  });
  const up = page.getByRole('dialog', { name: 'Upload a file' });
  await up.getByRole('button', { name: 'Upload' }).click();
  await expect(nodeEl(page, 'docs/readme.md')).toBeVisible({ timeout: 20_000 });
  await nodeEl(page, 'docs/readme.md').click();
  await expect(page.getByRole('heading', { name: 'Hello Drive' })).toBeVisible({
    timeout: 20_000,
  });

  // Drive is the truth: no node documents, the tree comes from Drive.
  expect((await admin().db.collection(`buckets/${bucketId}/nodes`).get()).size).toBe(0);
  const tree = await call(ada, 'bucketTree', { bucketId });
  expect(tree.nodes.map((n) => n.path)).toEqual(['docs', 'docs/readme.md']);

  // Not one byte through our Storage.
  expect(storage).toEqual([]);

  // Settings say where it lives.
  await page.goto(`/bucket/${bucketId}/settings/general`);
  await expect(page.getByTestId('bucket-storage')).toContainText('Google Drive');
});

test('D3: a new board gets its ticket-file bucket (managed by default) as its attachment bucket', async ({
  page,
}) => {
  const bo = await newPerson('Bo');
  await signIn(page, bo.email, '/new-board');
  await page.getByLabel('Name').fill('Drive board');
  await page.getByLabel('Key').fill(`DB${Date.now().toString(36).slice(-3).toUpperCase()}`);
  await expect(page.getByTestId('storage-managed')).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Create board' }).click();
  await page.waitForURL(/\/b\//, { timeout: 20_000 });

  const boards = await admin().db.collection('boards').where('name', '==', 'Drive board').get();
  const board = boards.docs.find((d) => (d.get('readerUids') as string[]).includes(bo.uid))!;
  const attach = board.get('attachBucket') as { bucketId: string; template: string } | null;
  expect(attach?.bucketId).toBeTruthy();
  const bucket = (await admin().db.doc(`buckets/${attach!.bucketId}`).get()).data()!;
  expect(bucket.boards).toEqual({ [board.id]: 'write' });
  expect(bucket.storage).toBeUndefined();
});

test('D4: a ticket file goes into a Drive bucket from the composer, never through Storage', async ({
  page,
}) => {
  const cy = await newPerson('Cy');
  const storage = storageCalls(page);
  await signIn(page, cy.email, '/account/drive');
  await page.getByRole('button', { name: 'Connect Google Drive' }).click();
  await expect(page.getByText('Google Drive connected')).toBeVisible({ timeout: 20_000 });

  const b = await newBoard(cy, { name: 'Drive files' });
  const { bucketId } = await call(cy, 'bucketCreate', {
    name: 'Drive ticket files',
    storage: { kind: 'drive' },
  });
  await call(cy, 'bucketGrantSet', { bucketId, boardId: b.id, access: 'write' });
  await call(cy, 'boardAttachBucketSet', {
    boardId: b.id,
    attachBucket: { bucketId, template: 'tickets/<ticketId>/<filename>' },
  });
  const { key } = await call(cy, 'ticketCreate', { boardId: b.id, title: 'With a file' });

  await page.goto(`/t/${key}`);
  const reply = page.getByRole('group', { name: 'Reply' });
  const chooser = page.waitForEvent('filechooser');
  await reply.getByRole('button', { name: 'Attach files' }).click();
  await (
    await chooser
  ).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('in drive') });
  const dlg = page.getByRole('dialog', { name: 'Attach a file' });
  await expect(dlg.locator('select[data-attach-bucket]')).toHaveValue(bucketId);
  await page.keyboard.press('Enter');
  await expect(dlg).toBeHidden();
  await expect(reply.getByRole('list', { name: 'Attachments' })).toContainText('notes.txt');
  await reply.getByRole('button', { name: 'Send' }).click();

  const tree = await eventually(
    'the file is in Drive at its path',
    async () => {
      const t = await call(cy, 'bucketTree', { bucketId });
      return t.nodes.some((n) => n.path === `tickets/${key}/notes.txt`) ? t : null;
    },
    30_000,
  );
  expect(tree.nodes.map((n) => n.path)).toEqual([
    'tickets',
    `tickets/${key}`,
    `tickets/${key}/notes.txt`,
  ]);
  await expect(page.locator('[data-kind]').filter({ hasText: 'notes.txt' }).last()).toBeVisible();
  expect(storage).toEqual([]);
});
