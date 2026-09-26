/**
 * The ticket view (docs/plan/agents.html §K): two panes, no tabs, and a thread
 * that reads like a chat app.
 *
 *   1. Left: title + description fixed on top, the thread scrolling below it,
 *      the composer pinned to the bottom. Right: Details, Attachments and
 *      Activity, scrolling on its own. Neither pane moves the other, and there
 *      are no Thread / Activity / Files tabs any more.
 *   2. Bubbles: mine on the right without an avatar, everyone else's on the
 *      left with one; a 'New messages' divider before the first message posted
 *      by someone else since I last opened the ticket; reopening clears both
 *      the divider and the card's unread dot.
 */
import { expect, test, type Locator } from '@playwright/test';
import {
  call,
  doc,
  eventually,
  inviteAndAccept,
  newBoard,
  newPerson,
  read,
  stage,
} from '../support/stack.js';
import { signIn } from '../support/ui.js';

/** A scroll container's scrollTop (the panes scroll on their own). */
const scrollTop = (el: Locator) =>
  el.evaluate((e) => (e as unknown as { scrollTop: number }).scrollTop);

test('two panes, no tabs: fixed title, scrolling thread, pinned composer, and a pane that scrolls on its own', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada);
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'A long conversation',
    stageId: stage(b, 'To do'),
    description: doc(['Everything about this ticket, at the top of the left pane.']),
  });
  // Enough messages for the thread to scroll, and enough activity for the right pane to.
  for (let i = 1; i <= 25; i++) {
    await call(ada, 'messagePost', {
      boardId: b.id,
      ticketId: t.ticketId,
      body: doc([`Message number ${i}`]),
    });
  }
  for (let i = 1; i <= 12; i++) {
    await call(ada, 'ticketUpdate', {
      boardId: b.id,
      ticketId: t.ticketId,
      patch: { title: `A long conversation ${i}` },
    });
  }
  await call(ada, 'ticketUpdate', {
    boardId: b.id,
    ticketId: t.ticketId,
    patch: { title: 'A long conversation' },
  });

  await signIn(page, ada.email, `/t/${t.key}`);
  // The title is editable in place, so it is a textarea labelled 'Title' (not a heading).
  const title = page.getByRole('textbox', { name: 'Title' });
  const thread = page.getByRole('region', { name: 'Thread' });
  const details = page.getByRole('complementary', { name: 'Details' });
  const composer = page.getByRole('group', { name: 'Reply' });
  await expect(title).toHaveValue('A long conversation');
  await expect(thread.getByRole('article').last()).toContainText('Message number 25');

  // No tabs anywhere on the ticket (the old Thread / Activity / Files tabs are gone).
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByRole('tablist')).toHaveCount(0);
  // The right pane's three sections are all there at once.
  for (const name of ['Details', 'Attachments', 'Activity'])
    await expect(details.getByRole('button', { name })).toBeVisible();

  // The composer sits at the bottom of the left pane, below the thread.
  const box = async (l: Locator) => (await l.boundingBox())!;
  const conv = page.getByRole('region', { name: 'Conversation' });
  const [convBox, composerBox, titleBox] = [await box(conv), await box(composer), await box(title)];
  expect(Math.abs(convBox.y + convBox.height - (composerBox.y + composerBox.height))).toBeLessThan(
    24,
  );
  expect(titleBox.y).toBeLessThan(composerBox.y);

  // Scrolling the thread moves neither the title nor the right pane.
  const scroller = thread.locator('[data-ticket-scroll]');
  const asideBefore = await scrollTop(details);
  await scroller.evaluate((e) => ((e as unknown as { scrollTop: number }).scrollTop = 0));
  await expect.poll(() => scrollTop(scroller)).toBe(0);
  await expect(thread.getByRole('article').first()).toContainText('Message number 1');
  expect((await box(title)).y).toBe(titleBox.y);
  expect((await box(composer)).y).toBe(composerBox.y);
  expect(await scrollTop(details)).toBe(asideBefore);

  // …and scrolling the right pane leaves the thread where it was.
  await details.evaluate((e) => ((e as unknown as { scrollTop: number }).scrollTop = 400));
  await expect.poll(() => scrollTop(details)).toBeGreaterThan(0);
  expect(await scrollTop(scroller)).toBe(0);
});

