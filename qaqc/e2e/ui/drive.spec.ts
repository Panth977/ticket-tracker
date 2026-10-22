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
  await page.getByRole('link', { name: 'New bucket' }).first().click();
  let dialog = page.getByRole('main');
  await dialog.getByTestId('storage-drive').click();
  await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Connect Google Drive' }).click();
  // Google (faked) → /integrations/drive/callback → back here.
  await expect(page.getByText('Google Drive connected')).toBeVisible({ timeout: 20_000 });
  expect(new URL(page.url()).searchParams.get('drive')).toBeNull();
  expect((await call(ada, 'driveStatus', {})).connected).toBe(true);

  // ── D2: the bucket — back on the same New bucket page, now connected ─────
  await expect(page).toHaveURL(/\/new-bucket/);
  dialog = page.getByRole('main');
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
  await expect(page.getByTestId('board-storage').getByTestId('storage-managed')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByTestId('files-storage').getByTestId('storage-managed')).toHaveAttribute(
    'aria-checked',
    'true',
  );
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

test('D5: a managed bucket moves to Drive from its own Storage tab, not from the board', async ({
  page,
}) => {
  const di = await newPerson('Di');
  await signIn(page, di.email, '/account/drive');
  await page.getByRole('button', { name: 'Connect Google Drive' }).click();
  await expect(page.getByText('Google Drive connected')).toBeVisible({ timeout: 20_000 });

  const b = await newBoard(di, { name: 'Move board' });
  const { bucketId } = await call(di, 'bucketCreate', { name: 'Move me' });
  await call(di, 'bucketGrantSet', { bucketId, boardId: b.id, access: 'write' });
  await call(di, 'bucketFileWrite', { bucketId, path: 'docs/a.md', text: '# A' });

  await page.goto(`/bucket/${bucketId}/settings/storage`);
  const tab = page.getByTestId('storage-move');
  await expect(tab).toContainText('are kept by this app');
  await tab.getByTestId('storage-drive').click();
  await tab.getByTestId('storage-move-start').click();
  await page.getByTestId('storage-move-confirm').click();

  await eventually(
    'the bucket switched to Drive',
    async () => {
      const d = (await admin().db.doc(`buckets/${bucketId}`).get()).data()!;
      return d.storage?.kind === 'drive' && !d.move;
    },
    60_000,
  );
  await expect(tab).toContainText('are in Google Drive', { timeout: 20_000 });
  const tree = await call(di, 'bucketTree', { bucketId });
  expect(tree.nodes.map((n) => n.path)).toEqual(['docs', 'docs/a.md']);

  // The board's Storage tab is about the board alone: no bucket on it.
  await page.goto(`/b/${b.key}/settings/storage`);
  await expect(page.getByTestId('entity-storage')).toContainText('This board is kept by this app');
  await expect(page.getByTestId('storage-move')).toHaveCount(0);
});

test('D6: a board whose tickets live in Drive — create, open, reply, live (bucket.html §L)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const ed = await newPerson('Ed');
  await signIn(page, ed.email, '/account/drive');
  await page.getByRole('button', { name: 'Connect Google Drive' }).click();
  await expect(page.getByText('Google Drive connected')).toBeVisible({ timeout: 20_000 });

  // The new-board page asks twice, one entity each: the board in Drive, its
  // ticket-file bucket kept by the app (the default).
  await page.goto('/new-board');
  const key = `DV${Date.now().toString(36).slice(-3).toUpperCase()}`;
  await page.getByLabel('Name').fill('Drive tickets');
  await page.getByLabel('Key').fill(key);
  await page.getByTestId('board-storage').getByTestId('storage-drive').click();
  await page.getByRole('button', { name: 'Create board' }).click();
  await page.waitForURL(/\/b\//, { timeout: 20_000 });

  const boards = await admin().db.collection('boards').where('key', '==', key).get();
  const board = boards.docs[0]!;
  expect(board.get('storage')).toMatchObject({ kind: 'drive', folderName: 'Drive tickets' });
  const attach = board.get('attachBucket') as { bucketId: string } | null;
  const bucket = (await admin().db.doc(`buckets/${attach!.bucketId}`).get()).data()!;
  expect(bucket.storage).toBeUndefined();

  // A ticket made through the API shows on the board (read from Drive via the api).
  const { ticketId, key: tkey } = await call(ed, 'ticketCreate', {
    boardId: board.id,
    title: 'Lives in Drive',
  });
  // The ping (driveRev) usually brings it within a second; the minute's poll is the backstop.
  await expect(page.getByText('Lives in Drive').first()).toBeVisible({ timeout: 70_000 });
  // …and is not in Firestore at all.
  expect((await admin().db.doc(`boards/${board.id}/tickets/${ticketId}`).get()).exists).toBe(false);

  // Open it, reply from the composer.
  await page.goto(`/t/${tkey}`);
  const thread = page.getByRole('region', { name: 'Thread' });
  const reply = page.getByRole('group', { name: 'Reply' });
  await reply.getByRole('textbox').first().fill('Written to a file in Drive');
  await reply.getByRole('button', { name: 'Send' }).click();
  await expect(thread.getByText('Written to a file in Drive')).toBeVisible({ timeout: 30_000 });
  await eventually(
    'the reply is a message file in Drive',
    async () => {
      const t = await call(ed, 'driveDocs', {
        target: { kind: 'doc', path: `boards/${board.id}/tickets/${ticketId}` },
      });
      const msgs = (t.docs[0]?.data.recentMessages ?? []) as { body: { text: string } }[];
      return msgs.some((m) => m.body.text === 'Written to a file in Drive');
    },
    30_000,
  );
  await expect(page.getByText('unsent')).toBeHidden({ timeout: 20_000 });

  // Live: a message posted elsewhere arrives without a reload (the driveRev ping).
  await call(ed, 'messagePost', {
    boardId: board.id,
    ticketId,
    clientId: `c${Date.now().toString(36)}`,
    body: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From the API' }] }],
    },
  });
  await expect(thread.getByText('From the API')).toBeVisible({ timeout: 70_000 });

  // Settings › Storage says where the tickets are.
  await page.goto(`/b/${key}/settings/storage`);
  await expect(page.getByTestId('entity-storage')).toContainText(
    'This board lives in Google Drive',
  );
});

