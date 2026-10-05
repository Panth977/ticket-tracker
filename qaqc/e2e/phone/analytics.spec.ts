/**
 * ANALYTICS ON A PHONE (docs/plan/agents.html §Y3 · aggregates.html · §U) —
 * the Cost field's view at 390×844 with touch: the tiles read the daily
 * buckets (boards/{b}/aggStats/daily:{day}), the chart draws a bar per day
 * that had entries, a tap on a bar names the day and its tickets, a ranked
 * row opens the ticket, and nothing scrolls sideways.
 *
 * The counters are written straight into Firestore here — the test is about
 * the VIEW; the command that keeps them (messagePost) has its own tests.
 */
import { expect, test } from '@playwright/test';
import { admin, call, newBoard, newPerson, stage } from '../support/stack.js';
import { signIn } from '../support/ui.js';

// qaqc has no DOM lib: the globals page.evaluate() bodies touch are declared.
declare const document: { documentElement: { scrollWidth: number; clientWidth: number } };
declare const localStorage: { getItem(k: string): string | null };

/** 'yyyy-mm-dd' in the owner's clock — the constant the buckets are cut in (AGG_TZ). */
const dayOf = (ms: number) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));

test('§Y3: the Analytics view fits a phone, charts Cost by day and opens a ticket', async ({
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
  await db.doc(`boards/${b.id}/aggStats/daily:${today}`).set({
    period: 'daily',
    key: today,
    fields: {
      cost: { total: 12.5, count: 3, tickets: { [t.key]: { total: 12.5, count: 3 } } },
    },
    updatedAt: now,
  });
  await db.doc(`boards/${b.id}/aggStats/daily:${before}`).set({
    period: 'daily',
    key: before,
    fields: {
      cost: {
        total: 402.27,
        count: 9,
        tickets: { [t.key]: { total: 400, count: 8 }, [`${b.key}-0`]: { total: 2.27, count: 1 } },
      },
    },
    updatedAt: now,
  });
  await db.doc(`boards/${b.id}`).update({
    aggFields: [
      { id: 'cost', label: 'Cost', unit: '$', period: 'daily', position: 0, showOnCard: true },
    ],
    'aggs.cost': { total: 414.77, count: 12 },
    cost: { usd: 414.77, runs: 12 },
  });
  await db.doc(`boards/${b.id}/tickets/${t.ticketId}`).update({
    'aggs.cost': { total: 412.5, count: 11 },
    cost: { usd: 412.5, runs: 11 },
  });

  await signIn(page, ada.email, `/b/${b.key}/analytics`);
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();

  // Cost is the default field.
  await expect(page.getByRole('combobox', { name: 'Field' })).toHaveValue('cost');
  // The tiles: lifetime from the board, the rest from the buckets.
  await expect(page.locator('[data-tile="total"]')).toContainText('$414.77');
  await expect(page.locator('[data-tile="current"]')).toContainText('$12.50');
  await expect(page.locator('[data-tile="recent"]')).toContainText('$414.77');
  await expect(page.locator('[data-tile="perTicket"]')).toContainText('2 tickets');

  // One bar per day that had entries — the other 28 slots are empty.
  await expect(page.locator('svg path[data-bucket]')).toHaveCount(2);

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
  await expect(tip).toContainText('9 entries');
  await expect(tip).toContainText(t.key);

  // Ranked by spend: the expensive ticket first, with its turns.
  const rows = page.locator('[data-ranked] [data-ticket-row]');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-ticket-row', t.key);
  await expect(rows.first()).toContainText('$412.50');
  await expect(rows.first()).toContainText('11 entries');
  await expect(rows.first()).toContainText('The expensive one');

  // The range toggle is remembered on this device.
  await page.getByRole('button', { name: '90 days' }).tap();
  await expect(page.getByRole('button', { name: '90 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await page.evaluate(() => localStorage.getItem('tm:analytics:range:daily'))).toBe('90');

  // A row opens the ticket, and the drawer header carries the ticket's own Cost total.
  await rows.first().tap();
  const drawer = page.getByRole('complementary', { name: `Ticket ${t.key}` });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-cost]').first()).toContainText('$412.50');
});
