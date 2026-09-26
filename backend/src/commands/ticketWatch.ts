/**
 * ticketWatch (app/backend.json services.ticketWatch) — the reference's
 * 'subscribe'.
 *
 *   can(read); watcherUids ± actor; prefs/{actor}.watching ± ticketId
 *
 * prefs.watching is what overrides a muted board in notify(); watcherUids is
 * what the ticket shows and what 'mine' mode reads. Both change in one
 * transaction. A person with no prefs doc yet gets one with the defaults.
 * Watching is allowed on closed tickets (you may want to know if it is restored).
 */
import { FieldValue } from 'firebase-admin/firestore';
import { isAgentId, paths, type BoardPref } from '@tm/shared';
import { typedDoc } from '../runtime/converters.js';
import { runTx, txGet } from '../runtime/tx.js';
import { loadBoard, loadTicket, requireCan, ticketRef } from '../tickets/access.js';
import { defineCommand } from './_registry.js';

/** A new person's prefs on a board (boardPrefSet owns the rest). */
export function defaultPrefs(lastViewId: string): BoardPref {
  return { mode: 'mine', watching: [], starred: false, lastViewId };
}

export default defineCommand('ticketWatch', async (ctx, input) => {
  const { boardId, ticketId, watching } = input;
  const board = await loadBoard(ctx, boardId);
  requireCan(ctx, board, 'read');

  await runTx(async (tx) => {
    await loadTicket(boardId, ticketId, tx);
    const op = watching ? FieldValue.arrayUnion : FieldValue.arrayRemove;
    // Agents have no board prefs (they hear through their inbox, which reads
    // watcherUids): only the ticket changes.
    if (isAgentId(ctx.actor)) {
      tx.update(ticketRef(boardId, ticketId), { watcherUids: op(ctx.actor) });
      return;
    }
    const prefRef = typedDoc('prefs', paths.pref(boardId, ctx.actor));
    const pref = await txGet(tx, prefRef);

    tx.update(ticketRef(boardId, ticketId), { watcherUids: op(ctx.actor) });
    if (pref) tx.update(prefRef, { watching: op(ticketId) });
    else if (watching)
      tx.set(prefRef, { ...defaultPrefs(board.defaultViewId), watching: [ticketId] });
  });
  return { ok: true as const };
});
