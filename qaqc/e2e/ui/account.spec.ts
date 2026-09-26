/**
 * Flows: "Signing up" and "Inviting someone to a board" (app/flows.json),
 * entirely through the browser.
 */
import { expect, test } from '@playwright/test';
import {
  eventually,
  mailTo,
  newBoard,
  newPerson,
  read,
  uniqueEmail,
  uniqueKey,
} from '../support/stack.js';
import { signIn } from '../support/ui.js';

test('sign up → welcome → create the first board', async ({ page }) => {
  const email = uniqueEmail('newbie');
  const key = uniqueKey('N');

  // No gate: an unknown address signs in (= signs up) with an email link.
  await signIn(page, email);
  await expect(page).toHaveURL(/\/welcome/);
  await expect(page.getByRole('heading', { name: 'Welcome to TaskManager' })).toBeVisible();

  await page.getByLabel('Display name').fill('Nina Newbie');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Start your first board' })).toBeVisible();
  await page.getByRole('button', { name: 'Create your first board' }).click();

  await expect(page).toHaveURL(/\/new-board/);
  await page.getByRole('radio', { name: /Kanban/ }).click();
  await page.getByLabel('Name').fill('Nina’s board');
  await page.getByLabel('Key').fill(key);
  await expect(page.getByText(`${key} is available`)).toBeVisible();
  await page.getByRole('button', { name: 'Create board' }).click();

  await expect(page).toHaveURL(new RegExp(`/b/${key}`));
  for (const col of ['Backlog', 'To do', 'In progress', 'Review', 'Done'])
    await expect(page.getByRole('region', { name: col, exact: true })).toBeVisible();

  // server side: the profile name was saved and she is the board's admin
  const claim = await eventually(
    'board key claim',
    async () => (await read<{ boardId: string }>(`boardKeys/${key}`)) ?? null,
  );
  const board = await read(`boards/${claim.boardId}`);
  const uid = Object.entries(board!.access as Record<string, string>).find(
    ([, r]) => r === 'admin',
  )![0];
  expect((await read(`users/${uid}`))?.name).toBe('Nina Newbie');
});

test('invite by email → the invitee opens the link and joins', async ({ page, browser }) => {
  const ada = await newPerson('Ada');
  const grace = await newPerson('Grace');
  const b = await newBoard(ada, { name: 'Invite board' });

  await signIn(page, ada.email, `/b/${b.key}/people`);
  const form = page.getByRole('form', { name: 'Invite people' });
  await form.getByLabel('Email addresses').fill(grace.email);
  await form.getByLabel('Role').selectOption('editor');
  await form.getByRole('button', { name: /^Invite/ }).click();
  await expect(
    page.getByRole('region', { name: 'Pending invites' }).getByText(grace.email),
  ).toBeVisible();

  // the e-mail she gets carries the /invite/{id}.{token} link
  const mail = await eventually('invite e-mail', async () =>
    (await mailTo(grace.email)).find((m) => /\/invite\//.test(`${m.html}${m.text}`)),
  );
  const link = /https?:\/\/[^\s"'<>]+\/invite\/[^\s"'<>]+/
    .exec(`${mail.text}\n${mail.html}`)![0]
    .replace(/&amp;/g, '&');
  const path = new URL(link).pathname;

  const ctx = await browser.newContext();
  const gp = await ctx.newPage();
  await signIn(gp, grace.email, path);
  await expect(gp).toHaveURL(new RegExp(path.replace(/[.]/g, '\\.')));
  await gp.getByRole('button', { name: 'Join' }).click();
  await expect(gp).toHaveURL(new RegExp(`/b/${b.key}`));

  // Ada sees her on the board, as an editor
  await page.reload();
  await expect(
    page.getByRole('combobox', { name: new RegExp(`Role of (${grace.name}|${grace.email})`) }),
  ).toHaveValue('editor');
  const board = await read(`boards/${b.id}`);
  expect(board?.access[grace.uid]).toBe('editor');
  await ctx.close();
});
