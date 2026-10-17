/**
 * THE VM BUILD ON A REAL NETWORK: what a deploy behind a proxy sees and the
 * local suite does not. A TCP proxy in front of the VM server holds every new
 * connection back for a moment, the way TLS and a hop through nginx do, so a
 * WebSocket is still connecting when the page signs in.
 *
 *   - the sign-in link opened in a SECOND tab: both tabs end signed in, the
 *     profile loads (no request left hanging), nobody is thrown back to /login;
 *   - static files come compressed.
 *
 * VM only (TM_E2E_PLATFORM=vm): Firebase's SDK and Hosting are not ours to test.
 */
import { createServer, connect, type Server } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { mailTo, eventually, uniqueEmail } from '../support/stack.js';
import { VM, VM_PORT } from '../../seed/vm.js';

test.skip(!VM, 'the VM build only');

const DELAY_MS = 600;
const PROXY_PORT = VM_PORT + 1;
const ORIGIN = `http://127.0.0.1:${PROXY_PORT}`;
let proxy: Server;

test.beforeAll(async () => {
  proxy = createServer((client) => {
    client.pause();
    setTimeout(() => {
      const upstream = connect(VM_PORT, '127.0.0.1');
      client.pipe(upstream).pipe(client);
      client.resume();
      const end = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', end);
      upstream.on('error', end);
    }, DELAY_MS);
  });
  await new Promise<void>((ok) => proxy.listen(PROXY_PORT, '127.0.0.1', ok));
});
test.afterAll(() => new Promise<void>((ok) => proxy.close(() => ok())));

test('sign-in link opened in a second tab, over a slow link: both tabs signed in, nothing hangs', async ({
  context,
}) => {
  const email = uniqueEmail('slow');
  const warnings: string[] = [];
  const watch = (p: Page, tab: string) =>
    p.on('console', (m) => {
      if (/WebSocket|Maximum call stack/i.test(m.text())) warnings.push(`${tab}: ${m.text()}`);
    });

  const first = await context.newPage();
  watch(first, 'first');
  await first.goto(`${ORIGIN}/login`);
  await first.getByLabel('Email').fill(email);
  await first.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(first.getByText('We sent a sign-in link')).toBeVisible();

  const link = await eventually('sign-in link', async () => {
    const m = (await mailTo(email)).find((x) => x.subject === 'Sign in to TaskManager');
    return m ? /https?:\/\/\S+tm_link=\S+/.exec(m.text ?? '')![0] : null;
  });
  const second = await context.newPage();
  watch(second, 'second');
  await second.goto(link.replace(/^https?:\/\/[^/]+/, ORIGIN));

  // The new account lands on Welcome in the tab that opened the link…
  await expect(second).toHaveURL(/\/welcome/, { timeout: 30_000 });
  await second.getByLabel('Display name').fill('Slow Link');
  await second.getByRole('button', { name: 'Continue' }).click();
  await expect(second.getByRole('heading', { name: 'Start your first board' })).toBeVisible();

  // …and the first tab follows it in, and stays in.
  await expect(first).not.toHaveURL(/\/login/, { timeout: 30_000 });

  // A reload keeps the session, and the profile (a live listener) loads.
  for (const p of [first, second]) {
    await p.goto(`${ORIGIN}/account/profile`);
    await expect(p).toHaveURL(/\/account\/profile/);
    await expect(p.getByLabel(/name/i).first()).toHaveValue('Slow Link', { timeout: 20_000 });
  }
  expect(warnings).toEqual([]);
});

test('static files are served compressed', async ({ request }) => {
  const html = await (await request.get(`${ORIGIN}/`)).text();
  const scripts = [...html.matchAll(/\/_app\/immutable\/[^"']+\.js/g)].map((m) => m[0]);
  const encodings = await Promise.all(
    scripts.map(async (js) => {
      const res = await request.fetch(`${ORIGIN}${js}`, { headers: { 'accept-encoding': 'br, gzip' } });
      expect(res.status()).toBe(200);
      return res.headers()['content-encoding'];
    }),
  );
  // Anything over 1 KB is brotli; the tiny entry stubs may go as they are.
  expect(encodings).toContain('br');
});

test('a socket that reconnects with an expired token stays signed in (no trip to /welcome)', async ({
  context,
}) => {
  // The laptop slept: the /live socket dropped, and the page reconnects still
  // holding the ID token that lapsed in the meantime. The route below plays
  // that: after `stale` is set, the first auth frame carries a dead token.
  let stale = false;
  const sockets: { close: () => Promise<void> }[] = [];
  await context.routeWebSocket(/\/live$/, (ws) => {
    const server = ws.connectToServer();
    sockets.push(ws);
    ws.onMessage((m) => {
      const f = JSON.parse(String(m)) as { op?: string; token?: string };
      if (stale && f.op === 'auth' && f.token) {
        stale = false;
        server.send(JSON.stringify({ ...f, token: 'expired.id.token' }));
      } else server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });

  const email = uniqueEmail('wake');
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByText('We sent a sign-in link')).toBeVisible();
  const link = await eventually('sign-in link', async () => {
    const m = (await mailTo(email)).find((x) => x.subject === 'Sign in to TaskManager');
    return m ? /https?:\/\/\S+tm_link=\S+/.exec(m.text ?? '')![0] : null;
  });
  await page.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await expect(page).toHaveURL(/\/welcome/, { timeout: 30_000 });
  await page.getByLabel('Display name').fill('Woke Up');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Start your first board' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page).not.toHaveURL(/\/welcome/);
  await page.goto('/account/profile');
  await expect(page).toHaveURL(/\/account\/profile/);
  await expect(page.getByLabel(/name/i).first()).toHaveValue('Woke Up', { timeout: 20_000 });

  // Network drops; the page reconnects with the lapsed token.
  stale = true;
  const before = sockets.length;
  await sockets.at(-1)!.close();
  await expect.poll(() => sockets.length, { timeout: 20_000 }).toBeGreaterThan(before);
  await expect.poll(() => stale, { timeout: 20_000 }).toBe(false); // the dead token went out

  // Still here, still signed in, and the profile listener still live.
  await page.waitForTimeout(3000);
  await expect(page).toHaveURL(/\/account\/profile/);
  await expect(page.getByLabel(/name/i).first()).toHaveValue('Woke Up');
  await page.goto('/');
  await page.waitForTimeout(1500);
  await expect(page).not.toHaveURL(/\/welcome|\/login/);
});
