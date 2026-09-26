/**
 * PHASE 12 END TO END (docs/plan/agents.html § S) — INSTALLABLE.
 *
 * "Installable" is a test here, not a claim. Everything below runs against the
 * PRODUCTION build served as Firebase Hosting serves it (static files, every
 * unknown path rewritten to index.html) — `vite dev` would prove nothing: it
 * registers the worker as a module, ships no precache list, and serves the app
 * as hundreds of live module requests that can never work offline.
 *
 *   manifest   reachable, valid, and saying the things a browser needs to
 *              offer an install (id, scope, start_url, display, icons)
 *   icons      present at every declared size, and actually that size —
 *              including the maskable one Android crops
 *   one worker exactly one registration owns scope '/', and it is the merged
 *              one (it importScripts the Firebase Messaging worker, § S)
 *   offline    a second visit with the network cut still renders the app, and
 *              the offline page is there for the visit that never got that far
 */
import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BUILD = join(ROOT, 'frontend/build');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** The build, on demand: a fresh checkout has no frontend/build. */
function ensureBuild() {
  if (
    existsSync(join(BUILD, 'service-worker.js')) &&
    existsSync(join(BUILD, 'manifest.webmanifest'))
  )
    return;
  const r = spawnSync('pnpm', ['--filter', '@tm/frontend', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error('could not build the SPA for the installability check');
}

/**
 * frontend/build the way hosting serves it. Deliberately NOT the dev server:
 * the point is the artefact that ships.
 */
function serveBuild(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // normalize() + the prefix check is the whole path-traversal defence needed here.
    const asked = join(BUILD, normalize(decodeURIComponent(url.pathname)));
    const file =
      asked.startsWith(BUILD) && existsSync(asked) && statSync(asked).isFile()
        ? asked
        : join(BUILD, 'index.html'); // firebase.json: ** → /index.html
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': String(body.length),
    });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/*
 * qaqc's tsconfig has no DOM lib (it is a Node project), so the handful of
 * browser globals the page.evaluate() bodies touch are declared here. `document`
 * is module-scoped; `navigator` already exists in Node's types, so it is cast
 * where it is used.
 */
interface El {
  getAttribute(name: string): string | null;
}
declare const document: {
  body: { innerText: string };
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): ArrayLike<El> & Iterable<El>;
};
/** A PNG's real size, straight out of its IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.subarray(0, 8).equals(signature), 'not a PNG').toBe(true);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Wait until the app's worker is installed, active and driving the page. */
async function serviceWorkerReady(page: Page) {
  await page.waitForFunction(
    async () => {
      const sw = (
        navigator as unknown as {
          serviceWorker: { ready: Promise<{ active: unknown }>; controller: unknown };
        }
      ).serviceWorker;
      const reg = await sw.ready;
      return !!reg.active && !!sw.controller;
    },
    undefined,
    { timeout: 30_000 },
  );
}

interface Manifest {
  id: string;
  name: string;
  short_name: string;
  scope: string;
  start_url: string;
  display: string;
  orientation: string;
  lang: string;
  theme_color: string;
  background_color: string;
  categories: string[];
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
  shortcuts: { name: string; url: string }[];
}

let site: { origin: string; close: () => Promise<void> };

test.beforeAll(async () => {
  test.setTimeout(300_000); // the first run may have to build the SPA
  ensureBuild();
  site = await serveBuild();
});
test.afterAll(async () => site?.close());

