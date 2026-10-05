/**
 * TICKET ATTACHMENTS LIVE IN A MEMORY, end to end (docs/plan/memory.html §J).
 *
 *   · an admin grants a memory `write` to a board and, in Settings › Memory ›
 *     Ticket attachments, makes it the default with a path template
 *   · a COMMENTER adds a file in a ticket thread → the attach dialog starts on
 *     that memory with the path filled in and the file's name selected; typing
 *     renames it; Send uploads it INTO the memory and the message points at it
 *   · a board with no memory to write to says so (and admins get a way there)
 */
import { expect, test, type Page } from '@playwright/test';
import {
  admin,
  call,
  eventually,
  inviteAndAccept,
  messagesOf,
  newBoard,
  newPerson,
  read,
} from '../support/stack.js';
import { signIn } from '../support/ui.js';

async function nodeByPath(memoryId: string, path: string) {
  const q = await admin()
    .db.collection(`memories/${memoryId}/nodes`)
    .where('path', '==', path)
    .get();
  return q.docs[0]?.data() ?? null;
}

async function memoryFiles(memoryId: string): Promise<string[]> {
  const q = await admin().db.collection(`memories/${memoryId}/nodes`).get();
  return q.docs
    .map((d) => d.data() as { path: string; kind: string })
    .flatMap((n) => (n.kind === 'file' ? [n.path] : []));
}

/** Pick a file with the composer's 📎. */
async function attachWithClip(page: Page, name: string, text: string) {
  const reply = page.getByRole('group', { name: 'Reply' });
  const chooser = page.waitForEvent('filechooser');
  await reply.getByRole('button', { name: 'Attach files' }).click();
  await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
}

