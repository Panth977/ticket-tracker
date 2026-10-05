/**
 * MEMORY ON TICKETS AND IN ARTIFACTS, end to end (docs/plan/memory.html §D, §E, §H).
 *
 *   §E  a memory granted to a board: a file attached from it to a comment is a
 *       REFERENCE (no upload) — edit the file in the memory and the ticket
 *       shows the new version; take the grant away and it says it is gone
 *   §H  an artifact granted a memory reads it through BackendDriver.memory —
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
import { signIn } from '../support/ui.js';

test('§E: attach a memory file to a comment; it follows edits, and goes when the grant does', async ({
  page,
  browser,
}) => {
  const ada = await newPerson('Ada');
  const grace = await newPerson('Grace');
  const eng = await newBoard(ada, { name: 'Engineering' });
  await inviteAndAccept(ada, eng.id, grace, 'commenter');
  const { ticketId, key } = await call(ada, 'ticketCreate', { boardId: eng.id, title: 'Logo' });
  const { memoryId } = await call(ada, 'memoryCreate', { name: 'Brand kit' });
  await call(ada, 'memoryFileWrite', {
    memoryId,
    path: 'notes/brief.md',
    text: '# Brief v1\n\nFirst.',
  });
  await call(ada, 'memoryGrantSet', { memoryId, boardId: eng.id, access: 'read' });

  await signIn(page, ada.email, `/t/${key}`);
  const reply = page.getByRole('group', { name: 'Reply' });
  await reply.getByRole('button', { name: 'Attach from memory' }).click();
  const picker = page.getByRole('dialog', { name: 'Attach from memory' });
  // The only memory granted to the board opens by itself.
  await picker.getByRole('button', { name: 'notes' }).click();
  await picker.locator('[data-memory-file="notes/brief.md"]').getByRole('checkbox').check();
  await picker.getByRole('button', { name: 'Attach 1' }).click();
  await expect(picker).toBeHidden();
  await expect(reply.locator('[data-memory-pick="brief.md"]')).toBeVisible();
  await reply.getByRole('button', { name: 'Send' }).click();

  // Stored as a reference: the virtual path, nothing uploaded under the ticket.
  const msg = await eventually('the message with its memory file', async () =>
    (await messagesOf(eng.id, ticketId)).find((m) => m.attachments?.length),
  );
  expect(msg.attachments[0]).toMatchObject({
    name: 'brief.md',
    memory: { memoryId },
    path: expect.stringMatching(new RegExp(`^memories/${memoryId}/nodes/`)),
  });
  const ticket = await read<{ files: { source: string }[] }>(
    `boards/${eng.id}/tickets/${ticketId}`,
  );
  expect(ticket!.files.map((f) => f.source)).toEqual(['memory']);

  const card = page.locator('[data-kind]').filter({ hasText: 'brief.md' }).last();
  await expect(card.locator('[data-memory-badge]')).toBeVisible();
  await expect(card).toContainText('Brief v1');

  // Edited in the memory → the ticket shows the new version.
  await call(ada, 'memoryFileWrite', {
    memoryId,
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
  // …and when the grant goes, the reference says so. Ada owns the memory, so
  // she still reaches it directly (§E): the same card keeps working for her.
  await call(ada, 'memoryGrantSet', { memoryId, boardId: eng.id, access: null });
  await page2.reload();
  await expect(card2.locator('[data-memory-gone]')).toHaveText('No longer in memory');
  await page.reload();
  await expect(card).toContainText('Brief v2');
  await ctx.close();
});

const INDEX = `<!doctype html>
<meta charset="utf-8">
<title>Memory reader</title>
<p>memories: <b id="list">?</b></p>
<p>text: <b id="text">?</b></p>
<p>write: <b id="write">?</b></p>
<script src="${WEB_URL}/backend-driver/v1/driver.js"></script>
<script>
(async () => {
  const $ = (id) => document.getElementById(id);
  const db = window.BackendDriver;
  await db.ready;
  const list = await db.memory.list();
  $('list').textContent = list.map((m) => m.name + ':' + m.access).join(',') || 'none';
  if (!list[0]) return;
  $('text').textContent = (await db.memory.read(list[0].id, 'docs/hello.md')).trim();
  try { await db.memory.write(list[0].id, 'docs/x.md', 'x'); $('write').textContent = 'OK'; }
  catch (e) { $('write').textContent = e.code; }
})();
</script>`;

test('§H: an artifact reads a granted memory through BackendDriver.memory, never past the grant', async ({
  page,
}) => {
  const owner = await newPerson('Olive');
  const { memoryId } = await call(owner, 'memoryCreate', { name: 'Notes' });
  await call(owner, 'memoryFileWrite', {
    memoryId,
    path: 'docs/hello.md',
    text: 'Hello from memory',
  });
  const { artifactId } = await call(owner, 'artifactCreate', { name: 'Reader' });
  await call(owner, 'artifactPublish', {
    artifactId,
    message: 'v1',
    files: [{ path: 'index.html', content: INDEX }],
  });

  // Not granted: the page sees no memory at all.
  await signIn(page, owner.email, `/x/${artifactId}`);
  const f = page.frameLocator('iframe[sandbox]');
  await expect(f.locator('#list')).toHaveText('none');

  // Granted read: the owner could write here, the page may not.
  await call(owner, 'memoryGrantSet', { memoryId, artifactId, access: 'read' });
  await page.reload();
  await expect(f.locator('#list')).toHaveText('Notes:read');
  await expect(f.locator('#text')).toHaveText('Hello from memory');
  await expect(f.locator('#write')).toHaveText('permission-denied');

  // Granted write: now it may.
  await call(owner, 'memoryGrantSet', { memoryId, artifactId, access: 'write' });
  await page.reload();
  await expect(f.locator('#list')).toHaveText('Notes:write');
  await expect(f.locator('#write')).toHaveText('OK');
  await eventually('the page wrote the file', async () => {
    const r = await call(owner, 'memoryFileRead', { memoryId, path: 'docs/x.md', asText: true });
    return r.text === 'x' ? true : null;
  });
});

test('Settings › Memory: an admin grants a board a memory they own', async ({ page }) => {
  const ada = await newPerson('Ada');
  const eng = await newBoard(ada, { name: 'Engineering' });
  const { memoryId } = await call(ada, 'memoryCreate', { name: 'Brand kit' });
  await signIn(page, ada.email, `/b/${eng.key}/settings/memory`);
  const row = page.locator(`[data-memory-grant="${memoryId}"]`);
  await expect(row).toContainText('Brand kit');
  await row.getByRole('button', { name: 'Read & write' }).click();
  await expect(row.getByRole('button', { name: 'Read & write' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await eventually('the grant is stored', async () => {
    const m = await read<{ boards: Record<string, string> }>(`memories/${memoryId}`);
    return m?.boards[eng.id] === 'write' ? true : null;
  });
});
