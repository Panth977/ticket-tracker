/**
 * PHASE 15 END TO END (docs/plan/agents.html §W) — THE READ BUDGET.
 *
 * "A board open costs one query of ten documents and a refresh pays only for
 * what changed." That is a claim about the BILL, so this suite counts.
 *
 * The app keeps a read meter (frontend/src/lib/stores/reads.ts) on
 * `window.__tmReads`: every store that can be billed adds what the SERVER sent
 * it — a snapshot Firestore answered from its own IndexedDB cache costs nothing,
 * establishing a listener costs Firestore's minimum of one, and each document
 * in a later `docChanges()` costs one. It is an estimate of the bill, and it is
 * exact about the thing that matters: whether a screen opened one query or
 * one per card.
 *
 * WHAT IS ASSERTED
 *   1. A board of ten tickets is ONE query of ten documents. Not ten unread
 *      queries plus two collection-group queries plus an agentStatus listener,
 *      which is what phase 3 + phase 8 cost per board.
 *   2. Reopening it with nothing changed costs ONE read for the cards — the
 *      delta (`updatedAt > watermark`) comes back empty and the cards are
 *      painted out of the cache — and the whole screen stays in single digits.
 *   3. Opening a TICKET the board already drew costs nothing extra for the
 *      ticket: the thread, its pins, its task lists and its files are fields of
 *      the document the card was drawn from, and no `data/{NNN}` page is
 *      fetched for a short thread.
 *
 * The numbers are printed and kept as annotations, because a budget that is
 * only ever asserted tells you nothing when it changes.
 */
import { expect, test, type Page } from '@playwright/test';
import { call, doc, newBoard, newPerson, stage } from '../support/stack.js';
import { signIn } from '../support/ui.js';

/** qaqc has no DOM lib (it is a Node project): what the page bodies touch. */
declare const window: {
  __tmReads?: { total: number; byKey: Record<string, number>; log: { key: string; n: number }[] };
  __tmResetReads?: () => void;
};

interface Meter {
  total: number;
  byKey: Record<string, number>;
}

const EMPTY: Meter = { total: 0, byKey: {} };

async function meter(page: Page): Promise<Meter> {
  const m = await page.evaluate(() => window.__tmReads ?? null);
  return m ? { total: m.total, byKey: m.byKey } : EMPTY;
}

async function reset(page: Page): Promise<void> {
  await page.evaluate(() => window.__tmResetReads?.());
}

/** Reads billed to keys matching `re` — 'the cards', 'the pages', … */
function billed(m: Meter, re: RegExp): number {
  return Object.entries(m.byKey)
    .filter(([k]) => re.test(k))
    .reduce((n, [, v]) => n + v, 0);
}

/** How many separate listeners / fetches were billed at all. */
const listeners = (m: Meter, re?: RegExp): number =>
  Object.keys(m.byKey).filter((k) => !re || re.test(k)).length;

/** The most any single listener was billed. */
const worst = (m: Meter, re?: RegExp): number =>
  Math.max(
    0,
    ...Object.entries(m.byKey)
      .filter(([k]) => !re || re.test(k))
      .map(([, v]) => v),
  );

/** 'delta:tickets:b1 10, d:boards/b1 1, …' — what a failure should print. */
function spell(m: Meter): string {
  const rows = Object.entries(m.byKey).sort((a, b) => b[1] - a[1]);
  return `${m.total} reads — ${rows.map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing'}`;
}

function record(name: string, m: Meter): void {
  const line = `[reads] ${name}: ${spell(m)}`;
  console.log(line);
  test.info().annotations.push({ type: 'measure', description: line });
}

const TICKETS = 10;
/** The cards themselves: `boardActiveTickets` (lib/stores/delta). */
const CARDS = /^delta:tickets:/;
/** A `data/{NNN}` page — the only read the ticket view may still need. */
const PAGES = /^page:/;

const card = (page: Page, key: string) =>
  page.getByRole('button', { name: new RegExp(`^${key} `) }).first();