test('§J: the board default memory + template; a commenter attaches into it', async ({
  page,
  browser,
}) => {
  const ada = await newPerson('Ada');
  const grace = await newPerson('Grace');
  const eng = await newBoard(ada, { name: 'Engineering' });
  await inviteAndAccept(ada, eng.id, grace, 'commenter');
  const { ticketId, key } = await call(ada, 'ticketCreate', { boardId: eng.id, title: 'Notes' });
  const { memoryId } = await call(ada, 'memoryCreate', { name: 'Ticket files' });

  // ── the admin: grant write, then make it the attachment default ──────────
  await signIn(page, ada.email, `/b/${eng.key}/settings/memory`);
  const row = page.locator(`[data-memory-grant="${memoryId}"]`);
  await row.getByRole('button', { name: 'Read & write' }).click();
  await expect(row.getByRole('button', { name: 'Read & write' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const box = page.locator('[data-attach-settings]');
  const select = box.locator('select[data-attach-memory-select]');
  await expect(select).toHaveValue(memoryId);
  // Build the template with the chips (they insert at the cursor).
  const template = box.getByLabel('Path');
  await template.fill('tickets/');
  await box.locator('[data-attach-var="ticketId"]').click();
  await template.press('End');
  await template.pressSequentially('/');
  await box.locator('[data-attach-var="time"]').click();
  await template.press('End');
  await template.pressSequentially('_');
  await box.locator('[data-attach-var="filename"]').click();
  await expect(template).toHaveValue('tickets/<ticketId>/<time>_<filename>');
  await expect(box.locator('[data-attach-example]')).toContainText(
    new RegExp(`/tickets/${eng.key}-42/\\d{8}-\\d{6}_photo\\.png`),
  );
  // A bad variable is refused live.
  await template.fill('tickets/<nope>');
  await expect(box.getByRole('button', { name: 'Save' })).toBeDisabled();
  await template.fill('tickets/<ticketId>/<time>_<filename>');
  await box.getByRole('button', { name: 'Save' }).click();
  await eventually('the board default is stored', async () => {
    const b = await read<{ attachMemory?: { memoryId: string; template: string } | null }>(
      `boards/${eng.id}`,
    );
    return b?.attachMemory?.memoryId === memoryId &&
      b.attachMemory.template === 'tickets/<ticketId>/<time>_<filename>'
      ? true
      : null;
  });
  await expect(row.locator('[data-attach-badge]')).toHaveText('Attachments');

  // ── the commenter attaches a file in the thread ─────────────────────────
  const ctx = await browser.newContext();
  const gp = await ctx.newPage();
  await signIn(gp, grace.email, `/t/${key}`);
  await attachWithClip(gp, 'notes.txt', 'meeting notes');
  const dlg = gp.getByRole('dialog', { name: 'Attach a file' });
  await expect(dlg.locator('select[data-attach-memory]')).toHaveValue(memoryId);
  const path = dlg.getByLabel('Path for notes.txt');
  await expect(path).toHaveValue(new RegExp(`^/tickets/${key}/\\d{8}-\\d{6}_notes\\.txt$`));
  await expect(path).toBeFocused();
  // The file's own name is selected: typing replaces it.
  const selected = await path.evaluate((el) => {
    const i = el as unknown as { value: string; selectionStart: number; selectionEnd: number };
    return i.value.slice(i.selectionStart, i.selectionEnd);
  });
  expect(selected).toBe('notes.txt');
  await gp.keyboard.type('meeting-notes.txt');
  const typed = await path.inputValue();
  expect(typed).toMatch(new RegExp(`^/tickets/${key}/\\d{8}-\\d{6}_meeting-notes\\.txt$`));
  await gp.keyboard.press('Enter');
  await expect(dlg).toBeHidden();
  const reply = gp.getByRole('group', { name: 'Reply' });
  await expect(reply.getByRole('list', { name: 'Attachments' })).toContainText('meeting-notes.txt');
  await reply.getByRole('button', { name: 'Send' }).click();

  // In the memory at that path, and on the message as a memory file.
  const memPath = typed.slice(1);
  await eventually('the file is in the memory', () => nodeByPath(memoryId, memPath), 30_000);
  const msg = await eventually('the message with its file', async () =>
    (await messagesOf(eng.id, ticketId)).find((m) => m.attachments?.length),
  );
  // The ticket shows the name as typed; the memory keeps the templated one.
  expect(msg.attachments[0]).toMatchObject({ name: 'meeting-notes.txt', memory: { memoryId } });
  await expect(
    gp.locator('[data-kind]').filter({ hasText: 'meeting-notes.txt' }).last(),
  ).toBeVisible();
  // Nothing went under the board.
  expect(await memoryFiles(memoryId)).toEqual([memPath]);
  await ctx.close();
});

test('§J: a board with no memory to write to says so', async ({ page, browser }) => {
  const ada = await newPerson('Ada');
  const grace = await newPerson('Grace');
  const eng = await newBoard(ada, { name: 'Engineering' });
  await inviteAndAccept(ada, eng.id, grace, 'commenter');
  const { key } = await call(ada, 'ticketCreate', { boardId: eng.id, title: 'Nowhere' });
  // Granted READ only: still nowhere to put files.
  const { memoryId } = await call(ada, 'memoryCreate', { name: 'Read only' });
  await call(ada, 'memoryGrantSet', { memoryId, boardId: eng.id, access: 'read' });

  // An admin is pointed at Settings › Memory.
  await signIn(page, ada.email, `/t/${key}`);
  await attachWithClip(page, 'a.txt', 'a');
  const dlg = page.getByRole('dialog', { name: 'Attach a file' });
  await expect(dlg.locator('[data-attach-none]')).toContainText('no memory is shared');
  await dlg.locator('[data-attach-settings]').click();
  await page.waitForURL(new RegExp(`/b/${eng.key}/settings/memory$`));
  await expect(page.locator('[data-attach-empty]')).toContainText(
    'Grant a memory Read & write access above',
  );

  // Anyone else is told to ask an admin.
  const ctx = await browser.newContext();
  const gp = await ctx.newPage();
  await signIn(gp, grace.email, `/t/${key}`);
  await attachWithClip(gp, 'b.txt', 'b');
  const gd = gp.getByRole('dialog', { name: 'Attach a file' });
  await expect(gd.locator('[data-attach-none]')).toContainText('Ask a board admin');
  await expect(gd.locator('[data-attach-settings]')).toHaveCount(0);
  await ctx.close();
});
