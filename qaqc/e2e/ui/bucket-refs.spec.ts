/**
 * BUCKET ON TICKETS AND IN ARTIFACTS, end to end (docs/plan/bucket.html §D, §E, §H).
 *
 *   §E  a bucket granted to a board: a file attached from it to a comment is a
 *       REFERENCE (no upload) — edit the file in the bucket and the ticket
 *       shows the new version; take the grant away and it says it is gone
 *   §H  an artifact granted a bucket reads it through BackendDriver.bucket —
 *       as the viewer, and never past the grant ('read' does not write)
 */
import { expect, test } from '@playwright/test';
import {
  call,
  eventually,
  inviteAndAccept,
  messagesOf,
  newBoard,
  newPerson,
  read,
  WEB_URL,
} from '../support/stack.js';
import { signIn, subscribe } from '../support/ui.js';

test('§E: attach a bucket file to a comment; it follows edits, and goes when the grant does', async ({
  page,
  browser,
}) => {
  const ada = await newPerson('Ada');
  const grace = await newPerson('Grace');
  const eng = await newBoard(ada, { name: 'Engineering' });
  await inviteAndAccept(ada, eng.id, grace, 'commenter');
  const { ticketId, key } = await call(ada, 'ticketCreate', { boardId: eng.id, title: 'Logo' });
  const { bucketId } = await call(ada, 'bucketCreate', { name: 'Brand kit' });
  await call(ada, 'bucketFileWrite', {
    bucketId,
    path: 'notes/brief.md',
    text: '# Brief v1\n\nFirst.',
  });
  await call(ada, 'bucketGrantSet', { bucketId, boardId: eng.id, access: 'read' });

  await signIn(page, ada.email, `/t/${key}`);
  const reply = page.getByRole('group', { name: 'Reply' });
  await reply.getByRole('button', { name: 'Attach from bucket' }).click();
  const picker = page.getByRole('dialog', { name: 'Attach from bucket' });
  // The only bucket granted to the board opens by itself.
  await picker.getByRole('button', { name: 'notes' }).click();
  await picker.locator('[data-bucket-file="notes/brief.md"]').getByRole('checkbox').check();
  await picker.getByRole('button', { name: 'Attach 1' }).click();
  await expect(picker).toBeHidden();
  await expect(reply.locator('[data-bucket-pick="brief.md"]')).toBeVisible();
  await reply.getByRole('button', { name: 'Send' }).click();

  // Stored as a reference: the virtual path, nothing uploaded under the ticket.
  const msg = await eventually('the message with its bucket file', async () =>
    (await messagesOf(eng.id, ticketId)).find((m) => m.attachments?.length),
  );
  expect(msg.attachments[0]).toMatchObject({
    name: 'brief.md',
    bucket: { bucketId },
    path: expect.stringMatching(new RegExp(`^buckets/${bucketId}/nodes/`)),
  });
  const ticket = await read<{ files: { source: string }[] }>(
    `boards/${eng.id}/tickets/${ticketId}`,
  );
  expect(ticket!.files.map((f) => f.source)).toEqual(['bucket']);

  const card = page.locator('[data-kind]').filter({ hasText: 'brief.md' }).last();
  await expect(card.locator('[data-bucket-badge]')).toBeVisible();
  await expect(card).toContainText('Brief v1');

  // Edited in the bucket → the ticket shows the new version.
  await call(ada, 'bucketFileWrite', {
    bucketId,
    path: 'notes/brief.md',
    text: '# Brief v2\n\nSecond.',
  });
  await page.reload();
  await expect(card).toContainText('Brief v2');

  // Grace is only on the board: she sees the file through the grant…
  const ctx = await browser.newContext();
  const page2 = await ctx.newPage();
  await signIn(page2, grace.email, `/t/${key}`);
  const card2 = page2.locator('[data-kind]').filter({ hasText: 'brief.md' }).last();
  await expect(card2).toContainText('Brief v2');
  // …and when the grant goes, the reference says so. Ada owns the bucket, so
  // she still reaches it directly (§E): the same card keeps working for her.
  await call(ada, 'bucketGrantSet', { bucketId, boardId: eng.id, access: null });
  await page2.reload();
  await expect(card2.locator('[data-bucket-gone]')).toHaveText('No longer in memory');
  await page.reload();
  await expect(card).toContainText('Brief v2');
  await ctx.close();
});

