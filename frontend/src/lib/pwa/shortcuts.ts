/**
 * The manifest's app shortcuts (long-press the icon on Android): Inbox, My work
 * and New ticket — docs/plan/agents.html § S.
 *
 * Inbox and My work are plain URLs. "New ticket" is not: a ticket belongs to a
 * board, and the quick-add form lives on the board screen. So its shortcut
 * lands on the boards list with ?new=ticket, and this module carries the intent
 * the rest of the way — to your board, then to the same 'c' binding the
 * keyboard uses, through the shortcut service's public dispatch. The parameter
 * is stripped either way, so a reload never re-fires it.
 */
/* The targets here come from lib/layout/routes (and from the current URL); the
   SPA has no base path, so resolve() would be the identity. */
/* eslint-disable svelte/no-navigation-without-resolve */
import { goto } from '$app/navigation';
import { shortcuts } from '$lib/keyboard/shortcuts';
import { routes } from '$lib/layout/routes';
import type { Board } from '@tm/shared';

export const INTENT = 'new';
export const NEW_TICKET = 'ticket';

/** What to do about ?new=ticket on this URL. Pure, so it can be tested. */
export function planIntent(
  url: URL,
  boards: { list: Board[]; loading: boolean },
): { do: 'nothing' } | { do: 'wait' } | { do: 'goto'; to: string } | { do: 'quickAdd' } {
  if (url.searchParams.get(INTENT) !== NEW_TICKET) return { do: 'nothing' };
  // Already on a board: that screen owns the quick-add form.
  if (url.pathname.startsWith('/b/')) return { do: 'quickAdd' };
  if (boards.loading) return { do: 'wait' };
  const board = boards.list.find((b) => b.archivedAt == null);
  // No board yet — the honest next step is making one.
  if (!board) return { do: 'goto', to: routes.newBoard() };
  return { do: 'goto', to: `${routes.board(board.key)}?${INTENT}=${NEW_TICKET}` };
}

/** The same URL without the intent (used with replaceState: it is not a place to go back to). */
export function withoutIntent(url: URL): string {
  const next = new URL(url);
  next.searchParams.delete(INTENT);
  return `${next.pathname}${next.search}${next.hash}`;
}

/** Open the board screen's quick add, through the binding the 'c' key uses. */
export function openQuickAdd(): boolean {
  if (typeof window === 'undefined') return false;
  return shortcuts.dispatch(new KeyboardEvent('keydown', { key: 'c' }));
}

/** The account menu mounts twice on a phone; one intent must run once. */
let claimed: string | null = null;

/** Act on the plan. Returns true when the intent was consumed. */
export async function runIntent(
  url: URL,
  boards: { list: Board[]; loading: boolean },
): Promise<boolean> {
  const plan = planIntent(url, boards);
  if (plan.do === 'nothing' || plan.do === 'wait') return false;
  if (claimed === url.href) return false;
  claimed = url.href;
  if (plan.do === 'goto') {
    await goto(plan.to, { replaceState: true });
    return true;
  }
  await goto(withoutIntent(url), { replaceState: true, noScroll: true, keepFocus: true });
  openQuickAdd();
  return true;
}
