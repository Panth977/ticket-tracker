/**
 * PHASE 13 END TO END (docs/plan/agents.html § T) — LOCAL FIRST.
 *
 * "The last known state paints first, the server patches it." Two things are
 * proven here, and one is recorded:
 *
 *   measure   a warm reload, timed from navigation start to (a) the shell and
 *             (b) the board's first card. Printed, and kept in the step log as
 *             the before/after of p13-local-first — the section asks for a
 *             recorded measurement, not an assertion that it feels faster.
 *   offline   a second boot with every Firebase backend unreachable still
 *             renders the shell, the sidebar's boards and the board's cards,
 *             out of the remembered session + Firestore's IndexedDB cache.
 *
 * Only the Firebase hosts are cut, never the app's own origin: `vite dev`
 * serves the modules themselves and a totally dark network would test the
 * service worker (that is § S / pwa.spec.ts), not the local-first boot.
 */
import { expect, test, type Page } from '@playwright/test';
import { call, newBoard, newPerson, stage } from '../support/stack.js';
import { signIn } from '../support/ui.js';

const SHELL = 'aside[aria-label="Sidebar"]';
/**
 * The skeleton the root layout shows while the guard is undecided. Matched by
 * its own attribute, not by aria-busy: the top progress bar (§K) carries the
 * same aria-label, and it is SUPPOSED to be there while a refresh is in flight.
 */
const SPLASH = '[data-splash]';

/*
 * qaqc's tsconfig has no DOM lib (it is a Node project), so the browser globals
 * the page.evaluate() / addInitScript() bodies touch are declared here — the
 * same shape pwa.spec.ts uses. They exist only inside those bodies, which run
 * in the page.
 */
declare const window: {
  __tmMarks?: Record<string, number>;
  /** lib/boot/prewarm's own receipts: when each warmed query had data. */
  __tmBoot?: Record<string, number>;
};
declare const localStorage: {
  getItem(key: string): string | null;
};
declare const document: {
  querySelector(selector: string): unknown;
  addEventListener(type: string, listener: () => void): void;
};
declare const MutationObserver: new (cb: () => void) => {
  observe(
    target: unknown,
    options: { childList: boolean; subtree: boolean; attributes: boolean },
  ): void;
};
interface ShiftEntry {
  value: number;
  hadRecentInput: boolean;
}
declare const PerformanceObserver: new (cb: (list: { getEntries(): ShiftEntry[] }) => void) => {
  observe(options: { type: string; buffered: boolean }): void;
};

/**
 * Arms a boot timer that runs BEFORE any app code: for each selector, the
 * `performance.now()` of the first frame it existed in the DOM. Survives the
 * reload because addInitScript re-runs on every navigation.
 */
async function armMarks(page: Page, selectors: Record<string, string>): Promise<void> {
  await page.addInitScript((sel: Record<string, string>) => {
    const marks: Record<string, number> = {};
    window.__tmMarks = marks;
    const check = () => {
      for (const name of Object.keys(sel)) {
        if (marks[name] === undefined && document.querySelector(sel[name]!))
          marks[name] = performance.now();
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(document, { childList: true, subtree: true, attributes: true });
    check();
    // The module graph itself (hundreds of requests under `vite dev`) is the
    // floor every other mark sits on: record it, so the app's own cost is
    // readable as (mark - dcl) and not confused with Vite's.
    document.addEventListener('DOMContentLoaded', () => (marks.dcl = performance.now()));
    // §T asks for no layout shift when the server's snapshot lands: measure it
    // rather than eyeball it (Chromium's own cumulative layout shift).
    marks.cls = 0;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          if (!e.hadRecentInput) marks.cls = (marks.cls ?? 0) + e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      /* not Chromium */
    }
  }, selectors);
}

async function readMarks(page: Page): Promise<Record<string, number>> {
  return (await page.evaluate(() => window.__tmMarks ?? {})) as Record<string, number>;
}

/** What the boot itself recorded: 'boards 402ms, views 404ms, tickets 407ms'. */
async function readBoot(page: Page): Promise<string> {
  const b = (await page.evaluate(() => window.__tmBoot ?? {})) as Record<string, number>;
  const rows = Object.entries(b).sort((x, y) => x[1] - y[1]);
  return rows.length ? rows.map(([k, v]) => `${k} ${v}ms`).join(', ') : 'nothing prewarmed';
}

/** Cut every Firebase backend (auth, firestore, database, storage, functions). */
async function cutTheServer(page: Page, origin: string): Promise<void> {
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:'))
      return route.continue();
    return route.abort('connectionfailed');
  });
}

const cardOf = (page: Page, key: string) =>
  page.getByRole('button', { name: new RegExp(`^${key} `) }).first();

