/**
 * Prewarm: open the listeners the remembered pointer names, while the router
 * is still starting (docs/plan/agents.html § T).
 *
 * This adds NO cache of its own. Every subscription here goes through the same
 * shared registry, with the same keys, as the components that are about to
 * mount — so the board page's `myBoards`, `boardViews`, `members` and tickets
 * stores are already open and already hold Firestore's cached snapshot when it
 * asks for them, and its first frame is data rather than a skeleton.
 *
 * It holds those subscriptions for HOLD_MS. By then the real screen owns them
 * (the registry is reference-counted); anything nobody wanted closes on its
 * own, and the registry remembers its last value either way.
 */
import type { Readable } from 'svelte/store';
import { paths, type KeyIndex } from '@tm/shared';
import { docStore } from '$lib/stores/live';
import {
  boardActiveTickets,
  boardMembers,
  boardPref,
  boardReads,
  boardViews,
  inboxUnread,
  myBoards,
} from '$lib/stores/app';
import { readPointer } from './pointer';

/** Long enough for the slowest first paint, short enough to be a boot cost. */
export const HOLD_MS = 30_000;

let holders: (() => void)[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * §T asks for a RECORDED measurement, so the boot leaves its own receipts:
 * `window.__tmBoot[name]` is the millisecond (from navigation start) at which
 * that prewarmed query first had something to show. qaqc/e2e/ui/local-first
 * reads them; nothing in the app does.
 */
export interface BootMarks {
  [name: string]: number;
}

function markReady(name: string): (v: unknown) => void {
  let marked = false;
  return (v: unknown) => {
    if (marked || (v as { loading?: boolean })?.loading !== false) return;
    marked = true;
    try {
      const w = window as Window & { __tmBoot?: BootMarks };
      w.__tmBoot = { ...(w.__tmBoot ?? {}), [name]: Math.round(performance.now()) };
    } catch {
      /* instrumentation only */
    }
  };
}

function hold(name: string, ...stores: Readable<unknown>[]) {
  for (const [i, s] of stores.entries())
    holders.push(s.subscribe(markReady(i ? `${name}${i}` : name)));
}

/**
 * Start the subscriptions this account ended its last visit on. Safe to call
 * with a uid that auth has not confirmed yet: that is the point — the rules
 * decide what comes back, and a uid that turns out to be wrong is dropped by
 * `stopPrewarm()` the moment auth says so.
 */
export function prewarm(uid: string | null | undefined): void {
  if (typeof window === 'undefined' || !uid || holders.length) return;
  const p = readPointer(uid);

  // Always: the sidebar's boards and the inbox badge.
  hold('boards', myBoards(uid));
  hold('inbox', inboxUnread(uid));

  // The board that was open, with its views (and its stages, which ride on the
  // board document the boards query already carries).
  const b = p.board;
  if (b) {
    hold('views', boardViews(b.id, uid));
    hold('members', boardMembers(b.id));
    hold('pref', boardPref(b.id, uid));
    hold('reads', boardReads(b.id, uid));
    // §W: the same delta-synced store the board page opens, warmed with the
    // uid so it finds this account's watermark rather than re-reading the board.
    hold('tickets', boardActiveTickets(b.id, uid));
  }

  // The ticket that was open: keys/{KEY} says which board and ticket that is,
  // and it is in the cache too, so the hop costs nothing on a warm boot.
  if (p.ticket) {
    const index = docStore<KeyIndex>(paths.key(p.ticket.key.toUpperCase()));
    let chained = false;
    // Subscribing both holds the index open and chains onto the ticket the
    // moment the cached snapshot names it (usually the same tick).
    holders.push(
      index.subscribe((s) => {
        if (chained || s.loading || !s.data || s.data.deleted) return;
        chained = true;
        hold('ticket', docStore(paths.ticket(s.data.boardId, s.data.ticketId)));
      }),
    );
  }

  timer = setTimeout(stopPrewarm, HOLD_MS);
}

/** Let go: the screens that wanted these now hold them themselves. */
export function stopPrewarm(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const list = holders;
  holders = [];
  for (const off of list) {
    try {
      off();
    } catch {
      /* a listener torn down by registry.closeAll() — nothing to release */
    }
  }
}

/** Tests / debugging: how many listeners the boot is holding. */
export function prewarmCount(): number {
  return holders.length;
}
