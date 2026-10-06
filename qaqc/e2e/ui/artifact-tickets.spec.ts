/**
 * BOARD TICKETS IN AN ARTIFACT, end to end (docs/plan/artifacts.html §K): a
 * real build reads and writes a board's tickets through
 * window.BackendDriver.tickets, in the real host page, as three people:
 *
 *   the owner         grant 'write' + board admin   → sees and creates tickets
 *   a board viewer    grant 'write' + board viewer  → sees them; writes refused
 *   not on the board  (artifact viewer only)        → sees nothing
 *
 * Reads go past the ticket list too: a ticket's thread (live) and the board's
 * aggregate buckets, under the same fence.
 *
 * The grant is a ceiling and the viewer's own board role the floor; a board
 * that was never granted is refused even to its admin.
 */
import { expect, test } from '@playwright/test';
import {
  call,
  doc,
  eventually,
  inviteAndAccept,
  newBoard,
  newPerson,
  read,
  WEB_URL,
} from '../support/stack.js';
import { signIn } from '../support/ui.js';

const INDEX = `<!doctype html>
<meta charset="utf-8">
<title>Tickets dashboard</title>
<p>boards: <b id="boards">?</b> · canWrite: <b id="canWrite">?</b></p>
<p>other: <b id="other">?</b> · error: <b id="error"></b></p>
<button id="create">Create</button>
<ul id="tickets"></ul>
<p>thread: <b id="thread">?</b> · live: <b id="live">?</b> · otherThread: <b id="otherThread">?</b></p>
<p>agg: <b id="agg">?</b> · fields: <b id="aggFields">?</b> · ticketAggs: <b id="ticketAggs">?</b></p>
<script src="${WEB_URL}/backend-driver/v1/driver.js"></script>
<script>
(async () => {
  const $ = (id) => document.getElementById(id);
  const db = window.BackendDriver;
  await db.ready;
  const boards = await db.tickets.boards();
  $('boards').textContent = boards.map((b) => b.key + ':' + b.access).join(',') || 'none';
  const board = boards[0];
  $('canWrite').textContent = String(!!board && board.canWrite);
  const fail = (e) => { $('error').textContent = (e && e.code) || String(e); };
  if (board)
    db.tickets.onList(board.key, { orderBy: 'created' }, (ts) => {
      $('tickets').innerHTML = ts.map((t) => '<li>' + t.key + ' ' + t.title + ' @' + t.stage.name + '</li>').join('');
    }, fail);
  const OTHER = new URLSearchParams(location.hash.slice(1)).get('other') || 'NOPE';
  try { await db.tickets.list(OTHER); $('other').textContent = 'OPEN'; }
  catch (e) { $('other').textContent = e.code; }
  try { await db.tickets.thread(OTHER + '-1'); $('otherThread').textContent = 'OPEN'; }
  catch (e) { $('otherThread').textContent = e.code; }
  if (board) {
    const key = board.key + '-1';
    const show = (ms) => ms.map((m) => m.kind + ':' + (m.agg ? m.agg.entries.map((e) => e.label + '=' + e.value).join(',') : m.markdown)).join(' | ');
    db.tickets.thread(key).then((ms) => { $('thread').textContent = show(ms); }, fail);
    db.tickets.onThread(key, (ms) => { $('live').textContent = String(ms.length); }, fail);
    $('aggFields').textContent = board.aggFields.map((f) => f.label + '/' + f.period).join(',');
    db.tickets.get(key).then((t) => { $('ticketAggs').textContent = JSON.stringify(t.aggs.cost || null); }, fail);
    db.tickets.aggregates(board.key, { field: 'Cost' }).then((a) => {
      $('agg').textContent = a.total + '/' + a.count + '/' + a.lifetime.total + '/' + a.buckets.map((b) => Object.keys(b.tickets).join('+')).join(',');
    }, fail);
  }
  $('create').onclick = () =>
    board && db.tickets.create(board.key, { title: 'From the dashboard', stage: board.stages[1].name, assignees: ['me'] })
      .then((r) => db.tickets.comment(r.key, 'made by **the dashboard**'))
      .catch(fail);
})();
</script>`;

