/**
 * Flow: "A conversation on a ticket" (app/flows.json) in the browser: the
 * composer's @ and # suggestions, send, the derived mentions/refs, Grace's
 * 'mentioned' inbox item, and pinning the decision.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  admin,
  call,
  doc,
  eventually,
  messagesOf,
  inviteAndAccept,
  newBoard,
  newPerson,
} from '../support/stack.js';
import { signIn } from '../support/ui.js';

test('composer: @mention and #ticket via suggestions, send, Grace is notified, pin floats to the top', async ({
  page,
  browser,
}) => {
  const ada = await newPerson('Ada', 'Lovelace');
  const grace = await newPerson('Grace', 'Hopper');
  const b = await newBoard(ada);
  await inviteAndAccept(ada, b.id, grace, 'editor');
  const target = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Session storage for next',
  });
  const t = await call(ada, 'ticketCreate', { boardId: b.id, title: 'Fix login redirect' });

  await signIn(page, ada.email, `/t/${t.key}`);
  const thread = page.getByRole('region', { name: 'Thread' });
  const editor = page.getByRole('group', { name: 'Reply' }).getByRole('textbox');
  await expect(editor).toBeVisible();
  await editor.click();

  await pickSuggestion(page, '@Gra', /Grace Hopper/);
  await page.keyboard.type('can you check ');
  await pickSuggestion(page, '#Session', new RegExp(target.key));
  await page.keyboard.type('first?');
  await page.getByRole('group', { name: 'Reply' }).getByRole('button', { name: 'Send' }).click();

  // the bubble renders the mention and the ticket chip
  const bubble = thread.getByRole('article').filter({ hasText: 'can you check' }).last();
  await expect(bubble).toContainText('Grace Hopper');
  await expect(bubble).toContainText(target.key);

  // server: mentions and refs were DERIVED from the doc
  const msg = await eventually('message doc', async () => {
    return (await messagesOf(b.id, t.ticketId)).find(
      (m) => m.authorUid === ada.uid && JSON.stringify(m).includes('can you check'),
    );
  });
  expect(msg.body.mentions).toEqual([grace.uid]);
  expect(msg.body.refs).toEqual([target.ticketId]);

  // Grace: 'mentioned' in her inbox (regardless of her board mode)
  await eventually('Grace inbox item', async () => {
    const q = await admin().db.collection(`users/${grace.uid}/inbox`).get();
    return q.docs.find(
      (d) =>
        d.get('ticketId') === t.ticketId && /mention/.test(String(d.get('event') ?? d.get('type'))),
    );
  });

  // a second message, then pin the first: it floats to the top
  await editor.click();
  await page.keyboard.type('Decision: keep next in sessionStorage.');
  await page.keyboard.press('ControlOrMeta+Enter');
  const decision = thread.getByRole('article').filter({ hasText: 'Decision: keep next' });
  await expect(decision).toBeVisible();
  await decision.hover();
  await decision.getByRole('button', { name: 'Pin', exact: true }).click();
  await expect(thread.getByRole('button', { name: /^Pinned/ })).toContainText(
    'Decision: keep next',
  );

  // Grace reads the thread and leaves: 'Seen by' keeps her (her read pointer, not just presence)
  const ctx = await browser.newContext();
  const gp = await ctx.newPage();
  await signIn(gp, grace.email, `/t/${t.key}`);
  await expect(gp.getByRole('region', { name: 'Thread' })).toContainText('Decision: keep next');
  await eventually('Grace read pointer', async () => {
    const r = (await admin().db.doc(`users/${grace.uid}/reads/${t.ticketId}`).get()).data();
    return r && r.ticketId === t.ticketId;
  });
  await ctx.close();
  await page.reload();
  await expect(page.getByLabel(/^Seen by 1 people/)).toBeVisible();
});

/**
 * Opening the ticket reads the notifications that pointed at it (§V).
 * Reading the thread already moved Grace's read pointer; the bell used to keep
 * shouting about the same conversation anyway.
 */
test('the bell clears for a ticket I open, and keeps the rest', async ({ page }) => {
  const ada = await newPerson('Ada', 'Lovelace');
  const grace = await newPerson('Grace', 'Hopper');
  const b = await newBoard(ada);
  await inviteAndAccept(ada, b.id, grace, 'editor');
  const mine = await call(ada, 'ticketCreate', { boardId: b.id, title: 'The one I open' });
  const other = await call(ada, 'ticketCreate', { boardId: b.id, title: 'The one I leave' });

  // Two things happen to Grace, on two different tickets.
  for (const t of [mine, other]) {
    await call(ada, 'messagePost', {
      boardId: b.id,
      ticketId: t.ticketId,
      body: doc([{ mention: grace.uid }, ' have a look']),
    });
  }
  const unread = async () => {
    const q = await admin()
      .db.collection(`users/${grace.uid}/inbox`)
      .where('readAt', '==', null)
      .get();
    return q.docs.map((d) => String(d.get('ticketId')));
  };
  await eventually('both notifications', async () => {
    const ids = await unread();
    return ids.includes(mine.ticketId) && ids.includes(other.ticketId);
  });

  await signIn(page, grace.email, '/me');
  await expect(page.getByRole('button', { name: /Notifications, \d+ unread/ })).toBeVisible();

  // Grace opens ONE of them.
  await page.goto(`/t/${mine.key}`);
  await expect(page.getByRole('region', { name: 'Thread' })).toContainText('have a look');

  await eventually(
    'the opened ticket stops being unread',
    async () => (await unread()).includes(mine.ticketId) === false,
  );
  expect(await unread(), 'the other ticket is still waiting').toEqual([other.ticketId]);

  // /t/KEY is the full-page ticket, which has no shell: the bell is back on /me.
  await page.goto('/me');
  await expect(page.getByRole('button', { name: 'Notifications, 1 unread' })).toBeVisible();
});

/**
 * Type a trigger + query and pick the matching suggestion. The pickers read
 * live board data (members, the ticket index); if it was still loading when
 * the query was typed, retype it — as a person would.
 */
async function pickSuggestion(page: Page, typed: string, option: RegExp) {
  await expect(async () => {
    await page.keyboard.type(typed, { delay: 40 });
    try {
      await expect(page.getByRole('option', { name: option })).toBeVisible({ timeout: 2500 });
    } catch (e) {
      await page.keyboard.press('Escape');
      for (let i = 0; i < typed.length; i++) await page.keyboard.press('Backspace');
      throw e;
    }
  }).toPass({ timeout: 20_000 });
  await page.keyboard.press('Enter');
}
