/**
 * messagePost (app/backend.json services.messagePost).
 *
 *   can(comment); ticket state 'active' (closed tickets have closed threads → 409)
 *   body = parseRichText(body); attachments exist under this ticket's prefix, ≤ 50 MB
 *   ONE write on the ticket document (§W): recentMessages += the message
 *     (spilling the oldest chunk into data/{NNN} if that pushes it over the
 *     cut); files += rows (source 'message'); counts.messages++ /
 *     counts.files / lastMessageAt / signals; refs ∪= body.refs;
 *     watcherUids ∪= [actor]
 *   plus users/{actor}/reads/{ticket} = now (your own message is read), and
 *     for each NEW #ref the target's referencedBy += this ticket and a system
 *     line on THAT ticket ('Referenced from #ENG-40')
 *   after commit: notify('mentioned', body.mentions) unconditionally, then
 *     notify('comment') minus those mentioned (no double ping); webhook message.created
 *
 * Phase 2 (agents.html §F–H): principals — the author may be an agent (a
 * token acting as it); `markdown` is stored as Message.markdown (the door
 * also derived `body` from it); `fileIds` names files ALREADY on this ticket
 * (source 'upload', not yet in a message — POST /v1/tickets/{KEY}/files, MCP
 * upload_file): they become this message's attachments and their rows flip to
 * source 'message' with messageId set (counts.files was already counted at
 * upload). `viaToken` records the token. Agents have no users/{…}/reads (they
 * never open the app).
 *
 * The message id is the request's clientId — the optimistic bubble's id — so
 * the realtime listener and the answer agree on it, and a retry after the
 * 24h idempotency window still finds its own message instead of posting twice.
 *
 * Phase 17 (agents.html §Y): a message may carry `run`, the TURN RECEIPT an
 * orchestrator posts when one run of an agent ends. It is stored on the
 * message and, IN THE SAME TRANSACTION, added to three counters — the
 * ticket's `cost`, the board's `cost` and the day row
 * boards/{b}/stats/{yyyy-mm-dd} (the day cut in COST_DAY_TZ). Nothing is
 * scanned: three small writes per receipt, and the chart reads the day rows.
 * A replayed post (same clientId) counts nothing twice.
 */
import {
  costDayOf,
  errors,
  isAgentId,
  paths,
  type BoardDayStats,
  type CostCounter,
  type Message,
  type Read,
} from '@tm/shared';
import { isEmptyDoc } from '@tm/shared/logic/index';
import { typedDoc } from '../runtime/converters.js';
import { runTx, txGet } from '../runtime/tx.js';
import {
  boardRef,
  loadBoard,
  requireActive,
  requireCan,
  requireWritableBoard,
  withTicketId,
} from '../tickets/access.js';
import { resolveAttachments } from '../tickets/attachments.js';
import { attachUploadedFiles, readUploadedFiles } from '../tickets/files.js';
import { openTicket } from '../tickets/doc.js';
import { emitSafe, notifySafe } from '../tickets/effects.js';
import { toPublicMessage } from '../platform/public.js';
import { readRefTargets, writeReferences } from '../tickets/references.js';
import { parseBody } from '../tickets/richtext.js';
import { actorName, EMPTY_RICH, fileRows, viaTokenOf } from '../tickets/writes.js';
import { defineCommand } from './_registry.js';

/** Money is summed to a millionth of a dollar, so a thousand receipts never drift. */
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const ZERO_COST: CostCounter = { usd: 0, runs: 0 };
const addCost = (prev: CostCounter | undefined, usd: number): CostCounter => ({
  usd: round6((prev ?? ZERO_COST).usd + usd),
  runs: (prev ?? ZERO_COST).runs + 1,
});

