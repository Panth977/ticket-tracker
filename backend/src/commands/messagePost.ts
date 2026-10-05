/**
 * messagePost (app/backend.json services.messagePost).
 *
 *   can(comment); ticket state 'active' (closed tickets have closed threads → 409)
 *   body = parseRichText(body); `attachments` is retired (memory.html §J) and
 *   refused; memoryUploads become NEW files in a memory granted `write` to the
 *   board, in the same transaction as the message (memory/attach.ts)
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
 *
 * aggregates.html: cost is now one AGGREGATE FIELD among any the board
 * defines. A message may carry `agg` entries (kind 'agg'); a receipt's costUsd
 * is an implied entry on the field 'cost' (stored as message.agg too). Each
 * entry, in the same transaction: ticket.aggs[f], board.aggs[f] and the
 * period bucket boards/{b}/aggStats/{period}:{key} (fields sharing a period
 * share one doc). The legacy cost mirrors (ticket.cost, board.cost and the day
 * row stats/{day}) are still written for the 'cost' field, so they stay the
 * whole truth for it (scripts/migrate-aggregates.mjs copies from them).
 */
import {
  addAgg,
  aggPeriodKey,
  aggStatsId,
  aggSummary,
  boardAggFields,
  COST_AGG_FIELD_ID,
  costDayOf,
  errors,
  isAgentId,
  paths,
  type AggCounter,
  type AggCounters,
  type AggEntry,
  type AggFieldDef,
  type AggPeriod,
  type AggStats,
  type BoardDayStats,
  type CostCounter,
  type MessageAgg,
  type Message,
  type Read,
} from '@tm/shared';
import { isEmptyDoc, parseRichText } from '@tm/shared/logic/index';
import { markdownToDoc } from '@tm/shared/logic/richtext/index';
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
import { resolveMemoryRefs } from '../memory/refs.js';
import { planMemoryUploads, stageMemoryUploads, withUploads } from '../memory/attach.js';
import { refuseBoardAttachments } from '../tickets/attachments.js';
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

/** The legacy cost counter as an aggregate counter (a board/ticket from before aggregates). */
const fromCost = (c: CostCounter | undefined): AggCounter | undefined =>
  c ? { total: c.usd, count: c.runs } : undefined;
const toCost = (c: AggCounter): CostCounter => ({ usd: c.total, runs: c.count });

/**
 * aggregates.html: the entries this post counts — the request's `agg` plus a
 * receipt's implied cost entry. Every field must be an active field of the board.
 */
export function planAggEntries(
  fields: AggFieldDef[],
  agg: MessageAgg | undefined,
  costUsd: number | null,
): AggEntry[] {
  const active = new Map(fields.filter((f) => !f.archived).map((f) => [f.id, f]));
  const known = new Set(fields.map((f) => f.id));
  const entries: AggEntry[] = [];
  for (const e of agg?.entries ?? []) {
    if (!known.has(e.fieldId))
      throw errors.invalid(`No aggregate field "${e.fieldId}" on this board`, {
        field: 'agg',
        fieldId: e.fieldId,
      });
    if (!active.has(e.fieldId))
      throw errors.invalid(`The aggregate field "${e.fieldId}" was removed`, {
        field: 'agg',
        fieldId: e.fieldId,
      });
    if (costUsd !== null && e.fieldId === COST_AGG_FIELD_ID)
      throw errors.invalid('A turn receipt already counts its cost: no "cost" entry beside it', {
        field: 'agg',
        fieldId: e.fieldId,
      });
    entries.push(e);
  }
  if (costUsd !== null && active.has(COST_AGG_FIELD_ID))
    entries.unshift({ fieldId: COST_AGG_FIELD_ID, value: costUsd });
  return entries;
}