test('measure: a warm reload paints the shell and the board', async ({ page, baseURL }) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada);
  const { key } = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Cached row',
    stageId: stage(b, 'To do'),
  });

  await signIn(page, ada.email, `/b/${b.key}`);
  await expect(cardOf(page, key)).toBeVisible();

  const selectors = {
    shell: SHELL,
    card: `[role=button][aria-label^="${key} "]`,
    splash: SPLASH,
    main: '#main',
  };
  await armMarks(page, selectors);

  // Three reloads: the first warms whatever the reload itself warms, and the
  // median of the rest is what gets recorded.
  const runs: Record<string, number>[] = [];
  for (let i = 0; i < 3; i++) {
    await page.reload();
    await expect(cardOf(page, key)).toBeVisible();
    runs.push(await readMarks(page));
  }
  const ms = (name: string) => runs.slice(1).map((r) => Math.round(r[name] ?? -1));
  const line = `[local-first] warm reload — dcl ${ms('dcl').join('/')}ms, first render ${ms(
    'splash',
  )
    .map((v) => (v < 0 ? ms('shell') : v))
    .join(
      '/',
    )}ms, shell ${ms('shell').join('/')}ms, main ${ms('main').join('/')}ms, first card ${ms('card').join('/')}ms, splash shown: ${runs
    .slice(1)
    .map((r) => (r.splash === undefined ? 'no' : 'yes'))
    .join('/')} (${baseURL})`;
  const boot = await readBoot(page);
  console.log(line);
  console.log(`[local-first] cached data ready — ${boot}`);
  test.info().annotations.push({ type: 'measure', description: line });
  test.info().annotations.push({ type: 'measure', description: boot });

  for (const r of runs.slice(1)) {
    // The reload must not be waiting on the network for either of them...
    expect(r.card).toBeLessThan(10_000);
    // ...it must not show the first-visit skeleton at all (§T)...
    expect(
      r.splash,
      'a remembered reload must never show the first-visit skeleton',
    ).toBeUndefined();
    // ...and the server's snapshot must land without moving anything (§T, §K).
    expect(r.cls ?? 0).toBeLessThan(0.1);
  }
});

test('a reload with every Firebase backend unreachable renders the board from the cache', async ({
  page,
  baseURL,
}) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada);
  const { key } = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Cached row',
    stageId: stage(b, 'To do'),
  });

  // First boot: online, so Firestore's IndexedDB cache learns the board.
  await signIn(page, ada.email, `/b/${b.key}`);
  await expect(cardOf(page, key)).toBeVisible();
  await expect(page.locator(`a[data-board="${b.key}"]`)).toBeVisible();

  // Second boot: the server is gone. Nothing below may need it.
  await armMarks(page, {
    shell: SHELL,
    card: `[role=button][aria-label^="${key} "]`,
    splash: SPLASH,
  });
  await cutTheServer(page, baseURL!);
  await page.reload();

  await expect(page.locator(SHELL)).toBeVisible({ timeout: 20_000 });
  await expect(cardOf(page, key)).toBeVisible({ timeout: 20_000 });
  // The sidebar's board list came from the cache too.
  await expect(page.locator(`a[data-board="${b.key}"]`)).toBeVisible();
  // And we were never bounced to /login: the remembered session held.
  expect(new URL(page.url()).pathname.startsWith(`/b/${b.key}`)).toBe(true);

  const m = await readMarks(page);
  expect(m.splash, 'a cached boot must not show the first-visit skeleton').toBeUndefined();
  const boot = await readBoot(page);
  const line = `[local-first] offline reload — ${boot} | dcl ${Math.round(m.dcl ?? -1)}ms, shell ${Math.round(m.shell ?? -1)}ms, first card ${Math.round(m.card ?? -1)}ms, splash shown: ${m.splash === undefined ? 'no' : 'yes'}`;
  console.log(line);
  test.info().annotations.push({ type: 'measure', description: line });
});

test('sign-out empties the device: the next person on it sees none of the last one’s work', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada);
  const { key } = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Ada only',
    stageId: stage(b, 'To do'),
  });

  await signIn(page, ada.email, `/b/${b.key}`);
  await expect(cardOf(page, key)).toBeVisible();
  // While she is signed in the device remembers her — and nothing else.
  const remembered = await page.evaluate(() => localStorage.getItem('tm.session.v1'));
  expect(remembered).toContain(ada.uid);
  expect(remembered).not.toMatch(/token|refresh|apiKey/i);

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: 'Sign out' })
    .click();
  await page.waitForURL((u) => u.pathname.startsWith('/login'));
  expect(await page.evaluate(() => localStorage.getItem('tm.session.v1'))).toBeNull();
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('tm.pointer.'))),
  ).toEqual([]);

  // Somebody else, same browser: Ada's board must not be on screen, from the
  // cache or from anywhere else.
  const grace = await newPerson('Grace');
  await signIn(page, grace.email, '/');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.locator(`a[data-board="${b.key}"]`)).toHaveCount(0);
  await expect(cardOf(page, key)).toHaveCount(0);
});
