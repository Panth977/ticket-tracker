/**
 * ARTIFACTS, end to end (docs/plan/artifacts.html §J8): a real build, published
 * through the command, opened in the real host page inside its sandboxed
 * iframe, talking to Firestore / RTDB / kv through window.BackendDriver and
 * the broker — as the owner and as a viewer in a second browser.
 *
 * What this proves that the unit and rules suites cannot:
 *   - the capability URL actually serves the build (and its relative asset)
 *   - the driver's handshake reaches the host across the opaque origin
 *   - a write in one browser arrives live in the other
 *   - read-only and removal bite in the running page
 *   - the artifact's code cannot reach the app's storage (the sandbox holds)
 */
import { expect, test, type Page } from '@playwright/test';
import { call, newPerson, WEB_URL } from '../support/stack.js';
import { signIn } from '../support/ui.js';

const INDEX = `<!doctype html>
<meta charset="utf-8">
<title>E2E artifact</title>
<link rel="stylesheet" href="./assets/app.css">
<h1 id="title">loading…</h1>
<p>role: <b id="role">?</b> · readOnly: <b id="ro">?</b> · mock: <b id="mock">?</b></p>
<p>sandbox: <b id="sandbox">?</b></p>
<p>kv: <b id="kv">?</b> · rtdb: <b id="rtdb">?</b> · styled: <b id="styled">?</b></p>
<button id="add">Add item</button> <button id="bump">Bump</button>
<p id="error"></p>
<ul id="items"></ul>
<script src="${WEB_URL}/backend-driver/v1/driver.js"></script>
<script src="./assets/app.js"></script>`;

const APP_JS = `(async () => {
  const $ = (id) => document.getElementById(id);
  const db = window.BackendDriver;
  // The sandbox: an opaque origin has no storage of its own, let alone the app's.
  let storage = 'blocked';
  try { localStorage.setItem('x', '1'); storage = 'OPEN'; } catch {}
  let idb = 'blocked';
  try { await new Promise((ok, no) => { const r = indexedDB.open('firebaseLocalStorageDb'); r.onsuccess = () => ok(); r.onerror = () => no(r.error); }); idb = 'OPEN'; } catch {}
  $('sandbox').textContent = 'localStorage ' + storage + ', indexedDB ' + idb + ', origin ' + self.origin;
  await db.ready;
  $('title').textContent = db.artifact.name;
  $('role').textContent = db.me.role;
  $('ro').textContent = String(db.me.readOnly);
  $('mock').textContent = String(db.mock);
  $('styled').textContent = getComputedStyle($('title')).color === 'rgb(1, 2, 3)' ? 'yes' : 'no';
  db.on('readonly', (v) => { $('ro').textContent = String(v); });
  const fail = (e) => { $('error').textContent = (e && e.code) + ''; };
  db.firestore.onList('/items', { orderBy: ['at', 'asc'] }, (docs) => {
    $('items').innerHTML = docs.map((d) => '<li>' + d.data.text + ' (' + d.data.by + ')</li>').join('');
  }, fail);
  db.rtdb.on('/counter', (v) => { $('rtdb').textContent = String(v ?? 0); }, fail);
  await db.kv.set('seen', db.me.uid);
  $('kv').textContent = (await db.kv.get('seen')) === db.me.uid ? 'ok' : 'WRONG';
  let n = 0;
  $('add').onclick = () => db.firestore.add('/items', { text: 'item ' + (++n), by: db.me.role, at: db.serverTime }).catch(fail);
  $('bump').onclick = async () => { try { await db.rtdb.set('/counter', ((await db.rtdb.get('/counter')) ?? 0) + 1); } catch (e) { fail(e); } };
  // The fence: none of these may reach anything.
  for (const bad of ['../../../users/x', '/a/../b', '/tickets/t1']) {
    try { await db.firestore.get(bad); $('error').textContent = 'ESCAPED ' + bad; } catch {}
  }
})();`;

async function openArtifact(page: Page, email: string, id: string) {
  await signIn(page, email, `/x/${id}`);
  return page.frameLocator('iframe[sandbox]');
}

