/**
 * Section K (docs/plan/agents.html): no click waits for the server.
 *
 *   1. Creating a ticket while the API is failing (a 503 intercept): the
 *      form is free at once, a dimmed pending card appears, the outbox
 *      retries with backoff and then shows the red edge + a sticky toast;
 *      Open brings the full form back prefilled, and it creates for real
 *      once the API answers again.
 *   2. Sending a message offline: the bubble appears at once with 🕓; back
 *      online but the API failing → retries run out → a red !; a reload keeps
 *      the unsent message (IndexedDB); Resend succeeds once the API is back.
 *   3. Motion + layout: the drawer slides in from the right and the composer
 *      sits at the bottom of an empty thread.
 *
 * Failure is simulated in the browser (page.route) — the server is fine, the
 * client just can't reach it — so what we assert is the client's behaviour.
 */
import { expect, test, type Page } from '@playwright/test';
import { admin, call, eventually, newBoard, newPerson, stage } from '../support/stack.js';
import { signIn } from '../support/ui.js';

/** Every retry uses up to 1 s + 3 s + 9 s of backoff before the entry fails for good. */
const GIVE_UP_MS = 40_000;

const failing = (page: Page, command: string) =>
  page.route(`**/api/${command}`, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'text/plain',
      body: 'Service Unavailable (e2e intercept)',
    }),
  );

test('create while the API is failing: pending card → failed card + toast → Open restores the form', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const ada = await newPerson('Ada');
  const b = await newBoard(ada);
  await signIn(page, ada.email, `/b/${b.key}`);
  const todo = page.getByRole('region', { name: 'To do', exact: true });
  await expect(todo).toBeVisible();

  await failing(page, 'ticketCreate');
  await todo.getByRole('button', { name: 'New' }).click();
  const quick = page.getByRole('textbox', { name: 'Ticket title with tokens' });
  await quick.fill('Flaky network ticket');
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  // Nothing waits: quick add is ready for the next title at once (it stays
  // open for bursts), and the card is already on the board, dimmed and busy.
  await expect(quick).toHaveValue('');
  await expect(quick).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const pending = todo.getByRole('button', { name: /Flaky network ticket — being created$/ });
  await expect(pending).toBeVisible();
  await expect(pending).toHaveAttribute('aria-busy', 'true');

  // Out of retries: a red-edged card and a toast that stays until acted on.
  const failedCard = todo.getByRole('button', {
    name: /Flaky network ticket — could not be created$/,
  });
  await expect(failedCard).toBeVisible({ timeout: GIVE_UP_MS });
  const toast = page
    .getByRole('alert')
    .filter({ hasText: "Couldn't create “Flaky network ticket”" });
  await expect(toast).toBeVisible();

  // Open → the full create form, prefilled from the draft.
  await page.unroute('**/api/ticketCreate');
  await toast.getByRole('button', { name: 'Open' }).click();
  const form = page.getByRole('dialog', { name: `New ticket in ${b.key}` });
  await expect(form).toBeVisible();
  await expect(form.getByLabel('Title')).toHaveValue('Flaky network ticket');
  await expect(toast).toBeHidden();
  await expect(failedCard).toHaveCount(0); // taken back into the form

  await form.getByRole('button', { name: 'Create ticket' }).click();
  await expect(
    todo.getByRole('button', { name: new RegExp(`^${b.key}-1 Flaky network ticket$`) }),
  ).toBeVisible();
  const created = await eventually('ticket doc', async () => {
    const q = await admin().db.collection(`boards/${b.id}/tickets`).get();
    return q.size === 1 ? q.docs[0]!.data() : null;
  });
  expect(created).toMatchObject({ title: 'Flaky network ticket', stageId: stage(b, 'To do') });
});

