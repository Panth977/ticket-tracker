/**
 * DICTIONARY, end to end (docs/plan/dictionary.html) — the app as a person uses it:
 *
 *   D1  create a dictionary from my page; it lands on its owner-first URL and
 *       is listed under me in the sidebar
 *   D2  add a Text entry and a JSON entry (a bad JSON value says why and
 *       blocks Save), save, reload: both are there, in order, typed
 *   D3  a change made elsewhere while I edit: the "changed elsewhere —
 *       reload" notice, and Reload shows it
 *   D4  grant it to a board from the board's Settings › Dictionaries (Read);
 *       the dictionary's Subscribers lists the board
 */
import { expect, test, type Page } from '@playwright/test';
import { admin, call, eventually, newBoard, newPerson } from '../support/stack.js';
import { signIn, subscribe, thingIdAt } from '../support/ui.js';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const entryRow = (page: Page, i: number) => page.locator(`[data-entry-row="${i}"]`);

async function stored(dictionaryId: string): Promise<{ k: string; v: string }[] | null> {
  const snap = await admin().db.doc(`dictionaries/${dictionaryId}/content/entries`).get();
  return (snap.get('entries') as { k: string; v: string }[] | undefined) ?? null;
}

test('D1–D4: a dictionary — text and JSON entries, save, reload, conflict, grant to a board', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  await signIn(page, ada.email, '/dictionary');

  // ── D1: create it ──────────────────────────────────────────────────────────
  await page.getByRole('link', { name: 'New dictionary' }).first().click();
  const dialog = page.getByRole('main');
  await dialog.getByLabel('Name').fill('Deploy settings');
  await dialog.getByRole('button', { name: 'Create' }).click();
  const dictionaryId = await thingIdAt(page, ada, 'dictionary');
  await expect(page.locator('[data-dictionary-switcher]')).toContainText('Deploy settings');
  await expect(sidebar(page).locator(`[data-dictionary="${dictionaryId}"]`)).toBeVisible();

  // ── D2: a Text entry and a JSON entry ──────────────────────────────────────
  const editor = page.locator(`[data-entries-editor="${dictionaryId}"]`);
  await editor.getByRole('button', { name: 'Add entry' }).click();
  await entryRow(page, 0).getByLabel('Key').fill('API_URL');
  await entryRow(page, 0).locator('textarea').fill('https://api.example.test');

  await editor.getByRole('button', { name: 'Add entry' }).click();
  await entryRow(page, 1).getByLabel('Key').fill('LIMITS');
  await entryRow(page, 1).getByRole('radio', { name: 'JSON' }).click();
  await entryRow(page, 1).locator('textarea').fill('{"daily": 5, "burst": [1, 2]');
  await expect(entryRow(page, 1).locator('[data-json-error]')).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Save' })).toBeDisabled();
  await entryRow(page, 1).locator('textarea').fill('{"daily": 5, "burst": [1, 2]}');
  await expect(entryRow(page, 1).locator('[data-json-error]')).toHaveCount(0);

  await editor.getByRole('button', { name: 'Save' }).click();
  await eventually('saved', async () => ((await stored(dictionaryId))?.length === 2 ? true : null));
  expect(await stored(dictionaryId)).toEqual([
    { k: 'API_URL', v: '"https://api.example.test"' },
    { k: 'LIMITS', v: '{"daily":5,"burst":[1,2]}' },
  ]);

  await page.reload();
  await expect(entryRow(page, 0).getByLabel('Key')).toHaveValue('API_URL');
  await expect(entryRow(page, 0).getByRole('radio', { name: 'Text' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(entryRow(page, 0).locator('textarea')).toHaveValue('https://api.example.test');
  await expect(entryRow(page, 1).getByLabel('Key')).toHaveValue('LIMITS');
  await expect(entryRow(page, 1).getByRole('radio', { name: 'JSON' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect(JSON.parse(await entryRow(page, 1).locator('textarea').inputValue())).toEqual({
    daily: 5,
    burst: [1, 2],
  });

  // ── D3: changed elsewhere while I edit ─────────────────────────────────────
  await entryRow(page, 0).locator('textarea').fill('https://edited.example.test');
  await call(ada, 'dictionarySet', { dictionaryId, set: { REGION: 'eu' } });
  const notice = page.locator('[data-entries-conflict]');
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Reload' }).click();
  await expect(notice).toHaveCount(0);
  await expect(entryRow(page, 2).getByLabel('Key')).toHaveValue('REGION');
  await expect(entryRow(page, 0).locator('textarea')).toHaveValue('https://api.example.test');

  // ── D4: a board uses it ────────────────────────────────────────────────────
  const b = await newBoard(ada, { name: 'Ops' });
  await signIn(page, ada.email, `/b/${b.key}/settings/dictionaries`);
  await subscribe(page, 'board-dictionaries', `dictionary:${dictionaryId}`, ['read']);
  await expect(
    page.locator(`[data-subscription="dictionary:${dictionaryId}"] [data-chips]`),
  ).toHaveText('Read');
  await eventually('granted', async () => {
    const d = await admin().db.doc(`dictionaries/${dictionaryId}`).get();
    return (d.get('boards') as Record<string, string>)[b.id] === 'read' ? true : null;
  });

  await page.goto(`/dictionary/${dictionaryId}/settings/subscribers`);
  await expect(page.locator(`[data-subscriber="board:${b.id}"]`)).toBeVisible();
});
