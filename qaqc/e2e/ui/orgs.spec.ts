/**
 * OWNERS AND ORGS END TO END (docs/plan/agents.html §AC) — what replaced
 * personal workspaces:
 *
 *   AC1  an org is made from the sidebar; it lands on /{handle}; a board made
 *        inside it lives under the org in the sidebar (my own board under me,
 *        in Users) and at /{handle}/b/{KEY}, with "Org ›" and a switcher of
 *        the org's things
 *   AC2  a member joins by invite and reaches everything the org owns at its
 *        base role; the Members page lists them
 *   AC3  Danger zone › Move puts a personal artifact into the org; its URL is
 *        /{handle}/x/{slug}
 *   AC4  everything under its owner, like GitHub: me and the people who share
 *        with me under Users, no hiding, `/` is my page; + creates in my
 *        space; Move hands a board to another person
 */
import { expect, test, type Page } from '@playwright/test';
import { admin, call, eventually, newBoard, newPerson, read } from '../support/stack.js';
import { signIn, thingIdAt } from '../support/ui.js';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const owners = (page: Page, which: 'orgs' | 'users') =>
  sidebar(page).locator(`[data-owners="${which}"]`);
const uniqueHandle = () =>
  `org-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const uniqueKey = () =>
  'O' +
  (Date.now().toString(36) + Math.random().toString(36).slice(2))
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(-5);

test('AC1: make an org, a board inside it, find it under the org and at /{handle}/b/{KEY}', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const mine = await newBoard(ada, { name: 'Health' });
  const handle = uniqueHandle();

  await signIn(page, ada.email, '/me');
  const nav = sidebar(page);
  await nav.getByRole('button', { name: 'New org' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New org' });
  await dialog.getByLabel('Name').fill('Freelance');
  await dialog.getByLabel('Handle').fill(handle);
  await dialog.getByRole('button', { name: 'Create org' }).click();
  await page.waitForURL(`**/${handle}`);
  await expect(page.getByRole('heading', { name: 'Freelance', level: 1 })).toBeVisible();

  const org = await eventually('the org', async () => {
    const q = await admin().db.collection('orgs').where('handle', '==', handle).get();
    return q.docs[0] ? { id: q.docs[0].id } : null;
  });
  const key = uniqueKey();
  const { boardId } = await call(ada, 'boardCreate', {
    name: 'Client Board',
    key,
    owner: { kind: 'org', id: org.id },
  });

  // Under the org in the sidebar; my own board under me (Users), and nowhere else.
  const row = nav.locator(`[data-org="${org.id}"]`);
  await expect(row).toBeVisible();
  await nav.getByRole('button', { name: 'Unfold Freelance' }).click();
  await expect(owners(page, 'orgs').locator(`[data-board="${key}"]`)).toBeVisible();
  const users = owners(page, 'users');
  await expect(users.locator(`[data-board="${mine.key}"]`)).toBeVisible();
  await expect(users.locator(`[data-board="${key}"]`)).toHaveCount(0);
  await expect(nav.locator(`[data-board="${key}"]`)).toHaveCount(1);

  // Opening it: the owner-first URL, "Org ›", and a switcher of the org's things only.
  await nav.locator(`[data-board="${key}"]`).click();
  await page.waitForURL(`**/${handle}/b/${key}**`);
  await expect(page.locator('[data-org-crumb]')).toHaveText('Freelance');
  await page.locator('[data-board-switcher]').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: `${key} · Client Board` })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: new RegExp(mine.key) })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The owner-first URL works straight from the address bar too.
  await page.goto(`/${handle}/b/${key}`);
  await expect(page.locator('[data-org-crumb]')).toHaveText('Freelance');
  expect((await read<{ ownerHandle: string }>(`boards/${boardId}`))!.ownerHandle).toBe(handle);
});

test('AC2 + AC3: a member joins by invite and reaches what the org owns; Move puts an artifact in it', async ({
  page,
  browser,
}) => {
  const ada = await newPerson('Ada');
  const ben = await newPerson('Ben');
  const handle = uniqueHandle();
  const { orgId } = await call(ada, 'orgCreate', { handle, name: 'Studio', baseRole: 'viewer' });
  const key = uniqueKey();
  const { boardId } = await call(ada, 'boardCreate', {
    name: 'Studio Ops',
    key,
    owner: { kind: 'org', id: orgId },
  });
  const { artifactId } = await call(ada, 'artifactCreate', { name: 'Studio Dash' });

  // Ada invites Ben from the Members page.
  await signIn(page, ada.email, `/${handle}/settings/members`);
  await page.getByLabel('Invite').fill(ben.email);
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const invite = await eventually('the org invite', async () => {
    const q = await admin()
      .db.collection('invites')
      .where('orgId', '==', orgId)
      .where('email', '==', ben.email.toLowerCase())
      .get();
    return q.docs[0] ? { id: q.docs[0].id } : null;
  });
  await call(ben, 'inviteAccept', { inviteId: invite.id, accept: true });
  await expect(page.locator(`[data-org-member="${ben.uid}"]`)).toBeVisible();

  // Ben reaches the org's board at the base role.
  expect(
    (await read<{ access: Record<string, string> }>(`boards/${boardId}`))!.access[ben.uid],
  ).toBe('viewer');
  const ctx = await browser.newContext();
  const bp = await ctx.newPage();
  await signIn(bp, ben.email, `/${handle}`);
  await expect(bp.locator(`main [data-board="${key}"]`)).toBeVisible();
  await expect(sidebar(bp).locator(`[data-org="${orgId}"]`)).toBeVisible();

  // AC3 — Ada moves her artifact into the org (Danger zone › Move).
  await page.goto(`/x/${artifactId}/settings/general`);
  const move = page.locator('[data-move-owner]');
  await move.getByLabel('New owner').selectOption(`org:${orgId}`);
  await move.getByRole('button', { name: 'Move' }).click();
  await eventually('moved', async () => {
    const a = await read<{ ownerKey: string; access: Record<string, string> }>(
      `artifacts/${artifactId}`,
    );
    return a?.ownerKey === `org:${orgId}` && a.access[ben.uid] === 'viewer';
  });
  // Ben opens it at its owner-first URL.
  await bp.goto(`/${handle}/x/studio-dash`);
  await expect(bp.locator('[data-org-crumb]')).toHaveText('Studio');
  await ctx.close();
});

test('AC4: everything under its owner — me and who shares with me; no hiding; + creates; Move to a person', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const ben = await newPerson('Ben');
  const mine = await newBoard(ada, { name: 'Health' });
  const theirs = await newBoard(ben, { name: 'Ben Ops' });
  await call(ben, 'inviteCreate', {
    boardId: theirs.id,
    invites: [{ email: ada.email, role: 'editor' }],
  });
  const inv = await eventually('the board invite', async () => {
    const q = await admin()
      .db.collection('invites')
      .where('boardId', '==', theirs.id)
      .where('email', '==', ada.email.toLowerCase())
      .get();
    return q.docs[0] ? { id: q.docs[0].id } : null;
  });
  await call(ada, 'inviteAccept', { inviteId: inv.id, accept: true });
  const benHandle = await eventually(
    'Ben’s handle',
    async () => (await read<{ handle?: string }>(`users/${ben.uid}`))?.handle ?? null,
  );

  await signIn(page, ada.email, '/me');
  const users = owners(page, 'users');
  // My own space is open; Ben is there because he shares a board with me.
  const me = users.locator(`[data-owner-row="user:${ada.uid}"]`);
  await expect(users.locator(`[data-board="${mine.key}"]`)).toBeVisible();
  const benRow = users.locator(`[data-owner-row="user:${ben.uid}"]`);
  await expect(benRow).toBeVisible();
  await benRow.getByRole('button', { name: /^Unfold/ }).click();
  await expect(users.locator(`[data-board="${theirs.key}"]`)).toBeVisible();
  // A + on my space, none on Ben's.
  await expect(me.getByRole('button', { name: /^Create in/ })).toBeVisible();
  await expect(benRow.getByRole('button', { name: /^Create in/ })).toHaveCount(0);

  // `/` is my page: only what I own, and nothing to hide.
  await page.goto('/');
  await page.waitForURL((u) => u.pathname !== '/');
  await expect(page.locator(`main [data-board="${mine.key}"]`)).toBeVisible();
  await expect(page.locator(`main [data-board="${theirs.key}"]`)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Hide .* from the sidebar/ })).toHaveCount(0);

  // + in my space → a bucket that is mine.
  await me.getByRole('button', { name: /^Create in/ }).click();
  await page.getByRole('menuitem', { name: 'New bucket' }).click();
  const dialog = page.getByRole('dialog', { name: 'New bucket' });
  await dialog.getByLabel('Name').fill('Notes');
  await dialog.getByRole('button', { name: 'Create' }).click();
  const bucketId = await thingIdAt(page, ada, 'bucket');
  expect((await read<{ ownerKey: string }>(`buckets/${bucketId}`))!.ownerKey).toBe(
    `user:${ada.uid}`,
  );

  // Move my board to Ben, like transferring a repo: it is his, I stay on it.
  await page.goto(`/b/${mine.key}/settings/danger`);
  const move = page.locator('[data-move-owner]');
  await move.getByLabel('New owner').selectOption('person');
  await move.getByLabel('Their handle').fill(`@${benHandle}`);
  await move.getByRole('button', { name: 'Move' }).click();
  await eventually('moved to Ben', async () => {
    const b = await read<{ ownerKey: string; access: Record<string, string> }>(`boards/${mine.id}`);
    return b?.ownerKey === `user:${ben.uid}` && b.access[ada.uid] === 'admin' ? true : null;
  });
  // In the sidebar it now sits under Ben (once: nothing is listed twice).
  await expect(users.locator(`[data-board="${mine.key}"]`)).toHaveCount(1);
});