test('§W: a board of ten tickets is one query of ten documents, and a reopen costs one', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada, { name: 'Budget' });
  const made: { key: string; ticketId: string }[] = [];
  for (let i = 1; i <= TICKETS; i++) {
    const t = await call(ada, 'ticketCreate', {
      boardId: b.id,
      title: `Ticket number ${i}`,
      stageId: stage(b, 'To do'),
    });
    made.push({ key: t.key, ticketId: t.ticketId });
  }
  const keys = made.map((t) => t.key);
  const first = made[0]!;
  // A thread on one of them, so the cards have an unread badge to draw — that
  // badge used to be a query PER CARD (§P2), and §W2 counts it from the
  // ticket's own inline messages instead.
  for (let i = 1; i <= 3; i++) {
    await call(ada, 'messagePost', {
      boardId: b.id,
      ticketId: first.ticketId,
      body: doc([`Hello ${i}`]),
    });
  }

  // ── the first open ───────────────────────────────────────────────────────
  // Boot somewhere else first, so what is measured is opening THE BOARD and not
  // starting the app (the sidebar, the inbox badge and my own user document are
  // one fixed cost per session, whatever is on screen).
  await signIn(page, ada.email, '/me');
  await expect(page.locator(`a[data-board="${b.key}"]`)).toBeVisible();
  await reset(page);

  await page.locator(`a[data-board="${b.key}"]`).click();
  for (const k of keys) await expect(card(page, k)).toBeVisible();
  // Everything the board wanted has landed (the unread badge is the last thing
  // to settle, and it settles without a listener at all now).
  await page.waitForTimeout(1500);

  const cold = await meter(page);
  record('first board open', cold);

  // The cards: ONE query, ten documents. Not one query per card, and not two
  // collection-group queries on top (which is what §L1 · §L2 · §P2 cost).
  expect(listeners(cold, CARDS), `the cards took more than one query: ${spell(cold)}`).toBe(1);
  expect(billed(cold, CARDS), `the cards cost more than the ten documents: ${spell(cold)}`).toBe(
    TICKETS,
  );
  // Everything else the board opens is a fixed handful — its views, its
  // members, my read pointers, my prefs — whatever the board's size. Single
  // digits, and none of them per card.
  const others = listeners(cold) - 1;
  // The app shell's own listeners count too (sidebar: workspaces, artifacts, memory, inbox, invites…).
  expect(
    others,
    `the board opened ${others} listeners besides the cards: ${spell(cold)}`,
  ).toBeLessThan(12);
  expect(
    worst(cold, /^(?!delta:tickets:)/),
    `something other than the cards returned a crowd: ${spell(cold)}`,
  ).toBeLessThan(TICKETS);

  // ── the reopen: nothing has changed ──────────────────────────────────────
  await page.reload();
  for (const k of keys) await expect(card(page, k)).toBeVisible();
  await page.waitForTimeout(1500);

  const warm = await meter(page);
  record('reopen, nothing changed', warm);

  // §W, in its own words: "an unchanged board costs one read". The cards were
  // painted out of Firestore's cache and the delta (`updatedAt > watermark`)
  // came back with nothing — Firestore's minimum, ONE read.
  expect(
    billed(warm, CARDS),
    `the cards were re-read on a reopen: ${spell(warm)}`,
  ).toBeLessThanOrEqual(1);
  // And that is true of the whole screen, not just the cards: nothing changed,
  // so no listener anywhere was billed for a document.
  expect(
    worst(warm),
    `a listener paid for documents on an unchanged reopen: ${spell(warm)}`,
  ).toBeLessThanOrEqual(1);
  // The board's own half of that — its cards, views, members, reads, prefs —
  // in single digits.
  const boardOnly = billed(warm, new RegExp(b.id));
  expect(boardOnly, `reopening the board cost ${boardOnly} reads: ${spell(warm)}`).toBeLessThan(10);

  // ── and it is still live: one change costs one read ──────────────────────
  await reset(page);
  await call(ada, 'ticketUpdate', {
    boardId: b.id,
    ticketId: first.ticketId,
    patch: { title: 'Renamed by the test' },
  });
  await expect(page.getByText('Renamed by the test')).toBeVisible();
  const delta = await meter(page);
  record('one ticket changed', delta);
  expect(billed(delta, CARDS), `a single change cost ${spell(delta)}`).toBeLessThanOrEqual(2);
});

test('§W: opening a ticket the board already drew costs nothing for the ticket', async ({
  page,
}) => {
  const ada = await newPerson('Ada');
  const b = await newBoard(ada, { name: 'Ticket budget' });
  const t = await call(ada, 'ticketCreate', {
    boardId: b.id,
    title: 'Everything inline',
    stageId: stage(b, 'To do'),
  });
  // A thread, a task list and a file row: what used to be three more queries.
  for (let i = 1; i <= 12; i++) {
    await call(ada, 'messagePost', {
      boardId: b.id,
      ticketId: t.ticketId,
      body: doc([`Message ${i}`]),
    });
  }
  await call(ada, 'tasklistSet', {
    boardId: b.id,
    ticketId: t.ticketId,
    title: 'Plan',
    items: [{ title: 'first', status: 'done' as const }, { title: 'second' }],
  });

  await signIn(page, ada.email, `/b/${b.key}`);
  await expect(card(page, t.key)).toBeVisible();
  await page.waitForTimeout(1500);

  // From here on, only the ticket.
  await reset(page);
  await card(page, t.key).click();
  const thread = page.getByRole('region', { name: 'Thread' });
  await expect(thread.getByRole('article').last()).toContainText('Message 12');
  // The task lists are on the same document, so they are already drawn.
  await expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();
  await page.waitForTimeout(1500);

  const open = await meter(page);
  record('ticket open, from the board', open);

  // The ticket document itself was already read for the card: opening it reads
  // the key index and my read pointer, not the thread.
  const ticketDoc = billed(open, new RegExp(`^d:boards/${b.id}/tickets/`));
  expect(
    ticketDoc,
    `the ticket document was re-read ${ticketDoc} times: ${spell(open)}`,
  ).toBeLessThanOrEqual(1);
  // Twelve messages fit in the inline window: no page was fetched.
  expect(billed(open, PAGES), `a data page was fetched for a short thread: ${spell(open)}`).toBe(0);
  expect(open.total, `opening a ticket cost ${open.total} reads: ${spell(open)}`).toBeLessThan(8);
});
