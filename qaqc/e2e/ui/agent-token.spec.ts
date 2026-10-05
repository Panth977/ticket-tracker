/**
 * ONE TOKEN PER AGENT, end to end (docs/plan/agents.html §AA): the owner
 * generates the agent's one token; with it the agent works on two boards under
 * two different roles, creates an artifact that its owner sees at once, fills
 * that artifact's database through the data API, and the page in the owner's
 * browser reads those same documents through window.BackendDriver.
 */
import { expect, test } from '@playwright/test';
import { API_URL, call, newBoard, newPerson, WEB_URL } from '../support/stack.js';
import { signIn } from '../support/ui.js';

const SHOTS = process.env.TM_SHOTS ?? '';

test('an agent: one token, a role per board, build + data on an artifact', async ({ page }) => {
  const { createClient, serverTime } = (await import('../../../sdk/dist/sdk.js' as string)) as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the built SDK, imported untyped
    createClient: (o: { token: string; baseUrl: string; board?: string }) => any;
    serverTime: unknown;
  };
  const owner = await newPerson('Panth');
  const reads = await newBoard(owner, { name: 'Read only here' });
  const owns = await newBoard(owner, { name: 'Runs this one' });
  const { agentId } = await call(owner, 'agentCreate', { name: 'Claude Social', icon: 'claude' });
  await call(owner, 'boardAgentSet', { boardId: reads.id, agentId, role: 'viewer' });
  await call(owner, 'boardAgentSet', { boardId: owns.id, agentId, role: 'admin' });

  // THE one token: no board, no scopes.
  const { key: token } = await call(owner, 'apiKeyCreate', {
    name: 'Claude Social',
    kind: 'agent',
    actsAs: { kind: 'agent', id: agentId },
  });
  const tm = createClient({ token, baseUrl: API_URL });

  // A role per board: it creates where it is admin, and only reads where it is a viewer.
  const made = await tm.board(owns.key).tickets.create({ title: 'by the agent' });
  expect(made.key).toContain(owns.key);
  await expect(tm.board(reads.key).tickets.create({ title: 'nope' })).rejects.toMatchObject({
    status: 403,
  });
  await tm.board(reads.key).tickets.list(); // reading is allowed there
  // Two boards and no default: a call that names none is told which exist.
  await expect(tm.tickets.list()).rejects.toMatchObject({ status: 400 });

  // It creates an artifact: its OWNER owns it, the agent builds and writes data.
  const art = await tm.artifacts.create({ name: 'Reach & Research' });
  expect(art.owner_id).toBe(owner.uid);
  const driver = '<script src="' + WEB_URL + '/backend-driver/v1/driver.js"></script>';
  await tm.artifacts.publish(art.id, {
    'index.html':
      '<body style="font-family:sans-serif;background:#fff;padding:24px"><h1>Reach</h1><ul id="rows"></ul>' +
      driver +
      '<script>BackendDriver.ready.then(()=>BackendDriver.firestore.onList("/reach",{orderBy:["day","asc"]},(d)=>{rows.innerHTML=d.map(x=>"<li>"+x.id+": "+x.data.reach+" @ "+(x.data.at instanceof Date)+"</li>").join("")}))</script>',
  });
  const data = tm.artifacts.data(art.id);
  const res = await data.firestore.batch([
    {
      op: 'set',
      path: '/reach/2026-09-29',
      data: { day: 1, reach: 1357, at: new Date('2026-09-29T05:30:00Z') },
    },
    { op: 'set', path: '/reach/2026-09-30', data: { day: 2, reach: 1502, at: serverTime } },
  ]);
  expect(res.written).toBe(2);
  const back = await data.firestore.get('/reach/2026-09-29');
  expect(back.data.reach).toBe(1357);
  expect(back.data.at).toBeInstanceOf(Date);
  await data.rtdb.set('/status', { lastRun: 'ok' });
  expect(await data.rtdb.get('/status')).toEqual({ lastRun: 'ok' });
  // the fence holds for a token too
  await expect(data.firestore.get('/tickets/t1')).rejects.toThrow();

  // The owner sees it, and the PAGE reads what the agent wrote.
  await signIn(page, owner.email, `/x/${art.id}`);
  const frame = page.frameLocator('iframe[sandbox]');
  await expect(frame.locator('#rows li')).toHaveText([
    '2026-09-29: 1357 @ true',
    '2026-09-30: 1502 @ true',
  ]);
  await expect(page.getByLabel('Sidebar').getByText('Reach & Research')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/aa-1-artifact.png` });

  // Data only on this one: the owner turns Build off; the agent can no longer publish, still writes data.
  await call(owner, 'artifactShare', {
    artifactId: art.id,
    agentId,
    agentAccess: { build: false, data: 'write' },
  });
  await expect(tm.artifacts.publish(art.id, { 'index.html': 'x' })).rejects.toMatchObject({
    status: 403,
  });
  await data.firestore.set('/reach/2026-10-01', { day: 3, reach: 1600, at: serverTime });
  await expect(frame.locator('#rows li')).toHaveCount(3);

  // The agent's page: the one token, and its access.
  await page.goto(`/agents/${agentId}`);
  const main = page.locator('#main');
  await expect(main.getByText('Read only here')).toBeVisible();
  await expect(main.getByText('Runs this one')).toBeVisible();
  await expect(main.getByText('Reach & Research').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /regenerate/i })).toBeVisible();
  if (SHOTS) {
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SHOTS}/aa-2-agent.png`, fullPage: true });
    await page.goto('/account/tokens');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SHOTS}/aa-3-tokens.png`, fullPage: true });
    await page.goto(`/x/${art.id}/settings/people`);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SHOTS}/aa-4-artifact-people.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`/agents/${agentId}`);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SHOTS}/aa-5-agent-phone.png`, fullPage: true });
  }
});
