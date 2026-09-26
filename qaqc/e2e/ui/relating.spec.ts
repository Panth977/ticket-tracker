/**
 * Flow: "Relating tickets" (app/flows.json): #refs written in a description
 * become referencedBy on the other tickets; a 'blocked by' link writes its
 * inverse; both drawers show both directions and the card shows ⛔ blocked.
 */
import { expect, test, type Page } from '@playwright/test';
import { call, eventually, newBoard, newPerson, read } from '../support/stack.js';
import { signIn } from '../support/ui.js';

async function pickRef(page: Page, query: string, key: string) {
  await expect(async () => {
    await page.keyboard.type(`#${query}`, { delay: 40 });
    try {
      await expect(page.getByRole('option', { name: new RegExp(key) })).toBeVisible({
        timeout: 2500,
      });
    } catch (e) {
      await page.keyboard.press('Escape');
      for (let i = 0; i <= query.length; i++) await page.keyboard.press('Backspace');
      throw e;
    }
  }).toPass({ timeout: 20_000 });
  await page.keyboard.press('Enter');
}

test('description #refs → referencedBy; blocked-by link with inverse; Related panels and the blocked card', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada);
  const A = await call(ada, 'ticketCreate', { boardId: b.id, title: 'Ship onboarding' });
  const B = await call(ada, 'ticketCreate', { boardId: b.id, title: 'Auth refactor' });
  const C = await call(ada, 'ticketCreate', { boardId: b.id, title: 'Database migration' });

  await signIn(page, ada.email, `/t/${A.key}`);
  await page.getByRole('button', { name: 'Add a description…' }).click();
  await expect(page.getByRole('textbox', { name: 'Description' })).toBeFocused();
  await page.keyboard.type('needs ');
  await pickRef(page, 'Auth', B.key);
  await page.keyboard.type('and ');
  await pickRef(page, 'Database', C.key);
  await page.keyboard.type('first');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // refs derived on the server: B and C are referenced by A
  await eventually('referencedBy on B and C', async () => {
    const [tb, tc] = [
      await read(`boards/${b.id}/tickets/${B.ticketId}`),
      await read(`boards/${b.id}/tickets/${C.ticketId}`),
    ];
    return tb?.referencedBy?.includes(A.ticketId) && tc?.referencedBy?.includes(A.ticketId);
  });

  // A is blocked by C (via the Related panel)
  const related = page.getByRole('region', { name: 'Related tickets' });
  await related.getByRole('button', { name: 'Link' }).click();
  const picker = page.getByRole('dialog', { name: 'Link a ticket' });
  await picker.getByRole('radio', { name: 'blocked by' }).click();
  await picker.getByRole('textbox', { name: 'Search tickets' }).fill('Database');
  await picker.getByRole('option', { name: new RegExp(C.key) }).click();
  await expect(related).toContainText(C.key);

  const tc = await eventually('inverse link on C', async () => {
    const t = await read(`boards/${b.id}/tickets/${C.ticketId}`);
    return t?.links?.some(
      (l: { type: string; ticketId: string }) => l.type === 'blocks' && l.ticketId === A.ticketId,
    )
      ? t
      : null;
  });
  expect(tc.links).toEqual([{ type: 'blocks', ticketId: A.ticketId }]);

  // C's drawer shows both directions: blocks A, referenced by A
  await page.goto(`/t/${C.key}`);
  const cRelated = page.getByRole('region', { name: 'Related tickets' });
  await expect(cRelated).toContainText('blocks');
  await expect(cRelated).toContainText(A.key);
  // B's drawer: referenced by A
  await page.goto(`/t/${B.key}`);
  await expect(page.getByRole('region', { name: 'Related tickets' })).toContainText(A.key);

  // on the board, A's card says it is blocked
  await page.goto(`/b/${b.key}`);
  const card = page.getByRole('button', { name: new RegExp(`^${A.key} `) });
  await expect(card).toContainText('blocked');
});
