/**
 * PHASE 9 END TO END (docs/plan/agents.html §Q) — SIMPLER NAVIGATION.
 *
 *   §Q1  the sidebar is a FLAT list of boards: no accordions, no per-board
 *        Views / People / Settings, and one click opens the board's default
 *        view (prefs.lastViewId, else the board's default).
 *   §Q2  the board page has ONE toolbar, and ⚙ Settings is the only door to
 *        board configuration — People & roles is a section inside it. The old
 *        /b/KEY/people URL still lands there.
 *   §Q3  a ticket created with no stage starts in the board's FIRST stage by
 *        position — the leftmost column — not the first 'todo' one.
 *   §Q4  a board that is loading (or was just switched away from) never throws.
 */
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import { admin, call, eventually, newBoard, newPerson, read, stage } from '../support/stack.js';
import { signIn } from '../support/ui.js';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const column = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

/** Everything the page shouted about while the test ran (§Q4 asserts on this). */
function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

test('§Q1: the sidebar is a flat board list — one click opens the board, and remembers the view', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const eng = await newBoard(ada, { name: 'Engineering' });
  const ops = await newBoard(ada, { name: 'Operations' });
  const engDefaultView = (await read<{ defaultViewId: string }>(`boards/${eng.id}`))!.defaultViewId;

  await signIn(page, ada.email, '/me');
  const nav = sidebar(page);
  await expect(nav.getByRole('link', { name: /Engineering/ })).toBeVisible();

  // No accordions, and nothing about a board below its row: Views, People and
  // Settings left the sidebar entirely.
  await expect(nav.getByRole('button', { name: /^(Expand|Collapse) / })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'People', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);

  // ONE click = that board's default view (no intermediate page to click through).
  await nav.getByRole('link', { name: /Engineering/ }).click();
  await page.waitForURL(`**/b/${eng.key}/**`);
  expect(new URL(page.url()).pathname).toBe(`/b/${eng.key}/${engDefaultView}`);
  await expect(page.getByRole('heading', { name: `${eng.key} Engineering` })).toBeVisible();
  // …and the row I am on is the current one.
  await expect(nav.getByRole('link', { name: /Engineering/ })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // Open a different view here, go elsewhere, come back: the row remembers it.
  await page.getByRole('link', { name: 'Table', exact: true }).click();
  await page.waitForURL(
    (u) => u.pathname.startsWith(`/b/${eng.key}/`) && !u.pathname.endsWith(engDefaultView),
  );
  const tableUrl = new URL(page.url()).pathname;

  await nav.getByRole('link', { name: /Operations/ }).click();
  await page.waitForURL(`**/b/${ops.key}/**`);
  await expect(page.getByRole('heading', { name: `${ops.key} Operations` })).toBeVisible();

  await expect(async () => {
    await nav.getByRole('link', { name: /Engineering/ }).click();
    expect(new URL(page.url()).pathname).toBe(tableUrl);
  }).toPass();
});

test('§Q2: one toolbar, and ⚙ Settings holds People & roles (the old /people URL lands there)', async ({
  page,
}) => {
  const ada = await newPerson('Ada', 'Lovelace');
  const b = await newBoard(ada, { name: 'Engineering' });

  await signIn(page, ada.email, `/b/${b.key}`);
  await expect(page.getByRole('heading', { name: `${b.key} Engineering` })).toBeVisible();

  // One bar: the title, the view tabs and the controls are all in it — and the
  // old second bar's 'View ▾' button is gone (its menu is the open tab's).
  await expect(page.getByRole('navigation', { name: 'Views' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View', exact: true })).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Search this view' })).toBeVisible();
  for (const name of [/^Filter/, /^Sort/, /^Group/]) {
    await expect(page.getByRole('button', { name })).toBeVisible();
  }

  // ⚙ is the only door to board configuration.
  await page.getByRole('link', { name: 'Board settings' }).click();
  await page.waitForURL(`**/b/${b.key}/settings/**`);
  await page.getByRole('link', { name: 'People & roles' }).click();
  await expect(page.getByRole('heading', { name: 'People & roles' })).toBeVisible();
  await expect(page.getByRole('main').getByText('Ada Lovelace')).toBeVisible();

  // Links people already have keep working.
  await page.goto(`/b/${b.key}/people`);
  await page.waitForURL(`**/b/${b.key}/settings/people`);
  await expect(page.getByRole('heading', { name: 'People & roles' })).toBeVisible();
});