test('an artifact: publish, open, live data between two people, read-only, removal', async ({
  page,
  browser,
}) => {
  const owner = await newPerson('Olive');
  const viewer = await newPerson('Vik');
  const stranger = await newPerson('Sam');

  const { artifactId } = await call(owner, 'artifactCreate', { name: 'E2E dashboard' });
  const pub = await call(owner, 'artifactPublish', {
    artifactId,
    message: 'first',
    files: [
      { path: 'index.html', content: INDEX },
      { path: 'assets/app.js', content: APP_JS },
      { path: 'assets/app.css', content: '#title{color:rgb(1,2,3)}' },
    ],
  });
  expect(pub.files).toBe(3);
  expect(pub.warnings).toEqual([]);

  // ── the owner opens it ────────────────────────────────────────────────────
  const frame = await openArtifact(page, owner.email, artifactId);
  await expect(frame.locator('#title')).toHaveText('E2E dashboard');
  await expect(frame.locator('#role')).toHaveText('owner');
  await expect(frame.locator('#mock')).toHaveText('false');
  await expect(frame.locator('#styled')).toHaveText('yes'); // the relative asset loaded
  await expect(frame.locator('#kv')).toHaveText('ok');
  await expect(frame.locator('#sandbox')).toContainText('localStorage blocked, indexedDB blocked');
  await expect(frame.locator('#sandbox')).toContainText('origin null');
  await expect(frame.locator('#error')).toHaveText('');
  // The iframe never gets allow-same-origin.
  const sandbox = await page.locator('iframe[sandbox]').getAttribute('sandbox');
  expect(sandbox).not.toContain('allow-same-origin');

  await frame.locator('#add').click();
  await expect(frame.locator('#items li')).toHaveText(['item 1 (owner)']);
  await frame.locator('#bump').click();
  await expect(frame.locator('#rtdb')).toHaveText('1');

  // ── a stranger gets nothing ───────────────────────────────────────────────
  await expect(call(stranger, 'artifactOpen', { artifactId })).rejects.toThrow();

  // ── shared with a viewer, in a second browser ─────────────────────────────
  const shared = await call(owner, 'artifactShare', { artifactId, email: viewer.email, role: 'viewer' });
  expect(shared.outcome).toBe('granted');
  const ctx = await browser.newContext();
  const page2 = await ctx.newPage();
  const frame2 = await openArtifact(page2, viewer.email, artifactId);
  await expect(frame2.locator('#role')).toHaveText('viewer');
  await expect(frame2.locator('#items li')).toHaveText(['item 1 (owner)']);
  await expect(frame2.locator('#rtdb')).toHaveText('1');

  // viewer writes → owner sees it live, both stores
  await frame2.locator('#add').click();
  await expect(frame.locator('#items li')).toHaveText(['item 1 (owner)', 'item 1 (viewer)']);
  await frame2.locator('#bump').click();
  await expect(frame.locator('#rtdb')).toHaveText('2');

  // ── read-only for viewers ─────────────────────────────────────────────────
  await call(owner, 'artifactUpdate', { artifactId, readOnly: true });
  await expect(frame2.locator('#ro')).toHaveText('true');
  await frame2.locator('#add').click();
  await expect(frame2.locator('#error')).toHaveText('permission-denied');
  await expect(frame.locator('#items li')).toHaveCount(2);
  // the owner still writes
  await frame.locator('#add').click();
  await expect(frame2.locator('#items li')).toHaveCount(3);

  // ── removal ───────────────────────────────────────────────────────────────
  await call(owner, 'artifactShare', { artifactId, email: viewer.email, role: null });
  await expect(page2.getByText(/no longer have access/i)).toBeVisible();
  await expect(call(viewer, 'artifactOpen', { artifactId })).rejects.toThrow();
  await ctx.close();
});

test('the build is served sandboxed, and only with a valid capability', async () => {
  const owner = await newPerson('Cap');
  const { artifactId } = await call(owner, 'artifactCreate', { name: 'Caps' });
  await call(owner, 'artifactPublish', {
    artifactId,
    files: [{ path: 'index.html', content: '<h1>hi</h1>' }],
  });
  const open = await call(owner, 'artifactOpen', { artifactId });
  expect(new URL(open.contentUrl).origin).not.toBe(new URL(WEB_URL).origin);

  const ok = await fetch(open.contentUrl);
  expect(ok.status).toBe(200);
  expect(await ok.text()).toContain('<h1>hi</h1>');
  const csp = ok.headers.get('content-security-policy') ?? '';
  expect(csp).toContain('sandbox');
  expect(csp).not.toContain('allow-same-origin');
  expect(ok.headers.get('x-content-type-options')).toBe('nosniff');

  // a deep link with no extension falls back to index.html; a missing file is a 404
  expect((await fetch(`${open.contentBase}some/route`)).status).toBe(200);
  expect((await fetch(`${open.contentBase}missing.js`)).status).toBe(404);

  // a tampered capability is refused
  const bad = open.contentUrl.replace(/\/c\/([^/]{8})/, (_m, a: string) => `/c/${a.split('').reverse().join('')}`);
  expect(bad).not.toBe(open.contentUrl);
  expect((await fetch(bad)).status).toBe(403);
});

test('the app: create from the sidebar, the list page, settings for the owner only', async ({ page }) => {
  const owner = await newPerson('Una');
  await signIn(page, owner.email);
  await page.getByRole('button', { name: /new artifact/i }).click();
  await page.getByLabel('Name').fill('Wall dashboard');
  await page.getByRole('button', { name: /^create/i }).click();
  await page.waitForURL(/\/x\/[A-Za-z0-9_-]+$/);
  // nothing published yet → the empty state, not a broken frame
  await expect(page.getByText(/nothing published|no build|publish/i).first()).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sidebar' }).or(page.getByLabel('Sidebar')).getByText('Wall dashboard')).toBeVisible();

  const id = page.url().split('/x/')[1]!;
  await page.goto(`/x/${id}/settings/builds`);
  await expect(page.getByRole('heading', { name: /builds/i })).toBeVisible();
  await page.goto('/x');
  await expect(page.getByText('Wall dashboard').first()).toBeVisible();
});
