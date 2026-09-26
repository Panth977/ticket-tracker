/**
 * Phase 6: 'Cancel ticket' became 'Delete ticket'.
 *
 * A ticket is active or archived — there is no third, read-only 'cancelled'
 * state and neither close asks for a reason. The ⋯ menu offers Archive
 * (reversible) always, and Delete ticket only where the board allows
 * permanent deletion; deleting asks once ('Delete ENG-42? This cannot be
 * undone.'), the card goes at once, and the key stays tombstoned for good.
 */
import { expect, test, type Page } from '@playwright/test';
import { paths } from '@tm/shared';
import { call, eventually, newBoard, newPerson, read, stage } from '../support/stack.js';
import { signIn } from '../support/ui.js';

const card = (page: Page, key: string) =>
  page.getByRole('button', { name: new RegExp(`^${key} `) });
const menu = async (page: Page) => {
  await page.getByRole('button', { name: 'More actions' }).click();
  return page.getByRole('menu');
};

test('the ⋯ menu deletes for good: one confirm, no reason, the card goes at once', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada);
  // The per-board opt-in stays: without it the menu offers Archive alone.
  await call(ada, 'boardUpdate', { boardId: b.id, patch: { settings: { allowDelete: true } } });
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Delete me',
    stageId: stage(b, 'To do'),
  });

  await signIn(page, ada.email, `/b/${b.key}?ticket=${t.key}`);
  await expect(card(page, t.key)).toBeVisible();

  const m = await menu(page);
  await expect(m.getByRole('menuitem', { name: 'Archive' })).toBeVisible();
  await expect(m.getByRole('menuitem', { name: 'Delete ticket' })).toBeVisible();
  // The removed state is nowhere in the menu.
  await expect(m.getByRole('menuitem', { name: /cancel/i })).toHaveCount(0);

  await m.getByRole('menuitem', { name: 'Delete ticket' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`Delete ${t.key}? This cannot be undone.`);
  // One confirmation, and it asks for nothing else — no reason box.
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

  // Optimistic: the card is gone before the server answers, and the drawer closed.
  await expect(card(page, t.key)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/b/${b.key}(?!.*ticket=)`));

  // Server: the ticket is gone and the key is tombstoned, never reissued.
  await eventually(
    'the ticket doc to go',
    async () => (await read(paths.ticket(b.id, t.ticketId))) === undefined,
  );
  const key = await eventually('the key tombstone', async () => {
    const k = await read<{ deleted?: boolean }>(paths.key(t.key));
    return k?.deleted ? k : null;
  });
  expect(key.deleted).toBe(true);

  // '#KEY' still resolves — as deleted.
  await page.goto(`/t/${t.key}`);
  await expect(page.getByText(`${t.key} was deleted`)).toBeVisible();
});

test('archive asks once and asks for no reason; without allowDelete there is nothing to delete', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada); // allowDelete stays off
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Archive me',
    stageId: stage(b, 'To do'),
  });

  await signIn(page, ada.email, `/b/${b.key}?ticket=${t.key}`);
  const m = await menu(page);
  await expect(m.getByRole('menuitem', { name: 'Archive' })).toBeVisible();
  await expect(m.getByRole('menuitem', { name: 'Delete ticket' })).toHaveCount(0);

  await m.getByRole('menuitem', { name: 'Archive' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`Archive ${t.key}?`);
  await expect(dialog.getByRole('textbox')).toHaveCount(0); // the reason field is gone
  await dialog.getByRole('button', { name: 'Archive', exact: true }).click();

  // Archived: read-only, out of the default view, and an admin can restore it.
  await expect(card(page, t.key)).toHaveCount(0);
  await eventually('the archived state', async () => {
    const d = await read<{ state?: string }>(paths.ticket(b.id, t.ticketId));
    return d?.state === 'archived';
  });
});
