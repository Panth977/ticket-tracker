/**
 * PHASE 5 END TO END (docs/plan/agents.html §N1): a QUESTION ASKED BY A PERSON.
 *
 * "Questions and task lists are not agent features — an agent was simply the
 * first thing that could use them." Nothing below touches MCP, a token or an
 * agent: it is two people in two browsers.
 *
 *   Ada    composer ❓ → the builder: 'Pick one', two options, an
 *          'Anything else?' box, addressed to Grace, blocking
 *   board  Ada's card carries ❓ Waiting for an answer
 *   Grace  her ticket header carries ❓ Waiting for you; she answers
 *   Ada    the card locks with Grace's values ('Answered by Grace Hopper')
 *          and Grace's answer is a reply bubble in the thread
 *   Ada    asks a second question (the /ask slash command this time) and
 *          takes it back — the card locks as Cancelled
 *
 * Every assertion is on what the SCREEN says; the wire shapes are pinned by
 * qaqc/e2e/api/phase3.spec.ts and the unit tests in frontend/src/lib/ticket.
 */
import { expect, test, type Page } from '@playwright/test';
import { call, inviteAndAccept, newBoard, newPerson, stage } from '../support/stack.js';
import { signIn } from '../support/ui.js';

/** A screenshot in the report — §N is a spec about what a person can do. */
async function shot(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

/** The composer's ❓ button, and the builder it opens. */
async function openBuilder(page: Page) {
  await page
    .getByRole('group', { name: 'Reply' })
    .getByRole('button', { name: 'Ask a question' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Ask a question' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('§N1: Ada asks a blocking question with options, Grace answers it, Ada takes the next one back', async ({
  page,
  browser,
}) => {
  const ada = await newPerson('Ada', 'Lovelace');
  const grace = await newPerson('Grace', 'Hopper');
  const b = await newBoard(ada, { name: 'Questions' });
  await inviteAndAccept(ada, b.id, grace, 'editor');
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Add CSV export',
    stageId: stage(b, 'In progress'),
  });

  await signIn(page, ada.email, `/t/${t.key}`);
  const thread = page.getByRole('region', { name: 'Thread' });
  await expect(thread).toBeVisible();

  // ── 1. the builder (§N1) ───────────────────────────────────────────────────
  const dialog = await openBuilder(page);

  // A starting point fills the fields in; the title is the asker's own words.
  await dialog.getByRole('button', { name: 'Pick one' }).click();
  await dialog
    .getByRole('textbox', { name: 'Question', exact: true })
    .fill('Which database should the report use?');
  const field = dialog.locator('[data-ask-field]').first();
  await field.getByRole('textbox', { name: 'Label' }).fill('Database');
  await field.getByRole('textbox', { name: 'Option 1' }).fill('Postgres');
  await field.getByRole('textbox', { name: 'Option 2' }).fill('BigQuery');
  // A third option, then away again: the option editor is the point of §N1.
  await field.getByRole('button', { name: 'Add option' }).click();
  await field.getByRole('textbox', { name: 'Option 3' }).fill('Typo');
  await field.getByRole('button', { name: 'Remove option 3' }).click();
  await expect(field.getByRole('textbox', { name: 'Option 3' })).toHaveCount(0);

  await dialog.getByLabel('Add an “Anything else?” box').check();
  await expect(dialog.getByLabel('Blocking')).toBeChecked(); // §L1's default

  // Who should answer: Grace, so the card says whom it waits for.
  const who = dialog.getByRole('button', { name: 'Who should answer' });
  await who.click();
  await dialog.getByRole('option', { name: new RegExp(grace.name) }).click();
  await who.click(); // close the picker (Escape would reach the dialog itself)

  // The preview IS the card the thread will render (§N1).
  const preview = dialog.locator('[data-ask-preview]');
  await expect(preview).toContainText('Which database should the report use?');
  await expect(preview).toContainText('Postgres');
  await expect(preview).toContainText('BigQuery');
  await shot(page, 'ask-builder');

  await dialog.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(dialog).toBeHidden();

  // ── 2. the card in the thread, open and addressed ─────────────────────────
  const card = thread
    .locator('[data-question]')
    .filter({ hasText: 'Which database should the report use?' });
  await expect(card).toHaveAttribute('data-question-status', 'open');
  await expect(card).toContainText(`Waiting for ${grace.name}`);
  // Ada asked it, so it is hers to take back — but not hers to answer.
  await expect(card.getByRole('button', { name: 'Cancel question' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Submit' })).toHaveCount(0);
  await shot(page, 'question-asked-by-a-person');

  // ── 3. ❓ Waiting, without opening the ticket (§L1) ────────────────────────
  await page.goto(`/b/${b.key}`);
  const boardCard = page.getByRole('button', { name: new RegExp(`^${t.key} `) }).first();
  await expect(boardCard.locator('[data-waiting]')).toContainText('Waiting for an answer');

  // ── 4. Grace: 'waiting for you', and she answers it ───────────────────────
  const ctx = await browser.newContext();
  const gp = await ctx.newPage();
  await signIn(gp, grace.email, `/t/${t.key}`);
  // The ticket header says the question is hers to answer (§L1).
  await expect(gp.locator('[data-waiting]').first()).toContainText('Waiting for you');

  const form = gp
    .locator('[data-question]')
    .filter({ hasText: 'Which database should the report use?' });
  await expect(form).toHaveAttribute('data-question-status', 'open');
  await form.getByRole('radio', { name: 'Postgres' }).check();
  await form.getByLabel('Anything else?').fill('BigQuery costs per query');
  await form.getByRole('button', { name: 'Submit' }).click();

  await expect(form).toHaveAttribute('data-question-status', 'answered');
  await expect(form).toContainText('Postgres');
  await expect(form).toContainText(`Answered by ${grace.name}`);
  await expect(gp.locator('[data-waiting]')).toHaveCount(0);
  await shot(gp, 'question-answered-by-grace');
  await ctx.close();

  // ── 5. Ada's page, still open, locks with Grace's values ──────────────────
  await page.goto(`/t/${t.key}`);
  const locked = thread
    .locator('[data-question]')
    .filter({ hasText: 'Which database should the report use?' });
  await expect(locked).toHaveAttribute('data-question-status', 'answered');
  await expect(locked).toContainText('Database');
  await expect(locked).toContainText('Postgres');
  await expect(locked).toContainText('BigQuery costs per query');
  await expect(locked).toContainText(`Answered by ${grace.name}`);
  // The answer is also Grace's own reply bubble (§L1: the command posts it).
  await expect(
    thread.getByRole('article', { name: `Message from ${grace.name}` }).last(),
  ).toContainText('Postgres');
  // Nothing is waiting on this ticket any more.
  await expect(page.locator('[data-waiting]')).toHaveCount(0);

  // ── 6. a second question, from /ask, taken back again (§N1) ───────────────
  const editor = page
    .getByRole('group', { name: 'Reply' })
    .getByRole('textbox', { name: 'Write a reply' });
  await editor.click();
  await page.keyboard.type('/ask', { delay: 40 });
  await expect(page.getByRole('option', { name: '/ask' })).toBeVisible();
  await page.keyboard.press('Enter'); // the picker completes the command…
  // …and it runs when the line is sent (a slash line posts nothing itself).
  await page.getByRole('group', { name: 'Reply' }).getByRole('button', { name: 'Send' }).click();

  const second = page.getByRole('dialog', { name: 'Ask a question' });
  await expect(second).toBeVisible();
  await second.getByRole('button', { name: 'Yes / No' }).click();
  await second
    .getByRole('textbox', { name: 'Question', exact: true })
    .fill('Should we ship on Friday?');
  await second.getByRole('button', { name: 'Ask', exact: true }).click();

  const open2 = thread.locator('[data-question]').filter({ hasText: 'Should we ship on Friday?' });
  await expect(open2).toHaveAttribute('data-question-status', 'open');
  // Nobody was named, so Ada may answer it as well as cancel it.
  await expect(open2.getByRole('button', { name: 'Yes' })).toBeVisible();
  await open2.getByRole('button', { name: 'Cancel question' }).click();
  await expect(open2).toHaveAttribute('data-question-status', 'cancelled');
  await expect(open2).toContainText('This question was taken back.');
  await expect(open2.getByRole('button', { name: 'Yes' })).toHaveCount(0);
  await shot(page, 'question-cancelled');
});