test('D7: a board moves its tickets to Drive from Settings › Storage, and they still open', async ({
  page,
}) => {
  const fy = await newPerson('Fy');
  await signIn(page, fy.email, '/account/drive');
  await page.getByRole('button', { name: 'Connect Google Drive' }).click();
  await expect(page.getByText('Google Drive connected')).toBeVisible({ timeout: 20_000 });

  const b = await newBoard(fy, { name: 'Moving tickets' });
  const { key: tkey, ticketId } = await call(fy, 'ticketCreate', {
    boardId: b.id,
    title: 'Comes along',
  });

  await page.goto(`/b/${b.key}/settings/storage`);
  const tab = page.getByTestId('entity-storage');
  await expect(tab).toContainText('This board is kept by this app');
  await tab.getByTestId('storage-drive').click();
  await tab.getByTestId('entity-storage-start').click();
  await page.getByTestId('entity-storage-confirm').click();

  await eventually(
    'the board switched to Drive',
    async () => {
      const d = (await admin().db.doc(`boards/${b.id}`).get()).data()!;
      return d.storage?.kind === 'drive' && !d.move;
    },
    60_000,
  );
  await expect(tab).toContainText('This board lives in Google Drive', { timeout: 20_000 });
  // The database's copy goes right after the switch.
  await eventually(
    "the database's copy is gone",
    async () => !(await admin().db.doc(`boards/${b.id}/tickets/${ticketId}`).get()).exists,
    30_000,
  );

  await page.goto(`/t/${tkey}`);
  // Read from Drive now: the ticket and its activity open as before.
  await expect(page.getByText('created this ticket')).toBeVisible({ timeout: 30_000 });
});

test('D8: a dictionary kept in Drive — made from its create page, entries sealed there, read back', async ({
  page,
}) => {
  const gi = await newPerson('Gi');
  await signIn(page, gi.email, '/account/drive');
  await page.getByRole('button', { name: 'Connect Google Drive' }).click();
  await expect(page.getByText('Google Drive connected')).toBeVisible({ timeout: 20_000 });
  // The recovery code: made and shown once, here.
  await page.getByRole('button', { name: 'Make my recovery code' }).click();
  await expect(page.getByTestId('drive-recovery-code')).toHaveText(
    /^[0-9A-Z]{4}(-[0-9A-Z]{1,4})+$/,
  );

  await page.goto('/new-dictionary');
  const main = page.getByRole('main');
  await main.getByLabel('Name').fill('Drive secrets');
  await main.getByTestId('storage-drive').click();
  await main.getByRole('button', { name: 'Create' }).click();
  const dictionaryId = await thingIdAt(page, gi, 'dictionary');
  const d = (await admin().db.doc(`dictionaries/${dictionaryId}`).get()).data()!;
  expect(d.storage).toMatchObject({ kind: 'drive', folderName: 'Drive secrets' });

  // An entry saved through the API is sealed in Drive, not in Firestore — and the page shows it.
  await call(gi, 'dictionarySet', { dictionaryId, set: { TOKEN: 'abc' } });
  expect((await admin().db.doc(`dictionaries/${dictionaryId}/content/entries`).get()).exists).toBe(
    false,
  );
  await page.reload();
  await expect(page.locator('[data-entry-row="0"]').getByLabel('Key')).toHaveValue('TOKEN', {
    timeout: 30_000,
  });

  await page.goto(`/dictionary/${dictionaryId}/settings/storage`);
  await expect(page.getByTestId('entity-storage')).toContainText(
    'This dictionary lives in Google Drive',
  );
});

test('D9: an open preview in a Drive bucket survives the bucket’s poll (no reload)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const hu = await newPerson('Hu');
  await signIn(page, hu.email, '/account/drive');
  await page.getByRole('button', { name: 'Connect Google Drive' }).click();
  await expect(page.getByText('Google Drive connected')).toBeVisible({ timeout: 20_000 });
  const { bucketId } = await call(hu, 'bucketCreate', {
    name: 'Previews',
    storage: { kind: 'drive' },
  });
  await call(hu, 'bucketFileWrite', {
    bucketId,
    path: 'page.html',
    text: '<!doctype html><h1>Long page</h1>' + '<p>row</p>'.repeat(400),
  });

  await page.goto(`/bucket/${bucketId}`);
  await page.getByRole('button', { name: 'Tree' }).click();
  await nodeEl(page, 'page.html').click();
  const frame = page.locator('main iframe').first();
  await expect(frame).toBeVisible({ timeout: 20_000 });
  // Mark the frame element: a reload would replace it (and lose the mark).
  await frame.evaluate((el) => el.setAttribute('data-mark', 'kept'));
  // The Drive bucket's tree polls every 20 s, with new objects for the same files.
  await page.waitForTimeout(25_000);
  await expect(page.locator('main iframe[data-mark="kept"]')).toHaveCount(1);
});
