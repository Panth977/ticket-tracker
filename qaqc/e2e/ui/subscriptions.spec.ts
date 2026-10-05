/**
 * ACCESS BETWEEN THINGS, END TO END (frontend/src/lib/access): every entity
 * shows "Subscriptions" (what it uses — Add → pick → tick permissions → Add;
 * Edit; Remove) and "Subscribers" (who uses it — Remove), and either side may
 * end a grant.
 *
 *   board ⇄ memory     the board's admin adds a memory (Read + Write), edits
 *                      it to Read only; the memory's Subscribers lists the
 *                      board, and its owner removes it there
 *   artifact → board   the artifact's owner adds a board; the board's
 *                      Subscribers lists the artifact, and that board's admin
 *                      (not the artifact's owner) removes it
 *   agent → board/art. the agent's Subscriptions: a board as Commenter with a
 *                      stage restriction, an artifact with Build + Read data
 */
import { expect, test } from '@playwright/test';
import {
  call,
  eventually,
  inviteAndAccept,
  newBoard,
  newPerson,
  read,
  stage,
} from '../support/stack.js';
import { setPerms, signIn, subscribe, subscribeDialog } from '../support/ui.js';

test('board Subscriptions adds a memory; the memory’s Subscribers removes it', async ({ page }) => {
  const ada = await newPerson('Ada');
  const eng = await newBoard(ada, { name: 'Engineering' });
  const { memoryId } = await call(ada, 'memoryCreate', { name: 'Design notes' });
  const grant = async () =>
    (await read<{ boards?: Record<string, string> }>(`memories/${memoryId}`))?.boards?.[eng.id] ??
    null;

  await signIn(page, ada.email, `/b/${eng.key}/settings/subscriptions`);
  await subscribe(page, 'board', `memory:${memoryId}`, ['read', 'write']);
  const row = page.locator(`[data-subscription="memory:${memoryId}"]`);
  await expect(row.locator('[data-chips]')).toHaveText(/Read\s*Write/);
  await eventually('write stored', async () => ((await grant()) === 'write' ? true : null));

  // Edit opens straight at the permissions, with what it has now.
  await row.getByRole('button', { name: /^Edit/ }).click();
  const dlg = subscribeDialog(page);
  await expect(dlg.locator('input[data-perm="write"]')).toBeChecked();
  await setPerms(page, ['read']);
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row.locator('[data-chips]')).toHaveText('Read');
  await eventually('read stored', async () => ((await grant()) === 'read' ? true : null));

  // The memory's side: Subscribers lists the board; its owner removes it.
  await page.goto(`/m/${memoryId}/settings/subscribers`);
  const sub = page.locator(`[data-subscriber="board:${eng.id}"]`);
  await expect(sub).toContainText('Engineering');
  await expect(sub.locator('[data-chips]')).toHaveText('Read');
  await sub.getByRole('button', { name: /^Remove/ }).click();
  await page
    .getByRole('dialog', { name: 'Remove access?' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(sub).toHaveCount(0);
  await eventually('grant gone', async () => ((await grant()) === null ? true : null));

  // The old address still lands.
  await page.goto(`/m/${memoryId}/settings/access`);
  await page.waitForURL(`**/m/${memoryId}/settings/subscribers`);
});

test('artifact Subscriptions adds a board; that board’s admin removes it from Subscribers', async ({
  page,
  browser,
}) => {
  const ada = await newPerson('Ada');
  const bob = await newPerson('Bob');
  const ops = await newBoard(bob, { name: 'Operations' });
  await inviteAndAccept(bob, ops.id, ada, 'viewer');
  const { artifactId } = await call(ada, 'artifactCreate', { name: 'Ops dashboard' });
  const boards = async () =>
    (await read<{ boards?: Record<string, string> }>(`artifacts/${artifactId}`))?.boards ?? {};

  await signIn(page, ada.email, `/x/${artifactId}/settings/boards`);
  await page.waitForURL(`**/x/${artifactId}/settings/subscriptions`);
  // Ada only views Operations: Write is locked, with the reason.
  await subscribe(page, 'artifact', `board:${ops.id}`, ['read'], async () => {
    await expect(subscribeDialog(page).locator('input[data-perm="write"]')).toBeDisabled();
  });
  await expect(page.locator(`[data-subscription="board:${ops.id}"] [data-chips]`)).toHaveText(
    'Read',
  );
  await eventually('stored', async () => ((await boards())[ops.id] === 'read' ? true : null));

  // Bob (admin of Operations, not on the artifact) sees it — unnamed — and removes it.
  const ctx = await browser.newContext();
  const bobPage = await ctx.newPage();
  await signIn(bobPage, bob.email, `/b/${ops.key}/settings/subscribers`);
  const sub = bobPage.locator(`[data-subscriber="artifact:${artifactId}"]`);
  await expect(sub).toContainText('An artifact not shared with you');
  await expect(sub.locator('[data-chips]')).toHaveText('Read');
  await sub.getByRole('button', { name: /^Remove/ }).click();
  await bobPage
    .getByRole('dialog', { name: 'Remove access?' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(sub).toHaveCount(0);
  await eventually('removed', async () => (ops.id in (await boards()) ? null : true));
  await ctx.close();

  // …and the artifact's own list follows.
  await expect(page.locator(`[data-subscription="board:${ops.id}"]`)).toHaveCount(0);
});

test('agent Subscriptions: a board as Commenter with a stage restriction, an artifact with Build + Read data', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada, { name: 'Builds' });
  const { artifactId } = await call(ada, 'artifactCreate', { name: 'Release page' });
  const { agentId } = await call(ada, 'agentCreate', { name: 'Runner' });
  const doing = stage(b, 'In progress');

  await signIn(page, ada.email, `/agents/${agentId}`);
  await subscribe(page, 'agent', `board:${b.id}`, ['view', 'comment'], async () => {
    const dlg = subscribeDialog(page);
    await dlg.getByRole('button', { name: 'Stages it may move tickets between' }).click();
    await page.getByRole('option', { name: 'In progress' }).click();
    // Close the stage picker by clicking elsewhere in the dialog (Escape would close the dialog).
    await dlg.getByText('Permissions', { exact: true }).click();
  });
  const boardRow = page.locator(`[data-subscription="board:${b.id}"] [data-chips]`);
  await expect(boardRow).toContainText('Commenter');
  await expect(boardRow).toContainText('In progress');
  await eventually('commenter with a grant', async () => {
    const d = await read<{
      access: Record<string, string>;
      stageGrants?: Record<string, { stages: string[] }>;
    }>(`boards/${b.id}`);
    return d?.access[agentId] === 'commenter' && d.stageGrants?.[agentId]?.stages[0] === doing
      ? true
      : null;
  });

  await subscribe(page, 'agent', `artifact:${artifactId}`, ['build', 'read']);
  await expect(
    page.locator(`[data-subscription="artifact:${artifactId}"] [data-chips]`),
  ).toHaveText(/Build\s*Read data/);
  await eventually('build + read', async () => {
    const a = await read<{ agents: Record<string, { build: boolean; data: string }> }>(
      `artifacts/${artifactId}`,
    );
    const v = a?.agents[agentId];
    return v?.build === true && v.data === 'read' ? true : null;
  });

  // The artifact's Subscribers lists the agent.
  await page.goto(`/x/${artifactId}/settings/subscribers`);
  await expect(page.locator(`[data-subscriber="agent:${agentId}"]`)).toContainText('Runner');
});