export default defineCommand('messagePost', async (ctx, input) => {
  const { boardId, ticketId } = input;
  const board = await loadBoard(ctx, boardId);
  requireCan(ctx, board, 'comment');
  requireWritableBoard(board);

  const empty = isEmptyDoc(input.body);
  if (empty && !input.attachments?.length && !input.fileIds?.length)
    throw errors.invalid('Write something or attach a file', { field: 'body' });
  const parsed = empty
    ? { rich: EMPTY_RICH, refAt: new Map() }
    : await parseBody(input.body, board, ctx, ticketId);
  const uploaded = await resolveAttachments(input.attachments, boardId, ticketId, ctx.actor);
  const fileIds = [...new Set(input.fileIds ?? [])].filter(
    (id) => !uploaded.some((a) => a.id === id),
  );
  const byName = await actorName(ctx, boardId);

  const res = await runTx(async (tx) => {
    // ── reads ──
    const w = await openTicket(tx, ctx, boardId, ticketId);
    const ticket = w.before;
    requireActive(ticket);
    let messageId = input.clientId;
    const existing = w.find(messageId);
    if (existing) {
      // A late retry of our own post: the same message, not a second one.
      if (existing.authorUid === ctx.actor)
        return { replay: true as const, messageId, ticket, message: existing, newRefs: [] };
      messageId = ctx.ids.id();
    }
    if (input.replyTo && !(await w.locate(input.replyTo)))
      throw errors.invalid('The quoted message does not exist', { field: 'replyTo' });
    const posted = readUploadedFiles(w, fileIds);
    const attachments = [...uploaded, ...posted.map((f) => f.attachment)];
    const newRefs = parsed.rich.refs.filter((r) => !ticket.refs.includes(r));
    const targets = await readRefTargets(tx, newRefs, parsed.refAt);
    // §Y2: a receipt moves the board's counter and the day row too, so both
    // are read HERE (the read phase, this transaction) — the board loaded
    // above was read outside it.
    const receipt = input.run ?? null;
    const day = costDayOf(ctx.now);
    const statRef = typedDoc('stats', paths.stat(boardId, day));
    const costReads = receipt
      ? await Promise.all([txGet(tx, boardRef(boardId)), txGet(tx, statRef)])
      : null;

    // ── writes ──
    const markdown = input.markdown?.trim() ? input.markdown : null;
    const message: Message = {
      kind: 'comment',
      body: parsed.rich,
      ...(markdown ? { markdown } : {}),
      ...(receipt ? { run: receipt } : {}),
      authorUid: ctx.actor,
      authorName: byName,
      via: ctx.via,
      ...viaTokenOf(ctx),
      replyTo: input.replyTo ?? null,
      attachments,
      reactions: {},
      pinnedAt: null,
      pinnedBy: null,
      editedAt: null,
      deletedAt: null,
      createdAt: ctx.now,
    };
    w.addMessage(messageId, message);
    // API uploads were already counted when they arrived; these are the direct ones.
    w.addFiles(fileRows(uploaded, 'message', messageId, ctx.now));
    attachUploadedFiles(w, posted, messageId);
    w.set({ watcherUids: [...new Set([...ticket.watcherUids, ctx.actor])] });
    if (targets.length)
      w.set({ refs: [...new Set([...ticket.refs, ...targets.map((t) => t.id)])] });
    if (receipt && costReads) {
      // §Y2: three counters, one day row, the same write as the message.
      const [boardNow, dayNow] = costReads;
      w.set({ cost: addCost(ticket.cost, receipt.costUsd) });
      tx.update(boardRef(boardId), { cost: addCost(boardNow?.cost, receipt.costUsd) });
      const prevDay: BoardDayStats = dayNow ?? {
        day,
        costUsd: 0,
        runs: 0,
        tickets: {},
        updatedAt: ctx.now,
      };
      const next: BoardDayStats = {
        day,
        costUsd: round6(prevDay.costUsd + receipt.costUsd),
        runs: prevDay.runs + 1,
        tickets: {
          ...prevDay.tickets,
          [ticket.key]: addCost(prevDay.tickets[ticket.key], receipt.costUsd),
        },
        updatedAt: ctx.now,
      };
      tx.set(statRef, next);
    }
    const after = w.commit();
    // Your own message is read: the unread dot never lights up for its author.
    // (Agents never open the app: no read pointer for them.)
    if (!isAgentId(ctx.actor)) {
      const read: Read = { boardId, readAt: ctx.now, ticketId };
      tx.set(typedDoc('reads', paths.read(ctx.actor, ticketId)), read);
    }
    writeReferences(tx, ctx, { id: ticketId, key: ticket.key, boardId }, targets, {
      systemLine: { byName },
    });
    return {
      replay: false as const,
      messageId,
      ticket: after,
      message,
      newRefs: targets.map((t) => t.id),
    };
  });
  if (res.replay) return { messageId: res.messageId };

  // ── after commit ──
  const t = withTicketId(boardId, ticketId, res.ticket);
  const mentioned = res.message.body.mentions.filter((u) => u !== ctx.actor);
  await notifySafe('mentioned', t, ctx, { mentioned, messageId: res.messageId });
  await notifySafe('comment', t, ctx, { messageId: res.messageId, exclude: mentioned });
  await emitSafe(
    boardId,
    'message.created',
    () => toPublicMessage(boardId, t.key, res.messageId, res.message, ticketId),
    ctx,
  );
  return { messageId: res.messageId };
});
