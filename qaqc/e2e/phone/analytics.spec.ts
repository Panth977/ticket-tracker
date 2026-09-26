/**
 * ANALYTICS ON A PHONE (docs/plan/agents.html §Y3 · §U) — the cost view at
 * 390×844 with touch: the tiles read the day rows, the chart draws a bar per
 * day that cost something, a tap on a bar names the day and its tickets, a
 * ranked row opens the ticket, and nothing scrolls sideways.
 *
 * The counters (§Y2) are written straight into Firestore here — the test is
 * about the VIEW; the command that keeps them (messagePost) has its own tests.
 */
import { expect, test } from '@playwright/test';
import { admin, call, newBoard, newPerson, stage } from '../support/stack.js';
import { signIn } from '../support/ui.js';

// qaqc has no DOM lib: the globals page.evaluate() bodies touch are declared.
declare const document: { documentElement: { scrollWidth: number; clientWidth: number } };
declare const localStorage: { getItem(k: string): string | null };

/** 'yyyy-mm-dd' in the owner's clock — the constant the day rows are cut in (COST_DAY_TZ). */
const dayOf = (ms: number) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));

test('§Y3: the Analytics view fits a phone, charts the days and opens a ticket', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada, { name: 'Engineering' });
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'The expensive one',
    stageId: stage(b, 'To do'),
  });
  const now = Date.now();
  const today = dayOf(now);
  // Two days back, so 'today' and 'the highest day' are different bars whatever the clock says.
  const before = dayOf(now - 2 * 86_400_000);
  const { db } = admin();
  await db.doc(`boards/${b.id}/stats/${today}`).set({
    day: today,
    costUsd: 12.5,
    runs: 3,
    tickets: { [t.key]: { usd: 12.5, runs: 3 } },
    updatedAt: now,
  });
  await db.doc(`boards/${b.id}/stats/${before}`).set({
    day: before,
    costUsd: 402.27,
    runs: 9,
    tickets: { [t.key]: { usd: 400, runs: 8 }, [`${b.key}-0`]: { usd: 2.27, runs: 1 } },
    updatedAt: now,
  });
  await db.doc(`boards/${b.id}`).update({ cost: { usd: 414.77, runs: 12 } });
  await db.doc(`boards/${b.id}/tickets/${t.ticketId}`).update({ cost: { usd: 412.5, runs: 11 } });

  await signIn(page, ada.email, `/b/${b.key}/analytics`);
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();

  // The tiles: lifetime from the board, the rest from the day rows.
  await expect(page.locator('[data-tile="total"]')).toContainText('$415');
  await expect(page.locator('[data-tile="today"]')).toContainText('$12.5');
  await expect(page.locator('[data-tile="week"]')).toContainText('$415');
  await expect(page.locator('[data-tile="perTicket"]')).toContainText('2 tickets');

  // One bar per day that cost something — the other 28 slots are empty.
  await expect(page.locator('svg path[data-day]')).toHaveCount(2);

  // §U1: nothing wider than the phone.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBe(0);

  // A tap on the highest day names it, its cost and its top tickets.
  await page.locator('svg rect[aria-label*="$402.27"]').tap();
  const tip = page.locator('[data-chart-tip]');
  await expect(tip).toContainText('$402.27');
  await expect(tip).toContainText('9 turns');
  await expect(tip).toContainText(t.key);

  // Ranked by spend: the expensive ticket first, with its turns.
  const rows = page.locator('[data-ranked] [data-ticket-row]');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-ticket-row', t.key);
  await expect(rows.first()).toContainText('$412.50');
  await expect(rows.first()).toContainText('11 turns');
  await expect(rows.first()).toContainText('The expensive one');

  // The range toggle is remembered on this device.
  await page.getByRole('button', { name: '90 days' }).tap();
  await expect(page.getByRole('button', { name: '90 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await page.evaluate(() => localStorage.getItem('tm:analytics:range'))).toBe('90');

  // A row opens the ticket, and the drawer header carries the ticket's own counter (§Y2).
  await rows.first().tap();
  const drawer = page.getByRole('complementary', { name: `Ticket ${t.key}` });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-cost]').first()).toContainText('$412.50');
});
