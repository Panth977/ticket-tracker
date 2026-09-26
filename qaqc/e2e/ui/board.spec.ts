/**
 * Flows: "Creating a ticket" and "Moving a card" (app/flows.json) on the
 * kanban, through the browser.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  admin,
  call,
  eventually,
  inviteAndAccept,
  newBoard,
  newPerson,
  priority,
  read,
  stage,
} from '../support/stack.js';
import { signIn } from '../support/ui.js';

const column = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
/** Ticket keys of the cards in a column, top to bottom (from their aria-labels). */
const keysIn = (col: Locator) =>
  col
    .locator('[role=button][aria-label]')
    .evaluateAll((els) =>
      els
        .map((e) => e.getAttribute('aria-label')!.split(' ')[0]!)
        .filter((k) => /^[A-Z][A-Z0-9]*-\d+$/.test(k)),
    );
const card = (scope: Page | Locator, key: string) =>
  scope.getByRole('button', { name: new RegExp(`^${key} `) });

test('quick add: tokens become assignee + priority; the card appears and is the real ticket', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const grace = await newPerson('Grace', 'Hopper');
  const b = await newBoard(ada);
  await inviteAndAccept(ada, b.id, grace, 'editor');

  await signIn(page, ada.email, `/b/${b.key}`);
  await expect(column(page, 'To do')).toBeVisible();
  await column(page, 'To do').getByRole('button', { name: 'New' }).click();

  const input = page.getByRole('textbox', { name: 'Ticket title with tokens' });
  await input.fill('Fix login redirect !high @grace');
  // the @ token offers people on this board
  await expect(page.getByRole('option', { name: /Grace Hopper/ })).toBeVisible();
  await page.keyboard.press('Enter'); // pick Grace
  await input.press('Enter'); // create

  const c = card(column(page, 'To do'), `${b.key}-1`);
  await expect(c).toBeVisible();
  await expect(c).toContainText('Fix login redirect');

  const t = await eventually('ticket doc', async () => {
    const q = await admin().db.collection(`boards/${b.id}/tickets`).get();
    return q.docs[0]?.data();
  });
  expect(t).toMatchObject({
    key: `${b.key}-1`,
    title: 'Fix login redirect',
    stageId: stage(b, 'To do'),
    priorityId: priority(b, 'High'),
  });
  expect(t.assigneeUids).toEqual([grace.uid]);
});

test('drag a card from In progress to Review, between two others; everyone else sees it move', async ({
  page,
  browser,
}) => {
  const ada = await newPerson('Ada');
  const grace = await newPerson('Grace');
  const b = await newBoard(ada);
  await inviteAndAccept(ada, b.id, grace, 'editor');
  const mk = async (title: string, s: string) =>
    (await call(ada, 'ticketCreate', { boardId: b.id, title, stageId: stage(b, s) })).key;
  const moving = await mk('Moving card', 'In progress');
  const r1 = await mk('Review top', 'Review');
  const r2 = await mk('Review bottom', 'Review');

  await signIn(page, ada.email, `/b/${b.key}`);
  const ctx = await browser.newContext();
  const gp = await ctx.newPage();
  await signIn(gp, grace.email, `/b/${b.key}`);

  const review = column(page, 'Review');
  await expect(card(review, r2)).toBeVisible();
  await dragBetween(
    page,
    card(column(page, 'In progress'), moving),
    card(review, r1),
    card(review, r2),
  );

  await expect(card(review, moving)).toBeVisible();
  await expect(card(column(page, 'In progress'), moving)).toHaveCount(0);

  // server: the stage changed
  const ticket = async (key: string) => {
    const idx = await read(`keys/${key}`);
    return read(`boards/${b.id}/tickets/${idx!.ticketId}`);
  };
  await eventually(
    'stage change',
    async () => (await ticket(moving))?.stageId === stage(b, 'Review'),
  );
  // the order sticks (rank between its neighbours), also after a reload
  await page.reload();
  await expect.poll(() => keysIn(column(page, 'Review'))).toEqual([r1, moving, r2]);

  // Grace's board moved it live
  await expect(card(column(gp, 'Review'), moving)).toBeVisible();
  await ctx.close();
});

/**
 * svelte-dnd-action drags on pointer/mouse events with a threshold, so move
 * in small steps and drop onto the gap between the two target cards.
 */
async function dragBetween(page: Page, source: Locator, above: Locator, below: Locator) {
  const s = (await source.boundingBox())!;
  const a = (await above.boundingBox())!;
  const bb = (await below.boundingBox())!;
  const tx = a.x + a.width / 2;
  // svelte-dnd-action inserts BEFORE the item the dragged card's centre is over
  const ty = bb.y + bb.height * 0.3;
  void a;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  const steps = 25;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      s.x + s.width / 2 + ((tx - (s.x + s.width / 2)) * i) / steps,
      s.y + s.height / 2 + ((ty - (s.y + s.height / 2)) * i) / steps,
    );
    await page.waitForTimeout(16);
  }
  await page.mouse.move(tx, ty + 2);
  await page.waitForTimeout(250);
  await page.mouse.up();
}
