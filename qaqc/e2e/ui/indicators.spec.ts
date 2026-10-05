/**
 * INDICATORS AND DESCRIPTIONS END TO END (docs/plan/indicators.html).
 *
 *   I1  a board is created with an ICON indicator and a description; the
 *       sidebar row and the title switcher draw the icon
 *   I2  a stage gets an EMOJI (picked from the picker's search — never typed
 *       into a text box) and a description; the ticket's stage dropdown draws it
 *   I3  a memory is created with an UPLOADED image indicator; the sidebar
 *       shows the image
 */
import { expect, test, type Page } from '@playwright/test';
import { call, eventually, newPerson, read, uniqueKey } from '../support/stack.js';
import { signIn } from '../support/ui.js';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main' });

/** A 4×4 red PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==',
  'base64',
);

type Ind = { kind: string; icon?: string; emoji?: string; path?: string };

test('I1–I3: board icon + description, stage emoji + description, memory image', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const key = uniqueKey('IN');

  // ── I1: create the board with an icon indicator ───────────────────────────
  await signIn(page, ada.email, '/new-board');
  await page.getByRole('radio', { name: /Kanban/ }).click();
  await page.getByLabel('Name').fill('Rocket launches');
  await page.getByLabel('Key').fill(key);
  await expect(page.getByText(`${key} is available`)).toBeVisible();
  await page.getByTestId('new-board-description').fill('Everything about getting rockets up.');
  await page.getByTestId('indicator-field').click();
  const picker = page.getByTestId('indicator-picker');
  await picker.getByTestId('indicator-tab-icon').click();
  await picker.getByTestId('indicator-icon-rocket').click();
  // Clicking the field again closes its popover.
  await page.getByTestId('indicator-field').click();
  await expect(
    page.getByTestId('indicator-field').locator('[data-indicator="icon"]'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create board' }).click();
  await page.waitForURL(`**/b/${key}/**`);

  const { boardId } = await eventually(
    'board key claim',
    async () => (await read<{ boardId: string }>(`boardKeys/${key}`)) ?? null,
  );
  const board = await read<{ indicator?: Ind; description: unknown }>(`boards/${boardId}`);
  expect(board?.indicator).toMatchObject({ kind: 'icon', icon: 'rocket' });
  expect(board?.description).toBe('Everything about getting rockets up.');

  // the sidebar row and the title switcher draw it
  await expect(
    sidebar(page).locator(`[data-board="${key}"] [data-indicator="icon"]`).first(),
  ).toBeVisible();
  await page.locator('[data-board-switcher]').click();
  const menu = page.getByRole('menu');
  await expect(
    menu.getByRole('menuitem', { name: new RegExp(key) }).locator('[data-indicator="icon"]'),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // ── I2: a stage gets an emoji (searched + picked) and a description ───────
  await page.goto(`/b/${key}/settings/stages`);
  await page.getByRole('button', { name: 'Indicator of Backlog: change' }).click();
  await picker.getByTestId('indicator-tab-emoji').click();
  await picker.getByTestId('indicator-emoji-search').fill('rocket');
  await picker.getByTestId('indicator-emoji').first().click();
  await page.getByRole('button', { name: 'Indicator of Backlog: change' }).click();
  const desc = page.getByLabel('Description of Backlog');
  await desc.fill('Ideas nobody has committed to yet.');
  await desc.press('Tab');
  await page.getByRole('button', { name: 'Save section' }).click();

  const stage = await eventually('stage indicator saved', async () => {
    const b = await read<{
      stages: { name: string; indicator?: Ind; description?: string }[];
    }>(`boards/${boardId}`);
    const s = b?.stages.find((x) => x.name === 'Backlog');
    return s?.indicator?.kind === 'emoji' ? s : null;
  });
  expect(stage.description).toBe('Ideas nobody has committed to yet.');
  expect(stage.indicator?.emoji).toBeTruthy();

  // the ticket's stage dropdown draws the emoji
  const t = await call(ada, 'ticketCreate', { boardId, title: 'First flight' });
  await page.goto(`/t/${t.key}`);
  await page.getByRole('button', { name: 'Stage' }).first().click();
  await expect(
    page.getByRole('option', { name: /Backlog/ }).locator('[data-indicator="emoji"]'),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // ── I3: a memory with an uploaded image indicator ─────────────────────────
  await page.goto('/m');
  await page.getByRole('button', { name: 'New memory' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New memory' });
  await dialog.getByLabel('Name').fill('Launch photos');
  await dialog.getByTestId('indicator-field').click();
  await picker.getByTestId('indicator-tab-upload').click();
  await picker
    .getByTestId('indicator-upload-input')
    .setInputFiles({ name: 'mark.png', mimeType: 'image/png', buffer: PNG });
  await expect(
    dialog.getByTestId('indicator-field').locator('[data-indicator="image"] img'),
  ).toBeVisible();
  await dialog.getByTestId('indicator-field').click();
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(/\/m\/[A-Za-z0-9_-]+$/);
  const memoryId = new URL(page.url()).pathname.split('/')[2]!;

  const memory = await read<{ indicator?: Ind }>(`memories/${memoryId}`);
  expect(memory?.indicator?.kind).toBe('image');
  expect(memory?.indicator?.path).toMatch(new RegExp(`^indicators/${ada.uid}/`));
  await expect(
    sidebar(page).locator(`[data-memory="${memoryId}"] [data-indicator="image"] img`).first(),
  ).toBeVisible();
});
