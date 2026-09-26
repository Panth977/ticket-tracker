/**
 * THE APP ON A PHONE (docs/plan/agents.html §U) — run at 390×844 with touch.
 *
 *   §U1  no screen scrolls sideways, and nothing is drawn wider than the
 *        viewport. (A single-track `grid` sizes to its widest child: that is
 *        how /agents ended up 774 px wide on a 390 px phone.)
 *   §U2  tapping a board card opens the ticket, and the drawer IS the screen:
 *        full width, parked at x=0, with its body visible. Entrances are CSS
 *        animations whose resting state is the final one — a JS transition
 *        that never gets its frames left the drawer translated off-screen and
 *        the body at opacity 0, which reads as "tapping did nothing".
 *   §U3  the controls in the top bars are at least 40 px to a thumb, without
 *        the layout growing (a coarse pointer gets an invisible hit area).
 */
import { expect, test, type Page } from '@playwright/test';
import { call, newBoard, newPerson, stage } from '../support/stack.js';
import { signIn } from '../support/ui.js';

/*
 * qaqc is a Node project with no DOM lib, so the browser globals the
 * page.evaluate() bodies below touch are declared here (the same idiom as
 * e2e/ui/pwa.spec.ts).
 */
interface Box {
  width: number;
  height: number;
  right: number;
  x: number;
}
interface El {
  tagName: string;
  className: string;
  parentElement: El | null;
  scrollWidth: number;
  clientWidth: number;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): Box;
  querySelectorAll(selector: string): ArrayLike<El> & Iterable<El>;
}
declare const document: {
  documentElement: El;
  body: El;
  querySelectorAll(selector: string): ArrayLike<El> & Iterable<El>;
};
declare function getComputedStyle(el: El, pseudo?: string): { [k: string]: string };

/** How far the document can be scrolled sideways — 0 on every screen. */
async function sidewaysOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollWidth - d.clientWidth;
  });
}

/** Anything laid out past the right edge (ignoring what sits in a horizontal scroller). */
async function wideElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= vw + 1) continue;
      let p = el.parentElement;
      let inScroller = false;
      while (p && p !== document.body) {
        const pcs = getComputedStyle(p);
        if (
          (pcs.overflowX === 'auto' || pcs.overflowX === 'scroll') &&
          p.scrollWidth > p.clientWidth
        ) {
          inScroller = true;
          break;
        }
        p = p.parentElement;
      }
      if (!inScroller)
        out.push(`${el.tagName}.${String(el.className).slice(0, 60)} → ${Math.round(r.right)}px`);
    }
    return [...new Set(out)].slice(0, 5);
  });
}

test('§U1: no screen scrolls sideways at 390 px', async ({ page }) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada, { name: 'Engineering' });
  await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'A ticket with a title long enough to wrap twice on a phone',
    stageId: stage(b, 'To do'),
  });

  await signIn(page, ada.email, '/me');
  for (const path of [
    '/',
    '/me',
    '/inbox',
    '/agents',
    `/b/${b.key}`,
    '/account/profile',
    '/account/tokens',
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('main')).first(),
    ).toBeVisible();
    expect(
      await sidewaysOverflow(page),
      `${path} scrolls sideways: ${(await wideElements(page)).join(', ')}`,
    ).toBe(0);
  }
});

test('§U2: a tap on a card opens the ticket, and the drawer fills the screen', async ({ page }) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada, { name: 'Engineering' });
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Open me with a thumb',
    stageId: stage(b, 'To do'),
  });

  await signIn(page, ada.email, `/b/${b.key}`);
  const card = page.getByRole('button', { name: new RegExp(`${t.key} Open me with a thumb`) });
  await expect(card).toBeVisible();
  await card.tap();

  const drawer = page.getByRole('complementary', { name: `Ticket ${t.key}` });
  await expect(drawer).toBeVisible();
  // Let the entrance finish before measuring where it came to rest.
  await drawer.evaluate((el) =>
    Promise.all(
      (el as unknown as { getAnimations(): { finished: Promise<unknown> }[] })
        .getAnimations()
        .map((a) => a.finished),
    ),
  );

  // It is the screen: parked at the left edge, as wide as the viewport.
  const box = (await drawer.boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(Math.round(box.x)).toBe(0);
  expect(Math.round(box.width)).toBe(vw);

  // And its content is actually painted — not left at the start of an entrance.
  const body = drawer.getByRole('region', { name: 'Conversation' });
  await expect(body).toBeVisible();
  expect(await body.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0.9);
  // The title is editable for an editor, a heading for everyone else.
  const title = drawer.getByRole('textbox', { name: 'Title' });
  await expect(title).toHaveValue('Open me with a thumb');
});

test('§U3: the top bar can be hit with a thumb', async ({ page }) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada, { name: 'Engineering' });

  await signIn(page, ada.email, `/b/${b.key}`);
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  // The hit area is an ::after on .tm-tap, so measure what a tap actually lands on.
  const reachable = await page.evaluate(() => {
    const names = ['Open navigation', 'Notifications'];
    const out: { label: string; w: number; h: number }[] = [];
    for (const el of document.querySelectorAll('button[aria-label], a[aria-label]')) {
      const label = el.getAttribute('aria-label') ?? '';
      if (!names.some((n) => label.startsWith(n))) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue; // not on screen at this width
      const after = getComputedStyle(el, '::after');
      const w = Math.max(box.width, parseFloat(after.width ?? '') || 0);
      const h = Math.max(box.height, parseFloat(after.height ?? '') || 0);
      out.push({ label, w: Math.round(w), h: Math.round(h) });
    }
    return out;
  });
  expect(reachable.length).toBeGreaterThan(0);
  for (const r of reachable) {
    expect(r.w, `${r.label} is only ${r.w}px wide to a thumb`).toBeGreaterThanOrEqual(40);
    expect(r.h, `${r.label} is only ${r.h}px tall to a thumb`).toBeGreaterThanOrEqual(40);
  }
});