test('§Q3: a ticket created with no stage lands in the first column', async ({ page }) => {
  const ada = await newPerson('Ada');
  // The kanban template's first stage by position is 'Backlog'; the first
  // stage of category 'todo' is 'To do' — the point of §Q3 is that they differ.
  const b = await newBoard(ada, { name: 'Engineering', template: 'kanban' });

  await signIn(page, ada.email, `/b/${b.key}`);
  await expect(column(page, 'Backlog')).toBeVisible();

  await page.getByRole('button', { name: 'New ticket' }).click();
  const quick = page.getByRole('textbox', { name: 'Ticket title with tokens' });
  await quick.fill('Where does this land');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.keyboard.press('Escape');

  await expect(
    column(page, 'Backlog').getByRole('button', { name: /Where does this land/ }),
  ).toBeVisible();
  await expect(
    column(page, 'To do').getByRole('button', { name: /Where does this land/ }),
  ).toHaveCount(0);

  const t = await eventually('ticket doc', async () => {
    const q = await admin().db.collection(`boards/${b.id}/tickets`).get();
    return q.docs[0]?.data();
  });
  expect(t.stageId).toBe(stage(b, 'Backlog'));
  expect(t.stageId).not.toBe(stage(b, 'To do'));
});

test('§Q4: loading a board, reloading it and switching boards fast never throws', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const eng = await newBoard(ada, { name: 'Engineering' });
  await newBoard(ada, { name: 'Operations' });
  await call(ada, 'ticketCreate', {
    boardId: eng.id,
    title: 'Something to draw',
    stageId: stage(eng, 'To do'),
  });

  const errors = watchForErrors(page);

  await signIn(page, ada.email, `/b/${eng.key}`);
  await expect(page.getByRole('heading', { name: `${eng.key} Engineering` })).toBeVisible();

  // A hard reload straight onto /b/KEY/VIEW: the board, its views and its
  // members all arrive after the first paint.
  await page.reload();
  await expect(page.getByRole('heading', { name: `${eng.key} Engineering` })).toBeVisible();
  await expect(page.getByRole('button', { name: /Something to draw/ })).toBeVisible();

  // Switching boards as fast as the sidebar allows: the old board's data is
  // gone before the new one's has arrived — the moment that used to blank the
  // page with "Cannot read properties of null (reading 'stages')".
  const nav = sidebar(page);
  for (let i = 0; i < 3; i++) {
    await nav.getByRole('link', { name: /Operations/ }).click();
    await nav.getByRole('link', { name: /Engineering/ }).click();
  }
  await expect(page.getByRole('heading', { name: `${eng.key} Engineering` })).toBeVisible();
  await expect(page.getByRole('button', { name: /Something to draw/ })).toBeVisible();

  expect(errors.filter((e) => !/favicon|Failed to load resource/i.test(e))).toEqual([]);
});

test('§Q4: a board I am not on states so instead of crashing', async ({ page }) => {
  const ada = await newPerson('Ada');
  const zoe = await newPerson('Zoe');
  const secret = await newBoard(zoe, { name: 'Not yours' });
  await newBoard(ada, { name: 'Mine' });

  const errors = watchForErrors(page);
  await signIn(page, ada.email, '/me');
  await page.goto(`/b/${secret.key}`);

  await expect(page.getByText('Board not found')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to your boards' })).toBeVisible();
  expect(
    errors.filter((e) => !/favicon|Failed to load resource|permission|insufficient/i.test(e)),
  ).toEqual([]);
});
