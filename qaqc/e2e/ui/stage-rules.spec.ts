/**
 * Stage rules (ORCH-14, 2026-10-23):
 *
 *   1. Settings › Stages: what happens to a ticket left idle in a stage —
 *      archive it, or move it on — after a chosen time (Stage.auto).
 *   2. Settings › Stage grants: an editor held to stage PATHS edits anything
 *      but moves a ticket only along them (StageGrant.moves).
 *   3. The sidebar's unread number counts the conversation, not moves.
 */
import { expect, test } from '@playwright/test';
import {
  admin,
  call,
  doc,
  eventually,
  inviteAndAccept,
  newBoard,
  newPerson,
  stage,
} from '../support/stack.js';
import { signIn } from '../support/ui.js';

test('idle rules, editor stage paths, and an unread number that ignores moves', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const ed = await newPerson('Ed');
  const b = await newBoard(ada);
  await inviteAndAccept(ada, b.id, ed, 'editor');
  const todo = stage(b, 'To do');
  const doing = stage(b, 'In progress');
  const done = stage(b, 'Done');

  // ── 1. Done: archive after a day idle ────────────────────────────────────
  await signIn(page, ada.email, `/b/${b.key}/settings/stages`);
  await page.getByLabel('What happens to a ticket left idle in Done').selectOption('archive');
  await page.getByLabel('How long a ticket sits idle in Done first').selectOption('24');
  await page.getByRole('button', { name: 'Save section' }).click();
  await eventually(
    'the rule is saved',
    async () => {
      const s = (await admin().db.doc(`boards/${b.id}`).get()).get('stages') as {
        id: string;
        auto?: unknown;
      }[];
      return (
        JSON.stringify(s.find((x) => x.id === done)?.auto) ===
        JSON.stringify({ afterHours: 24, action: 'archive' })
      );
    },
    20_000,
  );

  // ── 2. Ed (editor): To do → In progress only ─────────────────────────────
  await page.goto(`/b/${b.key}/settings/grants`);
  const row = page.getByTestId('stage-grant').last();
  await row.getByTestId('stage-paths-toggle').check();
  await row
    .getByRole('button', { name: /may move to/ })
    .first()
    .waitFor();
  const fromTodo = row.getByRole('button', { name: 'Stages a ticket in To do may move to' });
  await fromTodo.click();
  // Every path starts open; leave To do → In progress only.
  for (const name of ['Backlog', 'Review', 'Done']) {
    const opt = page.getByRole('option', { name: new RegExp(name) });
    if (await opt.count()) await opt.first().click();
  }
  await page.keyboard.press('Escape');
  await eventually(
    'the paths are saved',
    async () => {
      const g = (await admin().db.doc(`boards/${b.id}`).get()).get(`stageGrants.${ed.uid}`) as
        { moves?: Record<string, string[]> } | undefined;
      return JSON.stringify(g?.moves?.[todo]) === JSON.stringify([doing]);
    },
    20_000,
  );
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Held to paths',
    stageId: todo,
  });
  await expect(
    call(ed, 'ticketUpdate', { boardId: b.id, ticketId: t.ticketId, patch: { stageId: done } }),
  ).rejects.toThrow(/403.*stage rules do not allow this move/);
  await call(ed, 'ticketUpdate', {
    boardId: b.id,
    ticketId: t.ticketId,
    patch: { title: 'Edited' },
  });
  await call(ed, 'ticketUpdate', {
    boardId: b.id,
    ticketId: t.ticketId,
    patch: { stageId: doing },
  });

  // ── 3. Ada's sidebar: Ed's move is not unread; Ed's comment is ───────────
  await page.goto(`/b/${b.key}`);
  const side = page.getByRole('link', { name: new RegExp(b.key) }).first();
  await page.waitForTimeout(2_000);
  await expect(side.getByLabel(/unread/)).toHaveCount(0);
  await call(ed, 'messagePost', {
    boardId: b.id,
    ticketId: t.ticketId,
    body: doc(['Started on it']),
  });
  await expect(side.getByLabel('1 unread')).toBeVisible({ timeout: 20_000 });
});
