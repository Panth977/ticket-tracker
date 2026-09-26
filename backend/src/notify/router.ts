/**
 * notify(event, ticket, ctx, extra) — THE ONE ROUTER for every event and
 * channel (app/backend.json proxyFunctions.notify).
 *
 *   1. candidates (recipients.ts), minus the actor
 *   2. each person's own board pref (mode / events / stageIds, watching overrides)
 *   3. users/{uid}/inbox — ALWAYS when the pref allows; collapsed by groupKey
 *   4. enqueue deliver `${uid}:${groupKey}:${minute}` with the out-of-app
 *      channels THAT PERSON ticked for this event (user.notify.channels)
 *
 * AGENTS (agents.html §D) are never people here: they are not in readerUids,
 * so the steps above never pick them. Every recipient that is an agent gets
 * an agentInbox/{agentId}/events row instead (agents/inbox.ts) — never push,
 * email or WhatsApp, never for its own actions.
 *
 * ENQUEUED, NOT SENT: the command returns before any channel is touched. The
 * task is named per minute and delayed to the end of that minute, so a burst
 * of five comments becomes ONE push and ONE email carrying the collapsed row
 * ('5 new comments'), and a crashed send is retried by the queue.
 *
 * Called only AFTER the command's transaction committed. It never throws into
 * the command: a notification failure is logged, the change stands.
 */
import {
  paths,
  type BoardPref,
  type CommandCtx,
  type InboxItem,
  type NotifyEvent,
  type NotifyExtra,
  type NotifyFn,
  type TicketWithId,
  type User,
} from '@tm/shared';
import { ports } from '../adapters/index.js';
import { getMessage } from '../tickets/read.js';
import { getDoc, typedDoc } from '../runtime/index.js';
import { db } from '../runtime/firebase.js';
import {
  DELIVER_WINDOW_MS,
  groupKeyFor,
  inboxIdFor,
  OUT_CHANNELS,
  SYSTEM_ACTOR,
  type OutChannel,
} from './config.js';
import {
  agentEventType,
  agentRecipients,
  agentSummary,
  writeAgentEvents,
} from '../agents/inbox.js';
import { actorName } from '../tickets/writes.js';
import { candidates, prefAllows } from './recipients.js';
import { summarize } from './summary.js';

export interface NotifyResult {
  /** uid → the inbox row written for them. */
  inbox: Record<string, string>;
  /** uid → the channels enqueued for them (empty when only in-app). */
  enqueued: Record<string, OutChannel[]>;
  /** agentId → the agent inbox event written for it. */
  agents: Record<string, string>;
}

/** The out-of-app channels this person wants for this event. */
export function outChannels(
  user: Pick<User, 'notify' | 'whatsapp' | 'email'>,
  event: NotifyEvent,
): OutChannel[] {
  const chosen = user.notify?.channels?.[event] ?? [];
  return OUT_CHANNELS.filter((c) => {
    if (!chosen.includes(c)) return false;
    if (c === 'whatsapp') return !!user.whatsapp?.optIn;
    if (c === 'email') return !!user.email;
    return true;
  });
}

/** Seconds until the end of the current delivery window (+2s so the last write lands first). */
export function windowDelaySeconds(now: number): number {
  return Math.ceil((DELIVER_WINDOW_MS - (now % DELIVER_WINDOW_MS)) / 1000) + 2;
}

