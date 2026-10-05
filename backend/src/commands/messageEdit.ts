/**
 * messageEdit (app/backend.json services.messageEdit).
 *
 *   edit:   the author only (admins may delete, not edit); ticket active;
 *           editedAt = now; NEW mentions notify, old ones do not again; new
 *           #refs get their backlink like a post
 *   delete: the author or a board admin — a TOMBSTONE: body cleared,
 *           attachments removed, deletedAt set; its file rows get deletedAt
 *           (counts.files drops); a pinned message is unpinned; the Storage
 *           objects are deleted after commit
 *
 * System lines are neither editable nor deletable.
 *
 * Phase 15 (§W): the message is a row on the ticket document, so an edit is
 * one write. The one case that touches a second document is an edit of a
 * message old enough to have spilled into data/{NNN} — that page is rewritten
 * in place (a page is frozen against APPENDS, not against corrections).
 */
import { can } from '@tm/shared/logic/index';
import { errors } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { runTx } from '../runtime/tx.js';
import {
  loadBoard,
  requireActive,
  requireCan,
  requireWritableBoard,
  withTicketId,
} from '../tickets/access.js';
import { openTicket } from '../tickets/doc.js';
import { afterCommit, notifySafe } from '../tickets/effects.js';
import { readRefTargets, writeReferences } from '../tickets/references.js';
import { parseBody } from '../tickets/richtext.js';
import { loadMessage, requireNotDeleted } from '../tickets/thread.js';
import { actorName, EMPTY_RICH } from '../tickets/writes.js';
import { defineCommand } from './_registry.js';

export default defineCommand('messageEdit', async (ctx, input) => {
  const { boardId, ticketId, messageId } = input;
  const board = await loadBoard(ctx, boardId);
  requireCan(ctx, board, 'comment');
  requireWritableBoard(board);
  const isDelete = input.delete === true;

  const parsed = !isDelete && input.body ? await parseBody(input.body, board, ctx, ticketId) : null;
  const byName = isDelete ? '' : await actorName(ctx, boardId);

  const res = await runTx(async (tx) => {
    // ── reads ──
    const w = await openTicket(tx, ctx, boardId, ticketId);
    const ticket = w.before;
    const found = await loadMessage(w, messageId);
    const msg = found.message;
    requireNotDeleted(msg);
    if (msg.kind === 'system') throw errors.forbidden('System lines cannot be changed');
    const mine = msg.authorUid === ctx.actor;

    if (isDelete) {
      if (!mine && !can(ctx, board, 'admin'))
        throw errors.forbidden('Only the author or an admin can delete a message');
      const live = w.filesOfMessage(messageId);
      // ── writes ──
      w.patchMessage(found, {
        body: EMPTY_RICH,
        markdown: null,
        attachments: [],
        reactions: {},
        deletedAt: ctx.now,
        pinnedAt: null,
        pinnedBy: null,
      });
      for (const f of live) w.patchFile(f.id, { deletedAt: ctx.now });
      // A settled question no longer blocks the ticket: dropping the carried
      // row lets the rollup fall back to what the thread still shows.
      w.dropCarry(messageId);
      w.touch();
      w.commit();
      return { kind: 'delete' as const, ticket, msg, removed: live };
    }

    if (!mine) throw errors.forbidden('Only the author can edit a message');
    requireActive(ticket);
    const body = parsed!.rich;
    const newRefs = body.refs.filter((r) => !ticket.refs.includes(r));
    const targets = await readRefTargets(tx, newRefs, parsed!.refAt);
    // ── writes ──
    // An edit in the app editor replaces the Markdown source (agents.html §H):
    // from now on the thread renders the edited rich text.
    w.patchMessage(found, { body, markdown: null, editedAt: ctx.now });
    if (targets.length)
      w.set({ refs: [...new Set([...ticket.refs, ...targets.map((t) => t.id)])] });
    w.touch();
    w.commit();
    writeReferences(tx, ctx, { id: ticketId, key: ticket.key, boardId }, targets, {
      systemLine: { byName },
    });
    return { kind: 'edit' as const, ticket, msg, body };
  });

  if (res.kind === 'delete') {
    const files = ports().files;
    for (const f of res.removed) {
      // memory.html §E/§J: a memory reference owns no object — the memory file stays.
      if (f.memory) continue;
      await afterCommit('storage', () => files.delete(f.path));
      if (f.thumbPath) await afterCommit('storage', () => files.delete(f.thumbPath!));
    }
    return { ok: true as const };
  }
  const t = withTicketId(boardId, ticketId, res.ticket);
  const mentioned = res.body.mentions.filter(
    (u) => !res.msg.body.mentions.includes(u) && u !== ctx.actor,
  );
  await notifySafe('mentioned', t, ctx, { mentioned, messageId });
  return { ok: true as const };
});
