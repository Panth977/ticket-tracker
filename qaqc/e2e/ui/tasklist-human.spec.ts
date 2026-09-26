/**
 * PHASE 5 END TO END (docs/plan/agents.html §N2): a TASK LIST MADE BY A PERSON.
 *
 * No agent, no token — the right pane of a ticket, in the browser:
 *
 *   Ada   + New list, a title and five pasted lines → five items
 *         clicks two of them through todo → doing → done
 *         marks one Skipped and one Failed (which asks for a note)
 *         moves an item up, then removes it
 *   board the card carries the 3/4 chip the pane shows (done + skipped of 4)
 *   Cara  a commenter sees the same list, read-only: no + New list, no
 *         status buttons, no menus (§N2: 'hide what a person may not do')
 */
import { expect, test, type Page } from '@playwright/test';
import { call, inviteAndAccept, newBoard, newPerson, stage } from '../support/stack.js';
import { signIn } from '../support/ui.js';

const PLAN = [
  'Read the spec',
  'Write the exporter',
  'Write the tests',
  'Update the docs',
  'Ship it',
];

async function shot(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

test('§N2: Ada builds a task list from a paste, works it, and a commenter sees it read-only', async ({
  page,
  browser,
}) => {
  const ada = await newPerson('Ada', 'Lovelace');
  const cara = await newPerson('Cara', 'Commenter');
  const b = await newBoard(ada, { name: 'Task lists' });
  await inviteAndAccept(ada, b.id, cara, 'commenter');
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Add CSV export',
    stageId: stage(b, 'In progress'),
  });

  await signIn(page, ada.email, `/t/${t.key}`);
  const pane = page.getByRole('complementary', { name: 'Details' });
  await expect(pane).toBeVisible();

  // ── 1. + New list: a title and a paste (§N2) ──────────────────────────────
  await pane.getByRole('button', { name: 'New list' }).click();
  const dialog = page.getByRole('dialog', { name: 'New task list' });
  await dialog.getByLabel('Title').fill('Plan: add CSV export');
  await dialog.getByLabel('Items').fill(PLAN.join('\n'));
  await expect(dialog).toContainText('5 items'); // each line became an item
  await dialog.getByRole('button', { name: 'Add list' }).click();
  await expect(dialog).toBeHidden();

  const list = pane.locator('[data-tasklist]').first();
  await expect(list).toContainText('Plan: add CSV export');
  await expect(list.locator('[data-progress]')).toHaveText('0 / 5');
  for (const title of PLAN)
    await expect(list.locator('[data-item]').filter({ hasText: title })).toHaveCount(1);
  // Adding a list is one of the two things a task list says in the thread (§L2).
  await expect(page.getByRole('region', { name: 'Thread' })).toContainText(
    'added a plan: Plan: add CSV export',
  );
  await shot(page, 'tasklist-new');

  const item = (title: string) => list.locator('[data-item]').filter({ hasText: title });

  // ── 2. ticking: todo → doing → done, by hand (§N2) ────────────────────────
  for (const title of ['Read the spec', 'Write the exporter']) {
    const row = item(title);
    await row.getByRole('button', { name: /change status$/ }).click();
    await expect(row).toHaveAttribute('data-item-status', 'doing');
    await row.getByRole('button', { name: /change status$/ }).click();
    await expect(row).toHaveAttribute('data-item-status', 'done');
  }
  await expect(list.locator('[data-progress]')).toHaveText('2 / 5');

  // ── 3. skipped and failed come from the menu; failed asks for a note ──────
  const docs = item('Update the docs');
  await docs.getByRole('button', { name: 'Actions for Update the docs' }).click();
  await page.getByRole('menuitem', { name: 'Skipped' }).click();
  await expect(docs).toHaveAttribute('data-item-status', 'skipped');

  const tests = item('Write the tests');
  await tests.getByRole('button', { name: 'Actions for Write the tests' }).click();
  await page.getByRole('menuitem', { name: 'Failed' }).click();
  const note = page.getByRole('dialog', { name: 'What went wrong?' });
  await note.getByLabel('Note').fill('The export timed out on 40k rows.');
  await note.getByRole('button', { name: 'Mark failed' }).click();
  await expect(tests).toHaveAttribute('data-item-status', 'failed');
  await expect(tests).toContainText('The export timed out on 40k rows.');
  // done + skipped is what is behind us; a failure is not (shared tasklistProgress).
  await expect(list.locator('[data-progress]')).toHaveText('3 / 5');
  await shot(page, 'tasklist-worked');

  // ── 4. reorder, then remove an item ───────────────────────────────────────
  const titles = () => list.locator('[data-item]').allInnerTexts();
  expect((await titles()).map((s) => s.split('\n')[0])).toEqual(PLAN);
  // §P1: the arrows left the row — 'Move up' lives in the ⋯ menu now.
  await item('Ship it').getByRole('button', { name: 'Actions for Ship it' }).click();
  await page.getByRole('menuitem', { name: 'Move up' }).click();
  await expect(async () => {
    expect((await titles())[3]).toContain('Ship it');
  }).toPass();

  await item('Ship it').getByRole('button', { name: 'Actions for Ship it' }).click();
  await page.getByRole('menuitem', { name: 'Remove item' }).click();
  await expect(item('Ship it')).toHaveCount(0);
  await expect(list.locator('[data-progress]')).toHaveText('3 / 4');

  // ── 5. the board card carries the same chip, unopened (§L2) ───────────────
  await page.goto(`/b/${b.key}`);
  const card = page.getByRole('button', { name: new RegExp(`^${t.key} `) }).first();
  await expect(card.locator('[data-tasks]')).toHaveAttribute('data-tasks', '3/4');
  await shot(page, 'tasklist-board-chip');

  // ── 6. a commenter reads it, and may change nothing (§N2) ─────────────────
  const ctx = await browser.newContext();
  const cp = await ctx.newPage();
  await signIn(cp, cara.email, `/t/${t.key}`);
  const readOnly = cp
    .getByRole('complementary', { name: 'Details' })
    .locator('[data-tasklist]')
    .first();
  await expect(readOnly).toContainText('Plan: add CSV export');
  await expect(readOnly.locator('[data-progress]')).toHaveText('3 / 4');
  await expect(readOnly).toContainText('The export timed out on 40k rows.');
  // Nothing to click: no status buttons, no per-item or per-list menus, no new list.
  await expect(readOnly.getByRole('button', { name: /change status$/ })).toHaveCount(0);
  await expect(readOnly.getByRole('button', { name: /^Actions for/ })).toHaveCount(0);
  await expect(readOnly.getByRole('button', { name: 'Add an item' })).toHaveCount(0);
  await expect(cp.getByRole('button', { name: 'New list' })).toHaveCount(0);
  // She can still answer a question and comment — read-only is about the list.
  await expect(cp.getByRole('group', { name: 'Reply' })).toBeVisible();
  await shot(cp, 'tasklist-read-only');
  await ctx.close();
});