// This suite never signs in and never touches the emulators; it is about the
// shell a browser installs, which exists before anyone has an account.
test.describe('§S installable', () => {
  test('the manifest is reachable and says what a browser needs', async ({ request }) => {
    const res = await request.get(`${site.origin}/manifest.webmanifest`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('manifest+json');

    const m: Manifest = JSON.parse(await res.text());
    expect(m.name).toBe('TaskManager');
    expect(m.short_name).toBe('Tasks');
    // `id` is what an update is matched against: without it a redeploy can install twice.
    expect(m.id).toBe('/');
    expect(m.scope).toBe('/');
    expect(m.display).toBe('standalone');
    expect(m.orientation).toBe('portrait-primary');
    expect(m.lang).toBe('en');
    expect(m.categories.length).toBeGreaterThan(0);
    // Colours for the app window, and a start_url that marks an installed launch.
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    const start = new URL(m.start_url, site.origin);
    expect(start.pathname).toBe('/');
    expect(start.searchParams.get('source')).toBe('pwa');
  });

  test('every icon exists, at the size it claims, including a maskable one', async ({
    request,
  }) => {
    const m: Manifest = JSON.parse(
      await (await request.get(`${site.origin}/manifest.webmanifest`)).text(),
    );
    const pngs = m.icons.filter((i) => i.type === 'image/png');
    expect(pngs.map((i) => i.sizes).sort()).toEqual([
      '192x192',
      '256x256',
      '384x384',
      '512x512',
      '512x512',
    ]);

    for (const icon of pngs) {
      const res = await request.get(new URL(icon.src, site.origin).href);
      expect(res.status(), `${icon.src} is missing`).toBe(200);
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(pngSize(Buffer.from(await res.body())), `${icon.src} is not ${icon.sizes}`).toEqual({
        width: w,
        height: h,
      });
    }

    // Android crops this one to its own shape, so it must exist at 512 and be
    // declared maskable — a plain icon cropped into a circle loses its corners.
    const maskable = m.icons.find((i) => i.purpose === 'maskable');
    expect(maskable?.sizes).toBe('512x512');

    // iOS ignores the manifest and reads the <link> instead.
    const apple = await request.get(`${site.origin}/icons/apple-touch-icon-180.png`);
    expect(apple.status()).toBe(200);
    expect(pngSize(Buffer.from(await apple.body()))).toEqual({ width: 180, height: 180 });
  });

  test('the three app shortcuts are Inbox, My work and New ticket', async ({ request }) => {
    const m: Manifest = JSON.parse(
      await (await request.get(`${site.origin}/manifest.webmanifest`)).text(),
    );
    expect(m.shortcuts.map((s) => s.name)).toEqual(['Inbox', 'My work', 'New ticket']);
    for (const s of m.shortcuts) {
      const url = new URL(s.url, site.origin);
      expect(url.origin).toBe(site.origin); // inside the scope, or the launcher drops it
      const res = await request.get(url.href);
      expect(res.status(), `${s.url} does not resolve`).toBe(200);
    }
  });

  test('the page links the manifest and carries the iOS metas', async ({ page }) => {
    await page.goto(`${site.origin}/`);
    const head = await page.evaluate(() => ({
      manifest: document.querySelector('link[rel=manifest]')?.getAttribute('href') ?? null,
      touchIcon: document.querySelector('link[rel=apple-touch-icon]')?.getAttribute('href') ?? null,
      viewport: document.querySelector('meta[name=viewport]')?.getAttribute('content') ?? '',
      capable:
        document
          .querySelector('meta[name=apple-mobile-web-app-capable]')
          ?.getAttribute('content') ?? null,
      statusBar:
        document
          .querySelector('meta[name=apple-mobile-web-app-status-bar-style]')
          ?.getAttribute('content') ?? null,
      themeColors: [...document.querySelectorAll('meta[name=theme-color]')].map((el) => ({
        content: el.getAttribute('content'),
        media: el.getAttribute('media'),
      })),
    }));
    // Resolved, not compared raw: the browser hands these back absolute once the
    // SPA has hydrated, and %sveltekit.assets% could add a prefix.
    expect(head.manifest && new URL(head.manifest, site.origin).pathname).toBe(
      '/manifest.webmanifest',
    );
    expect(head.touchIcon && new URL(head.touchIcon, site.origin).pathname).toBe(
      '/icons/apple-touch-icon-180.png',
    );
    // Under the notch: every fixed bar pads itself with env(safe-area-inset-*).
    expect(head.viewport).toContain('viewport-fit=cover');
    expect(head.capable).toBe('yes');
    expect(head.statusBar).toBeTruthy();
    // One theme colour for light, one for dark.
    expect(head.themeColors.filter((t) => t.media?.includes('light'))).toHaveLength(1);
    expect(head.themeColors.filter((t) => t.media?.includes('dark'))).toHaveLength(1);
  });

  test('one merged worker owns the scope', async ({ page, request }) => {
    await page.goto(`${site.origin}/`);
    await serviceWorkerReady(page);

    const regs = await page.evaluate(async () => {
      // Everything the evaluate body needs must be INSIDE it: Playwright ships
      // the function to the browser, not this file's scope.
      type Reg = { scope: string; active: { scriptURL: string } | null };
      const sw = (navigator as unknown as { serviceWorker: { getRegistrations(): Promise<Reg[]> } })
        .serviceWorker;
      const list = await sw.getRegistrations();
      return list.map((r) => ({ scope: r.scope, script: r.active?.scriptURL ?? null }));
    });
    // Two workers at one scope fight over the registration — there is one.
    expect(regs).toHaveLength(1);
    expect(regs[0]!.scope).toBe(`${site.origin}/`);
    expect(regs[0]!.script).toBe(`${site.origin}/service-worker.js`);

    // …and it is the merged one: push lives in the Firebase Messaging worker,
    // which the app's worker pulls in rather than registering separately.
    const source = await (await request.get(`${site.origin}/service-worker.js`)).text();
    expect(source).toContain('importScripts');
    expect(source).toContain('/firebase-messaging-sw.js');
  });

  test('a second visit works with the network cut, and the offline page is there for the first', async ({
    page,
    context,
  }) => {
    // A module the precache missed does not fail loudly — the app simply never
    // boots — so the missing-chunk error is an assertion of its own.
    const missing: string[] = [];
    page.on('pageerror', (e) => {
      if (/dynamically imported module/i.test(e.message)) missing.push(e.message);
    });

    await page.goto(`${site.origin}/`);
    await serviceWorkerReady(page); // the precache finishes inside `install`

    await context.setOffline(true);
    try {
      const res = await page.goto(`${site.origin}/inbox`); // any route: one shell serves them all
      expect(res?.status()).toBe(200);

      // The shell itself, not the "you are offline" stand-in.
      await expect(page.locator('link[rel=manifest]')).toHaveCount(1);
      await expect(page.locator('body')).not.toContainText('hasn’t finished downloading');

      // …and the app really ran: it rendered a screen with no network at all.
      await expect
        .poll(() => page.evaluate(() => document.body.innerText.trim().length), { timeout: 20_000 })
        .toBeGreaterThan(40);
      await expect(page).toHaveTitle(/TaskManager/);
      expect(missing, 'a build asset is missing from the precache').toEqual([]);

      // And the last-resort page is cached too, for the visit that never got this far.
      await page.goto(`${site.origin}/offline.html`);
      await expect(page.locator('h1')).toHaveText(/offline/i);
    } finally {
      await context.setOffline(false);
    }
  });
});
