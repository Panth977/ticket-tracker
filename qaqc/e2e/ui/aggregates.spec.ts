/**
 * AGGREGATE FIELDS END TO END (docs/plan/aggregates.html) — two people, two
 * browsers, nothing but the screen:
 *
 *   Ada    Settings › Aggregates: a new field 'Time', unit 'h', weekly, shown
 *          on cards — next to the Cost every board starts with
 *   Grace  (a commenter) opens a ticket: the composer's Σ 'Add to a total'
 *          posts +2.5 h, then /agg posts −0.5 h with a note
 *   thread two entry rows (not bubbles), the note on the second
 *   drawer the ticket's Time total, 2 h
 *   Ada    Analytics › Time: this week's bucket carries the 2 h
 */
import { expect, test, type Page } from '@playwright/test';
import {
  call,
  eventually,
  inviteAndAccept,
  newBoard,
  newPerson,
  read,
  stage,
} from '../support/stack.js';
import { signIn } from '../support/ui.js';

/** The current ISO week in the owner's clock (Asia/Kolkata) — the bucket the server cuts. */
function weekKey(ms: number): string {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(ms))
    .split('-')
    .map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const year = date.getUTCFullYear();
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

async function addToTotal(page: Page, open: () => Promise<void>, value: string, note?: string) {
  await open();
  const dialog = page.getByRole('dialog', { name: 'Add to a total' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Time (h)' }).fill(value);
  if (note) await dialog.getByRole('textbox', { name: 'Note (optional)' }).fill(note);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('aggregates: an admin adds a weekly Time field, a commenter adds to it, Analytics charts it', async ({
  page,
  browser,
}) => {
  const ada = await newPerson('Ada', 'Lovelace');
  const grace = await newPerson('Grace', 'Hopper');
  const b = await newBoard(ada, { name: 'Totals' });
  await inviteAndAccept(ada, b.id, grace, 'commenter');
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Port the parser',
    stageId: stage(b, 'In progress'),
  });

  // ── 1. Ada: Settings › Aggregates ───────────────────────────────────────────
  await signIn(page, ada.email, `/b/${b.key}/settings/aggregates`);
  await expect(page.getByRole('heading', { name: 'Aggregates' })).toBeVisible();
  // Every new board starts with Cost (the turn receipts' field).
  await expect(page.locator('[data-agg-field="Cost"]')).toBeVisible();
  await page.getByRole('button', { name: 'New field' }).click();
  const editor = page.getByRole('dialog', { name: 'New aggregate field' });
  await editor.getByRole('textbox', { name: 'Label' }).fill('Time');
  await editor.getByRole('textbox', { name: 'Unit' }).fill('h');
  await editor.getByRole('combobox', { name: 'Period' }).selectOption('weekly');
  await editor.getByLabel('Show on card').check();
  await editor.getByRole('button', { name: 'Add field' }).click();
  await expect(page.locator('[data-agg-field="Time"]')).toContainText('Weekly');
  await page.getByRole('button', { name: 'Save section' }).click();
  const timeId = await eventually('the Time field saved', async () => {
    const board = await read<{ aggFields?: { id: string; label: string; period: string }[] }>(
      `boards/${b.id}`,
    );
    const f = board?.aggFields?.find((x) => x.label === 'Time' && x.period === 'weekly');
    return f?.id ?? null;
  });
  expect(timeId).toMatch(/^a_[a-z0-9]{6}$/);

  // ── 2. Grace adds to it from the composer ──────────────────────────────────
  const ctx = await browser.newContext();
  const gp = await ctx.newPage();
  await signIn(gp, grace.email, `/t/${t.key}`);
  const thread = gp.getByRole('region', { name: 'Thread' });
  await expect(thread).toBeVisible();
  const reply = gp.getByRole('group', { name: 'Reply' });

  // Σ in the toolbar.
  await addToTotal(gp, () => reply.getByRole('button', { name: 'Add to a total' }).click(), '2.5');
  await expect(thread.locator('[data-agg-card]')).toHaveCount(1);
  await expect(thread.locator('[data-agg-card]').first()).toContainText('+2.5 h Time');

  // /agg in the composer opens the same dialog.
  await addToTotal(
    gp,
    async () => {
      const box = reply.getByRole('textbox', { name: 'Write a reply' });
      await box.click();
      await gp.keyboard.type('/agg', { delay: 40 });
      await expect(gp.getByRole('option', { name: '/agg' })).toBeVisible();
      await gp.keyboard.press('Enter'); // the picker completes the command…
      await reply.getByRole('button', { name: 'Send' }).click(); // …and sending runs it
    },
    '-0.5',
    'Overcounted yesterday',
  );
  const cards = thread.locator('[data-agg-card]');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(1)).toContainText('−0.5 h Time');
  await expect(cards.nth(1)).toContainText('Overcounted yesterday');

  // The ticket's own total, in the header.
  await expect(gp.locator(`[data-agg="${timeId}"]`).first()).toContainText('2 h');
  await test.info().attach('thread', { body: await gp.screenshot(), contentType: 'image/png' });
  await ctx.close();

  // ── 3. Ada: Analytics › Time ────────────────────────────────────────────────
  await page.goto(`/b/${b.key}/settings/analytics`);
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Field' }).selectOption(timeId);
  await expect(page.getByRole('button', { name: '12 weeks' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const wk = weekKey(Date.now());
  await expect(page.locator(`svg path[data-bucket="${wk}"]`)).toHaveCount(1);
  await expect(page.locator('[data-tile="current"]')).toContainText('2 h');
  await expect(page.locator('[data-tile="total"]')).toContainText('2 h');
  const rows = page.locator('[data-ranked] [data-ticket-row]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('2 entries');
  await test
    .info()
    .attach('analytics', { body: await page.screenshot(), contentType: 'image/png' });
});
