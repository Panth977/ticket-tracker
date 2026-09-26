/**
 * Where you were, remembered (docs/plan/agents.html § T).
 *
 * The URL is the only place that knows which view and which ticket were open —
 * the board's id comes from `$lib/stores/app` as its query resolves. This
 * watches the router and writes just those two facts into the per-account
 * pointer, so the next boot can open the right listeners before the server
 * answers.
 *
 * It owns its own effect root (`$effect.root`) rather than living in a
 * component: the root layout is the one place that must stay small, and this
 * has nothing to draw.
 */
import { page } from '$app/state';
import { notePointer } from './pointer';

/** /b/ENG/v1 → { boardKey: 'ENG', viewId: 'v1' }; anything else → nulls. */
export function placeOf(url: URL): {
  boardKey: string | null;
  viewId: string | null;
  ticketKey: string | null;
} {
  const parts = url.pathname.split('/').filter(Boolean);
  const boardKey = parts[0] === 'b' ? (parts[1] ?? null) : null;
  const viewId = boardKey ? (parts[2] ?? null) : null;
  // A ticket is either its own page (/t/ENG-42) or the drawer over a board.
  const ticketKey = parts[0] === 't' ? (parts[1] ?? null) : url.searchParams.get('ticket');
  return { boardKey, viewId, ticketKey };
}

/**
 * Follow the router for as long as the returned function is not called.
 * `uid` is a getter so this never holds on to an account that has changed.
 */
export function trackPlace(uid: () => string | null): () => void {
  if (typeof window === 'undefined') return () => {};
  return $effect.root(() => {
    $effect(() => {
      const who = uid();
      if (!who) return;
      const { boardKey, viewId, ticketKey } = placeOf(page.url);
      // Only ever a patch: leaving a board does not forget which board it was,
      // and a screen with no ticket does not forget the last ticket either.
      notePointer(who, {
        ...(boardKey ? { viewId } : {}),
        ...(ticketKey ? { ticket: { key: ticketKey.toUpperCase(), boardKey } } : {}),
      });
    });
  });
}