export async function route(
  event: NotifyEvent,
  ticket: TicketWithId | null,
  ctx: CommandCtx,
  extra: NotifyExtra = {},
): Promise<NotifyResult> {
  const result: NotifyResult = { inbox: {}, enqueued: {}, agents: {} };
  const boardId = ticket?.boardId ?? extra.boardId;
  if (!boardId) throw new Error(`notify(${event}): no ticket and no extra.boardId`);

  const board = await getDoc(typedDoc('boards', paths.board(boardId)));
  if (!board) return result;

  const toStageId =
    event === 'stage'
      ? ((extra.changes?.stageId?.to as string | undefined) ?? ticket?.stageId)
      : undefined;

  const uids = candidates({
    event,
    actor: ctx.actor,
    ticket,
    readers: board.readerUids,
    recipients: extra.recipients,
    mentioned: extra.mentioned,
    exclude: extra.exclude,
  });
  const agentIds = agentRecipients({
    event,
    actor: ctx.actor,
    ticket,
    access: board.access,
    recipients: extra.recipients,
    mentioned: extra.mentioned,
    exclude: extra.exclude,
  });
  if (uids.length === 0 && agentIds.length === 0) return result;

  // One round trip each for everyone's pref and profile.
  const firestore = db();
  const [prefSnaps, userSnaps] = uids.length
    ? await Promise.all([
        firestore.getAll(...uids.map((u) => typedDoc('prefs', paths.pref(boardId, u)))),
        firestore.getAll(...uids.map((u) => typedDoc('users', paths.user(u)))),
      ])
    : [[], []];

  const summary =
    extra.summary ??
    summarize({
      event,
      stageName: (id) => board.stages.find((s) => s.id === id)?.name,
      changes: extra.changes,
      messageText: await messageText(ticket, extra.messageId),
      ticketTitle: ticket?.title ?? null,
      ticketState: ticket?.state,
      toStageId,
      boardName: board.name,
      direct: event === 'assigned' ? !!extra.recipients : undefined,
    });

  const groupKey = groupKeyFor(event, ticket?.id ?? null, extra.inviteId);
  const actor =
    ctx.actor === SYSTEM_ACTOR || event === 'dueSoon' || event === 'overdue' ? null : ctx.actor;
  const now = ctx.now;
  const minute = Math.floor(now / DELIVER_WINDOW_MS);

  // Agents: one inbox event each; the line names who did it (an explicit
  // summary — a bulk digest's — already does).
  const agentType = agentEventType(event);
  if (agentIds.length && agentType && ticket) {
    const byName = actor ? await actorName({ actor }, boardId) : null;
    result.agents = await writeAgentEvents(
      agentType,
      ticket,
      ctx,
      agentIds,
      {
        messageId: extra.messageId,
        summary: extra.summary
          ? agentSummary(null, extra.summary, ticket.key)
          : agentSummary(byName, summary, ticket.key),
      },
      actor,
    );
  }
  if (uids.length === 0) return result;

  await Promise.all(
    uids.map(async (uid, i) => {
      const user = userSnaps[i]!.exists ? (userSnaps[i]!.data() as User) : undefined;
      if (!user || user.deletedAt) return;
      const pref = prefSnaps[i]!.exists ? (prefSnaps[i]!.data() as BoardPref) : undefined;
      if (!prefAllows(uid, event, ticket, pref, { toStageId })) return;

      const inboxId = await writeInbox(uid, groupKey, {
        event,
        boardId,
        ticketId: ticket?.id ?? null,
        ticketKey: ticket?.key ?? null,
        ticketTitle: ticket?.title ?? null,
        inviteId: extra.inviteId ?? null,
        actor,
        via: ctx.via,
        summary,
        ...(extra.messageId ? { messageId: extra.messageId } : {}),
        groupKey,
        createdAt: now,
      });
      result.inbox[uid] = inboxId;

      const channels = outChannels(user, event);
      result.enqueued[uid] = channels;
      if (channels.length === 0) return;
      await ports().queue.enqueue(
        'deliver',
        { uid, groupKey, inboxIds: [inboxId], channels },
        { name: `${uid}:${groupKey}:${minute}`, delaySeconds: windowDelaySeconds(now) },
      );
    }),
  );
  return result;
}

type InboxFresh = Omit<InboxItem, 'count' | 'readAt' | 'archivedAt' | 'snoozedUntil'>;

/**
 * Write or collapse the person's row for this groupKey. The row id IS the
 * groupKey, so the collapse is a single-document transaction: an unread,
 * unarchived row counts up and moves to the top; a read or archived one is
 * replaced by a fresh row (count 1) — new activity resurfaces it.
 */
export async function writeInbox(
  uid: string,
  groupKey: string,
  fresh: InboxFresh,
): Promise<string> {
  const id = inboxIdFor(groupKey);
  const ref = typedDoc('inbox', paths.inboxItem(uid, id));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data() : undefined;
    const open = prev && prev.readAt === null && prev.archivedAt === null;
    const row: InboxItem = {
      ...fresh,
      count: open ? prev.count + 1 : 1,
      readAt: null,
      archivedAt: null,
      snoozedUntil: open ? prev.snoozedUntil : null,
    };
    // A collapsed comment row should deep-link to the NEWEST message, and one
    // without a message id must not keep a stale one.
    tx.set(ref, row);
  });
  return id;
}

/**
 * The quoted line in a notification. §W: the message is a row on the ticket
 * the caller already holds, so this costs no read at all for anything recent.
 */
async function messageText(
  ticket: TicketWithId | null,
  messageId?: string,
): Promise<string | undefined> {
  if (!ticket || !messageId) return undefined;
  // Deliberately NOT the caller's snapshot: after-commit effects are handed
  // the ticket as the command saw it, which can predate the message it names.
  const msg = await getMessage(ticket.boardId, ticket.id, messageId);
  return msg && !msg.deletedAt ? msg.body.text : undefined;
}

/** The exported NotifyFn: route(), with failures logged instead of thrown into the command. */
export const notify: NotifyFn = async (event, ticket, ctx, extra) => {
  try {
    await route(event, ticket, ctx, extra);
  } catch (e) {
    console.error(`[notify] ${event} ${ticket?.key ?? extra?.boardId ?? ''} failed`, e);
  }
};