export default defineCommand('messagePost', async (ctx, input) => {
  const { boardId, ticketId } = input;
  const board = await loadBoard(ctx, boardId);
  requireCan(ctx, board, 'comment');
  requireWritableBoard(board);

  // memory.html §J: a board takes no files of its own any more.
  refuseBoardAttachments(input.attachments);

  const receipt = input.run ?? null;
  const fields = boardAggFields(board);
  const entries = planAggEntries(fields, input.agg, receipt ? receipt.costUsd : null);
  const isAgg = !!input.agg && !receipt;

  const empty = isEmptyDoc(input.body);
  if (
    empty &&
    !isAgg &&
    !input.fileIds?.length &&
    !input.memoryRefs?.length &&
    !input.memoryUploads?.length
  )
    throw errors.invalid('Write something or attach a file', { field: 'body' });
  // An entry with nothing said gets words of its own (notifications and email need text).
  const summary = empty && isAgg ? aggSummary(input.agg!.entries, fields) : null;
  const parsed = summary
    ? { rich: parseRichText(markdownToDoc(summary)), refAt: new Map() }
    : empty
      ? { rich: EMPTY_RICH, refAt: new Map() }
      : await parseBody(input.body, board, ctx, ticketId);
  // memory.html §E: memory files by reference (the memory must be granted to this board).
  const memoryFiles = await resolveMemoryRefs(ctx, input.memoryRefs, boardId);
  const fileIds = [...new Set(input.fileIds ?? [])];
  const byName = await actorName(ctx, boardId);
  // memory.html §J: files just uploaded INTO a memory become new nodes there —
  // planned and written in the transaction below, with the message. Staged
  // last, after every cheap refusal; a failure from here on removes them again.
  const staged = await stageMemoryUploads(input.memoryUploads);

  const res = await withUploads(staged, () =>
    runTx(async (tx) => {
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
      const plan = await planMemoryUploads(tx, ctx, staged, boardId, ticket.key);
      const attachments = [...plan.attachments, ...posted.map((f) => f.attachment), ...memoryFiles];
      const newRefs = parsed.rich.refs.filter((r) => !ticket.refs.includes(r));
      const targets = await readRefTargets(tx, newRefs, parsed.refAt);
      // aggregates.html: entries move the board's counters and the period
      // buckets too, so those are read HERE (the read phase, this transaction)
      // — the board loaded above was read outside it. One doc per period.
      const byId = new Map(fields.map((f) => [f.id, f]));
      const periods = [...new Set(entries.map((e) => byId.get(e.fieldId)!.period))];
      const bucketRefs = new Map(
        periods.map((p) => {
          const key = aggPeriodKey(p, ctx.now);
          return [
            p,
            { key, ref: typedDoc('aggStats', paths.aggStat(boardId, aggStatsId(p, key))) },
          ];
        }),
      );
      const hasCost = entries.some((e) => e.fieldId === COST_AGG_FIELD_ID);
      const day = costDayOf(ctx.now);
      const statRef = typedDoc('stats', paths.stat(boardId, day));
      const [boardNow, dayNow, ...bucketsNow] = entries.length
        ? await Promise.all([
            txGet(tx, boardRef(boardId)),
            hasCost ? txGet(tx, statRef) : Promise.resolve(undefined),
            ...periods.map((p) => txGet(tx, bucketRefs.get(p)!.ref)),
          ])
        : [];

      // ── writes ──
      const markdown = input.markdown?.trim() ? input.markdown : null;
      const message: Message = {
        kind: isAgg ? 'agg' : 'comment',
        body: parsed.rich,
        ...(markdown ? { markdown } : summary ? { markdown: summary } : {}),
        ...(receipt ? { run: receipt } : {}),
        ...(entries.length ? { agg: { entries } } : {}),
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
      plan.write(tx);
      const refRows = [...plan.attachments, ...memoryFiles];
      if (refRows.length) w.addFiles(fileRows(refRows, 'memory', messageId, ctx.now));
      attachUploadedFiles(w, posted, messageId);
      w.set({ watcherUids: [...new Set([...ticket.watcherUids, ctx.actor])] });
      if (targets.length)
        w.set({ refs: [...new Set([...ticket.refs, ...targets.map((t) => t.id)])] });
      if (entries.length) {
        const tAggs: AggCounters = { ...ticket.aggs };
        const bAggs: AggCounters = { ...boardNow?.aggs };
        const buckets = new Map<AggPeriod, AggStats>(
          periods.map((p, i) => {
            const { key } = bucketRefs.get(p)!;
            const prev = bucketsNow[i] as AggStats | undefined;
            return [
              p,
              prev
                ? { ...prev, fields: { ...prev.fields } }
                : { period: p, key, fields: {}, updatedAt: ctx.now },
            ];
          }),
        );
        for (const { fieldId: f, value } of entries) {
          const legacy = f === COST_AGG_FIELD_ID;
          tAggs[f] = addAgg(tAggs[f] ?? (legacy ? fromCost(ticket.cost) : undefined), value);
          bAggs[f] = addAgg(bAggs[f] ?? (legacy ? fromCost(boardNow?.cost) : undefined), value);
          const b = buckets.get(byId.get(f)!.period)!;
          const prev = b.fields[f];
          b.fields[f] = {
            ...addAgg(prev, value),
            tickets: { ...prev?.tickets, [ticket.key]: addAgg(prev?.tickets[ticket.key], value) },
          };
        }
        w.set({ aggs: tAggs, ...(hasCost ? { cost: toCost(tAggs[COST_AGG_FIELD_ID]!) } : {}) });
        tx.update(boardRef(boardId), {
          aggs: bAggs,
          ...(hasCost ? { cost: toCost(bAggs[COST_AGG_FIELD_ID]!) } : {}),
        });
        for (const p of periods)
          tx.set(bucketRefs.get(p)!.ref, { ...buckets.get(p)!, updatedAt: ctx.now });
        if (hasCost) {
          // The legacy day row (§Y2) — kept whole for the cost field.
          const usd = entries.find((e) => e.fieldId === COST_AGG_FIELD_ID)!.value;
          const prevDay: BoardDayStats = (dayNow as BoardDayStats | undefined) ?? {
            day,
            costUsd: 0,
            runs: 0,
            tickets: {},
            updatedAt: ctx.now,
          };
          tx.set(statRef, {
            day,
            costUsd: round6(prevDay.costUsd + usd),
            runs: prevDay.runs + 1,
            tickets: {
              ...prevDay.tickets,
              [ticket.key]: addCost(prevDay.tickets[ticket.key], usd),
            },
            updatedAt: ctx.now,
          });
        }
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
    }),
  );
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