test('message offline: 🕓 → ! when the API fails → survives a reload → Resend succeeds', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  const ada = await newPerson('Ada');
  const b = await newBoard(ada);
  const t = await call(ada, 'ticketCreate', { boardId: b.id, title: 'Offline thread' });
  await signIn(page, ada.email, `/t/${t.key}`);
  const thread = page.getByRole('region', { name: 'Thread' });
  const composer = page.getByRole('group', { name: 'Reply' });
  const editor = composer.getByRole('textbox');
  await expect(editor).toBeVisible();

  // Offline: the composer still works, clears on send, the bubble shows 🕓.
  await context.setOffline(true);
  await editor.click();
  await page.keyboard.type('Written on the train');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(editor).toHaveText('');
  await expect(editor).toBeEditable();
  const bubble = thread
    .getByRole('article', { name: 'Message from you' })
    .filter({ hasText: 'Written on the train' });
  await expect(bubble).toBeVisible();
  await expect(bubble.getByRole('img', { name: 'Sending' })).toBeVisible();

  // Back online, but the API is down: retries run out → the red !.
  await failing(page, 'messagePost');
  await context.setOffline(false);
  await expect(bubble.getByRole('img', { name: 'Not sent' })).toBeVisible({ timeout: GIVE_UP_MS });

  // A reload keeps the unsent message (persisted per user) — still unsent.
  await page.reload();
  await expect(bubble).toBeVisible();
  await expect(bubble.getByRole('img', { name: 'Not sent' })).toBeVisible({ timeout: GIVE_UP_MS });
  const q = () =>
    admin()
      .db.collection(`boards/${b.id}/tickets/${t.ticketId}/messages`)
      .where('authorUid', '==', ada.uid)
      .get();
  expect((await q()).size).toBe(0);

  // The API is back: Resend from the failed bubble's menu → ✓, exactly one message on the server.
  await page.unroute('**/api/messagePost');
  await bubble.getByText('Written on the train').click();
  await page
    .getByRole('menu', { name: 'Message not sent' })
    .getByRole('menuitem', { name: 'Resend' })
    .click();
  await expect(bubble.getByRole('img', { name: 'Not sent' })).toHaveCount(0);
  await eventually('the message on the server', async () => ((await q()).size === 1 ? true : null));
  await expect(
    thread
      .getByRole('article', { name: 'Message from you' })
      .filter({ hasText: 'Written on the train' }),
  ).toHaveCount(1);
  await page.waitForTimeout(1500); // a duplicate would arrive with the listener
  expect((await q()).size).toBe(1);
});

test('drawer slides in from the right; the composer sits at the bottom of an empty thread', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada);
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Quiet ticket',
    stageId: stage(b, 'To do'),
  });
  await signIn(page, ada.email, `/b/${b.key}`);
  const card = page.getByRole('button', { name: new RegExp(`^${t.key} Quiet ticket`) });
  await expect(card).toBeVisible();

  // Sample the drawer's left edge every frame, from when it is inserted until it settles.
  // (Runs in the browser; qaqc compiles without the DOM lib, hence the narrow typing.)
  const xs = page.evaluate(
    (label) =>
      new Promise<number[]>((resolve) => {
        const w = globalThis as unknown as {
          document: {
            querySelector(s: string): { getBoundingClientRect(): { left: number } } | null;
          };
          requestAnimationFrame(cb: () => void): void;
        };
        const seen: number[] = [];
        const tick = () => {
          const el = w.document.querySelector(`aside[aria-label="${label}"]`);
          if (el) seen.push(Math.round(el.getBoundingClientRect().left));
          if (seen.length > 40) return resolve(seen);
          w.requestAnimationFrame(tick);
        };
        w.requestAnimationFrame(tick);
      }),
    `Ticket ${t.key}`,
  );
  await card.click();
  const lefts = await xs;
  const drawer = page.getByRole('complementary', { name: `Ticket ${t.key}` });
  await expect(drawer).toBeVisible();
  const final = Math.round((await drawer.boundingBox())!.x);
  expect(lefts[0]!, `first frame at ${lefts[0]}, settled at ${final}`).toBeGreaterThan(final + 40);
  expect(lefts[lefts.length - 1]).toBe(final);

  // Empty thread: the composer is pinned to the bottom of the conversation pane.
  const conv = drawer.getByRole('region', { name: 'Conversation' });
  const composer = drawer.getByRole('group', { name: 'Reply' });
  await expect(composer).toBeVisible();
  await expect(drawer.getByRole('article')).toHaveCount(0);
  const c = (await composer.boundingBox())!;
  const pane = (await conv.boundingBox())!;
  const view = page.viewportSize()!;
  expect(Math.abs(pane.y + pane.height - (c.y + c.height))).toBeLessThan(24);
  expect(c.y).toBeGreaterThan(view.height / 2);
});