const INDEX = `<!doctype html>
<meta charset="utf-8">
<title>Bucket reader</title>
<p>buckets: <b id="list">?</b></p>
<p>text: <b id="text">?</b></p>
<p>write: <b id="write">?</b></p>
<script src="${WEB_URL}/backend-driver/v1/driver.js"></script>
<script>
(async () => {
  const $ = (id) => document.getElementById(id);
  const db = window.BackendDriver;
  await db.ready;
  const list = await db.bucket.list();
  $('list').textContent = list.map((m) => m.name + ':' + m.access).join(',') || 'none';
  if (!list[0]) return;
  $('text').textContent = (await db.bucket.read(list[0].id, 'docs/hello.md')).trim();
  try { await db.bucket.write(list[0].id, 'docs/x.md', 'x'); $('write').textContent = 'OK'; }
  catch (e) { $('write').textContent = e.code; }
})();
</script>`;

test('§H: an artifact reads a granted bucket through BackendDriver.bucket, never past the grant', async ({
  page,
}) => {
  const owner = await newPerson('Olive');
  const { bucketId } = await call(owner, 'bucketCreate', { name: 'Notes' });
  await call(owner, 'bucketFileWrite', {
    bucketId,
    path: 'docs/hello.md',
    text: 'Hello from bucket',
  });
  const { artifactId } = await call(owner, 'artifactCreate', { name: 'Reader' });
  await call(owner, 'artifactPublish', {
    artifactId,
    message: 'v1',
    files: [{ path: 'index.html', content: INDEX }],
  });

  // Not granted: the page sees no bucket at all.
  await signIn(page, owner.email, `/x/${artifactId}`);
  const f = page.frameLocator('iframe[sandbox]');
  await expect(f.locator('#list')).toHaveText('none');

  // Granted read: the owner could write here, the page may not.
  await call(owner, 'bucketGrantSet', { bucketId, artifactId, access: 'read' });
  await page.reload();
  await expect(f.locator('#list')).toHaveText('Notes:read');
  await expect(f.locator('#text')).toHaveText('Hello from bucket');
  await expect(f.locator('#write')).toHaveText('permission-denied');

  // Granted write: now it may.
  await call(owner, 'bucketGrantSet', { bucketId, artifactId, access: 'write' });
  await page.reload();
  await expect(f.locator('#list')).toHaveText('Notes:write');
  await expect(f.locator('#write')).toHaveText('OK');
  await eventually('the page wrote the file', async () => {
    const r = await call(owner, 'bucketFileRead', { bucketId, path: 'docs/x.md', asText: true });
    return r.text === 'x' ? true : null;
  });
});

test('Settings › Subscriptions: an admin adds a bucket they own to the board', async ({ page }) => {
  const ada = await newPerson('Ada');
  const eng = await newBoard(ada, { name: 'Engineering' });
  const { bucketId } = await call(ada, 'bucketCreate', { name: 'Brand kit' });
  await signIn(page, ada.email, `/b/${eng.key}/settings/subscriptions`);
  await subscribe(page, 'board', `bucket:${bucketId}`, ['read', 'write']);
  const row = page.locator(`[data-subscription="bucket:${bucketId}"]`);
  await expect(row).toContainText('Brand kit');
  await expect(row.locator('[data-chips]')).toHaveText(/Read\s*Write/);
  await eventually('the grant is stored', async () => {
    const m = await read<{ boards: Record<string, string> }>(`buckets/${bucketId}`);
    return m?.boards[eng.id] === 'write' ? true : null;
  });
});