test('bubbles: mine right, others left with an avatar; a New messages divider that clears on the next open', async ({
  page,
}) => {
  const ada = await newPerson('Ada', 'Lovelace');
  const grace = await newPerson('Grace', 'Hopper');
  const b = await newBoard(ada);
  await inviteAndAccept(ada, b.id, grace, 'editor');
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Two voices',
    stageId: stage(b, 'To do'),
  });
  await call(ada, 'messagePost', {
    boardId: b.id,
    ticketId: t.ticketId,
    body: doc(['Mine, before anything else']),
  });

  // Ada opens the ticket: that is her last-read mark.
  await signIn(page, ada.email, `/b/${b.key}`);
  const card = page.getByRole('button', { name: new RegExp(`^${t.key} Two voices`) });
  await card.click();
  const drawer = page.getByRole('complementary', { name: `Ticket ${t.key}` });
  const thread = drawer.getByRole('region', { name: 'Thread' });
  await expect(thread.getByRole('article', { name: 'Message from you' })).toBeVisible();
  await eventually(
    'Ada read pointer',
    async () => (await read(`users/${ada.uid}/reads/${t.ticketId}`))?.readAt != null,
  );
  await expect(thread.getByRole('separator', { name: 'New messages' })).toHaveCount(0);

  // Mine on the right, no avatar; Grace's on the left, with her avatar.
  // The <article> spans the pane; the BUBBLE inside it is what sits left or right.
  const mine = thread.getByRole('article', { name: 'Message from you' });
  const mineBox = (await mine.getByText('Mine, before anything else').boundingBox())!;
  const threadBox = (await thread.boundingBox())!;
  expect(mineBox.x + mineBox.width).toBeGreaterThan(threadBox.x + threadBox.width * 0.7);
  expect(mineBox.x).toBeGreaterThan(threadBox.x + threadBox.width * 0.1);

  // Ada closes the ticket; Grace says two things while it is closed.
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  for (const text of ['First while you were away', 'And a second one']) {
    await call(grace, 'messagePost', { boardId: b.id, ticketId: t.ticketId, body: doc([text]) });
  }
  // §P2: the card counts what I have not read, from the same read pointer as
  // the divider below — 'N unread messages'.
  await expect(card.getByLabel(/unread message/)).toBeVisible();

  // Reopening: the divider sits before Grace's first message, which is on the left with an avatar.
  await card.click();
  const hers = thread.getByRole('article', { name: 'Message from Grace Hopper' }).first();
  await expect(hers).toContainText('First while you were away');
  const divider = thread.getByRole('separator', { name: 'New messages' });
  await expect(divider).toBeVisible();
  // Measured again: reopening scrolls the thread to the divider.
  const [dividerBox, hersBox, mineNow] = [
    (await divider.boundingBox())!,
    (await hers.getByText('First while you were away').boundingBox())!,
    (await mine.getByText('Mine, before anything else').boundingBox())!,
  ];
  expect(dividerBox.y).toBeLessThan(hersBox.y);
  expect(dividerBox.y).toBeGreaterThan(mineNow.y);
  // Hers starts nearer the left edge than mine, and mine reaches further right.
  expect(hersBox.x).toBeLessThan(mineNow.x);
  expect(hersBox.x - threadBox.x).toBeLessThan(mineNow.x - threadBox.x);
  expect(mineNow.x + mineNow.width).toBeGreaterThan(hersBox.x + hersBox.width);
  // Her avatar is there (role img: initials or picture); mine never carries one.
  await expect(hers.getByRole('img', { name: /Grace Hopper/ })).toBeVisible();
  await expect(mine.getByRole('img', { name: /Ada Lovelace/ })).toHaveCount(0);

  // Opening marked it read: the dot is gone and a later open has no divider.
  await page.keyboard.press('Escape');
  await expect(card.getByLabel(/unread message/)).toHaveCount(0);
  // ...and what is left is the muted total, never a count in accent (§P2).
  await expect(card.locator('[data-unread]')).toHaveCount(0);
  await expect(card.getByLabel(/^3 messages$/)).toBeVisible();
  await card.click();
  await expect(
    thread.getByRole('article', { name: 'Message from Grace Hopper' }).first(),
  ).toBeVisible();
  await expect(thread.getByRole('separator', { name: 'New messages' })).toHaveCount(0);
});
