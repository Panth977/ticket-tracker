/**
 * PHASE 8 END TO END (docs/plan/agents.html §P) — THE BOARD CARD, and the
 * width a task list wastes.
 *
 *   §P2  a card with every fact set: the key, the unread count, ⚠, the
 *        priority / tag / due / estimate chips, the task-list progress, the
 *        attachment count and ⛔ — and none of them when the ticket has
 *        nothing to say (that card stays two lines).
 *        Opening the ticket clears the 💬 badge everywhere.
 *        The assignees are editable from the card itself; a viewer gets no
 *        picker at all.
 *   §P1  a task list at pane width: the item's text spans the pane, the
 *        controls are a toolbar on hover, and the note sits under the item.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  admin,
  call,
  eventually,
  inviteAndAccept,
  newBoard,
  newPerson,
  priority,
  stage,
  text,
} from '../support/stack.js';
import { signIn } from '../support/ui.js';

const DAY = 86_400_000;

async function shot(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

const card = (page: Page, key: string) =>
  page.getByRole('button', { name: new RegExp(`^${key} `) }).first();

test('§P2: a card carries every fact, clears its unread badge, and reassigns in place', async ({
  page,
  browser,
}) => {
  const ada = await newPerson('Ada', 'Lovelace');
  const grace = await newPerson('Grace', 'Hopper');
  const vera = await newPerson('Vera', 'Viewer');
  const b = await newBoard(ada, { name: 'Cards' });
  await inviteAndAccept(ada, b.id, grace, 'editor');
  await inviteAndAccept(ada, b.id, vera, 'viewer');

  // ── the loud ticket: everything a card can say ────────────────────────────
  const loud = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Fix the login redirect after SSO',
    stageId: stage(b, 'To do'),
  });
  const blocker = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Ship the SSO client',
    stageId: stage(b, 'To do'),
  });
  // ...and a quiet one, to prove a card with nothing to say draws nothing.
  const quiet = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Tidy the README',
    stageId: stage(b, 'To do'),
  });

  await call(ada, 'ticketUpdate', {
    boardId: b.id,
    ticketId: loud.ticketId,
    patch: {
      priorityId: priority(b, 'High'),
      dueAt: Date.now() - DAY, // overdue → the red chip
      dueAllDay: true,
      estimate: 3,
      assigneeUids: [grace.uid],
      links: [{ type: 'blockedBy', ticketId: blocker.ticketId }],
    },
  });
  await call(ada, 'tasklistSet', {
    boardId: b.id,
    ticketId: loud.ticketId,
    title: 'Plan',
    items: [
      { title: 'One', status: 'done' },
      { title: 'Two' },
      { title: 'Three' },
      { title: 'Four' },
    ],
  });
  // Two messages from Grace that Ada has never read.
  await call(grace, 'messagePost', {
    boardId: b.id,
    ticketId: loud.ticketId,
    body: text('Looking at it now'),
  });
  await call(grace, 'messagePost', {
    boardId: b.id,
    ticketId: loud.ticketId,
    body: text('It is the redirect_uri'),
  });

  await signIn(page, ada.email, `/b/${b.key}`);
  const c = card(page, loud.key);
  await expect(c).toBeVisible();

  // ── the top row: 💬 unread, from my read pointer ─────────────────────────
  // Grace's two comments, plus the system line the plan added — system lines
  // have no author, so they count for everyone, exactly as the thread's 'New
  // messages' divider counts them (§P2: the same source).
  await expect(c.locator('[data-unread]')).toHaveAttribute('data-unread', '3');
  // ── the meta row: every fact, and nothing empty ───────────────────────────
  await expect(c.locator('[data-fact=priority]')).toContainText('High');
  await expect(c.locator('[data-fact=due]')).toBeVisible();
  await expect(c.locator('[data-tasks]')).toHaveAttribute('data-tasks', '1/4');
  await expect(c.locator('[data-fact=blocked]')).toBeVisible();
  await shot(page, 'card-loud');

  // ── the quiet card says nothing it does not have ──────────────────────────
  const q = card(page, quiet.key);
  await expect(q).toContainText('Tidy the README');
  await expect(q.locator('[data-fact]')).toHaveCount(0);
  await expect(q.locator('[data-unread]')).toHaveCount(0);
  await expect(q).not.toContainText('No tags');

  // ── opening the ticket clears the badge everywhere (the same read pointer) ─
  await c.click();
  await expect(page.getByRole('complementary', { name: 'Details' })).toBeVisible();
  await expect(async () => {
    await expect(c.locator('[data-unread]')).toHaveCount(0);
  }).toPass();
  await page.goto(`/b/${b.key}`);
  await expect(card(page, loud.key).locator('[data-unread]')).toHaveCount(0);

  // ── assignees, editable in place: no ticket opened ────────────────────────
  // The menu is anchored with position:fixed and repositions on scroll, so the
  // scroll Playwright does to reach an option can move the option out from
  // under the pointer — the click then lands outside and only closes the menu.
  // Retry on what the outbox shows AT ONCE (the overlay puts Ada on the card
  // the moment the pick registers), never on the server's copy, so a slow
  // round trip can never make us pick her twice and take her off again.
  const picker = () =>
    card(page, loud.key).getByRole('button', { name: `Assignees on ${loud.key}` });
  const assignees = () => card(page, loud.key).locator('[data-assignees]');
  await expect(assignees()).toHaveAttribute('data-assignees', '1'); // Grace, so far
  await expect(async () => {
    const option = page.getByRole('option', { name: 'Ada Lovelace' });
    if (!(await option.isVisible().catch(() => false))) await picker().click();
    await option.click();
    await expect(assignees()).toHaveAttribute('data-assignees', '2', { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await eventually('Ada on the ticket', async () => {
    const t = await admin().db.doc(`boards/${b.id}/tickets/${loud.ticketId}`).get();
    return (t.get('assigneeUids') as string[]).includes(ada.uid) ? true : null;
  });
  // The drawer never opened — the picker's click does not reach the card.
  await expect(page.getByRole('complementary', { name: 'Details' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await shot(page, 'card-assignees');

  // ── a viewer sees who has it and is offered nothing ───────────────────────
  const ctx = await browser.newContext();
  const vp = await ctx.newPage();
  await signIn(vp, vera.email, `/b/${b.key}`);
  const vc = card(vp, loud.key);
  await expect(vc).toBeVisible();
  await expect(vc.getByRole('button', { name: `Assignees on ${loud.key}` })).toHaveCount(0);
  // ...and the quiet card, with nobody on it, offers a viewer no '+' either.
  await expect(card(vp, quiet.key).getByRole('button', { name: /^Assignees on/ })).toHaveCount(0);
  await shot(vp, 'card-viewer');
  await ctx.close();
});

test('§P1: a task list uses the width of the pane', async ({ page }) => {
  const ada = await newPerson('Ada', 'Lovelace');
  const b = await newBoard(ada, { name: 'Pane width' });
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Add CSV export',
    stageId: stage(b, 'In progress'),
  });
  const LONG =
    'Write the exporter so it streams rows instead of buffering the whole result set in memory';
  await call(ada, 'tasklistSet', {
    boardId: b.id,
    ticketId: t.ticketId,
    title: 'Plan: add CSV export',
    items: [
      { title: 'Read the spec', status: 'done' },
      { title: LONG },
      { title: 'Upload the report', status: 'failed', note: 'The export timed out on 40k rows.' },
    ],
  });

  await signIn(page, ada.email, `/t/${t.key}`);
  const pane = page.getByRole('complementary', { name: 'Details' });
  const list = pane.locator('[data-tasklist]').first();
  await expect(list).toContainText('Plan: add CSV export');

  // The item's text takes the pane, less only the status control on its left.
  const row = list.locator('[data-item]').filter({ hasText: 'streams rows' });
  const rowBox = (await row.boundingBox())!;
  const textBox = (await row.getByRole('button', { name: LONG, exact: true }).boundingBox())!;
  expect(textBox.width).toBeGreaterThan(rowBox.width - 40);

  // The controls are a toolbar over the right edge: not there until hovered.
  const toolbar = row.locator('[data-item-toolbar]');
  await expect(toolbar).toHaveCSS('opacity', '0');
  await row.hover();
  await expect(toolbar).toHaveCSS('opacity', '1');
  // ...and it sits at the row's right edge, over the text rather than beside it.
  const toolBox = (await toolbar.boundingBox())!;
  expect(toolBox.x + toolBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);

  // The note is under its item, full width — not squeezed into a column.
  const failed = list.locator('[data-item]').filter({ hasText: 'Upload the report' });
  const note = failed.locator('[data-item-note]');
  await expect(note).toContainText('The export timed out on 40k rows.');
  const noteBox = (await note.boundingBox())!;
  const failedBox = (await failed.boundingBox())!;
  expect(noteBox.width).toBeGreaterThan(failedBox.width / 2);

  // The bar spans the pane and the count sits at its end.
  const bar = list.locator('[role=progressbar]');
  const barBox = (await bar.boundingBox())!;
  const listBox = (await list.boundingBox())!;
  expect(barBox.width).toBeGreaterThan(listBox.width - 80);
  await expect(list.locator('[data-progress]')).toHaveText('1 / 3');
  const countBox = (await list.locator('[data-progress]').boundingBox())!;
  expect(countBox.x).toBeGreaterThan(barBox.x + barBox.width - 1);

  await shot(page, 'tasklist-pane-width');
});