test('§K: an artifact reads and writes board tickets within the grant and the viewer’s role', async ({
  page,
  browser,
}) => {
  const owner = await newPerson('Olive');
  const boardViewer = await newPerson('Vik');
  const outsider = await newPerson('Oscar');
  const eng = await newBoard(owner, { name: 'Engineering' });
  const other = await newBoard(owner, { name: 'Other' }); // the owner's, never granted
  await inviteAndAccept(owner, eng.id, boardViewer, 'viewer');
  const existing = await call(owner, 'ticketCreate', { boardId: eng.id, title: 'Existing ticket' });
  // Its thread: a comment (Markdown) and an entry on the board's Cost field.
  await call(owner, 'messagePost', {
    boardId: eng.id,
    ticketId: existing.ticketId,
    body: doc(['Hello from Olive']),
    markdown: 'Hello from **Olive**',
  });
  await call(owner, 'messagePost', {
    boardId: eng.id,
    ticketId: existing.ticketId,
    body: doc(['logged']),
    agg: { entries: [{ fieldId: 'cost', value: 1.25 }] },
  });

  const { artifactId } = await call(owner, 'artifactCreate', { name: 'Tickets dashboard' });
  await call(owner, 'artifactPublish', {
    artifactId,
    message: 'v1',
    files: [{ path: 'index.html', content: INDEX.replace("|| 'NOPE'", `|| '${other.key}'`) }],
  });
  await call(owner, 'artifactBoardAccessSet', { artifactId, boardId: eng.id, access: 'write' });
  for (const p of [boardViewer, outsider])
    await call(owner, 'artifactShare', { artifactId, email: p.email, role: 'viewer' });

  // ── the owner: sees the board, may write, and the ungranted board is refused ──
  await signIn(page, owner.email, `/x/${artifactId}`);
  const f = page.frameLocator('iframe[sandbox]');
  await expect(f.locator('#boards')).toHaveText(`${eng.key}:write`);
  await expect(f.locator('#canWrite')).toHaveText('true');
  await expect(f.locator('#other')).toHaveText('permission-denied');
  await expect(f.locator('#tickets li')).toHaveText([
    `${eng.key}-1 Existing ticket @${eng.stages[0]!.name}`,
  ]);
  await f.locator('#create').click();
  await expect(f.locator('#tickets li')).toHaveCount(2);
  await expect(f.locator('#tickets li').first()).toContainText('From the dashboard'); // 'created' = newest first
  await expect(f.locator('#error')).toHaveText('');
  // ── reads past the list: the thread (live) and the aggregate buckets ─────────
  await expect(f.locator('#thread')).toHaveText('comment:Hello from **Olive** | agg:Cost=1.25');
  await expect(f.locator('#live')).toHaveText('2');
  await expect(f.locator('#otherThread')).toHaveText('permission-denied');
  await expect(f.locator('#aggFields')).toContainText('Cost/daily');
  await expect(f.locator('#ticketAggs')).toHaveText('{"total":1.25,"count":1}');
  await expect(f.locator('#agg')).toHaveText(`1.25/1/1.25/${eng.key}-1`);
  await call(owner, 'messagePost', {
    boardId: eng.id,
    ticketId: existing.ticketId,
    body: doc(['One more']),
  });
  await expect(f.locator('#live')).toHaveText('3');
  // It is a real ticket, by the owner, with the comment on it (posted right after the create).
  const created = await eventually('ticket with its comment', async () => {
    const k = await read<{ ticketId: string }>(`keys/${eng.key}-2`);
    const t =
      k &&
      (await read<{ title: string; assigneeUids: string[]; counts: { messages: number } }>(
        `boards/${eng.id}/tickets/${k.ticketId}`,
      ));
    return t && t.counts.messages > 0 ? t : null;
  });
  expect(created).toMatchObject({ title: 'From the dashboard', assigneeUids: [owner.uid] });

  // ── a board viewer: sees the tickets, live; the write grant cannot lift their role ──
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await signIn(page2, boardViewer.email, `/x/${artifactId}`);
  const f2 = page2.frameLocator('iframe[sandbox]');
  await expect(f2.locator('#boards')).toHaveText(`${eng.key}:write`);
  await expect(f2.locator('#canWrite')).toHaveText('false');
  // A board viewer reads the thread and the buckets too (reads need no write role).
  await expect(f2.locator('#agg')).toHaveText(`1.25/1/1.25/${eng.key}-1`);
  await expect(f2.locator('#live')).toHaveText('3');
  await expect(f2.locator('#tickets li')).toHaveCount(2);
  await f2.locator('#create').click();
  await expect(f2.locator('#error')).toHaveText('permission-denied');
  await expect(f.locator('#tickets li')).toHaveCount(2);

  // ── not on the board: the grant gives them nothing ─────────────────────────
  const ctx3 = await browser.newContext();
  const page3 = await ctx3.newPage();
  await signIn(page3, outsider.email, `/x/${artifactId}`);
  const f3 = page3.frameLocator('iframe[sandbox]');
  await expect(f3.locator('#boards')).toHaveText('none');
  await expect(f3.locator('#tickets li')).toHaveCount(0);

  // ── the owner takes the grant away: the page loses the board ────────────────
  await call(owner, 'artifactBoardAccessSet', { artifactId, boardId: eng.id, access: null });
  await page.reload();
  await expect(f.locator('#boards')).toHaveText('none');

  await ctx2.close();
  await ctx3.close();
});
