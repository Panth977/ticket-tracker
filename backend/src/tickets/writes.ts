/**
 * Small builders for the things a ticket command writes beside the ticket's
 * own fields: activity rows, system lines in the thread, file rows, and the
 * display name of the actor.
 *
 * Phase 15 (§W): none of these is a document any more — they are rows appended
 * to the ticket document through TicketWriter (tickets/doc.ts). The builders
 * are unchanged; only where the result lands is.
 */
import {
  EMPTY_DOC,
  isAgentId,
  paths,
  type Agent,
  type Activity,
  type Attachment,
  type BoardMember,
  type CommandCtx,
  type Message,
  type PMNode,
  type RichText,
  type TicketFile,
  type User,
} from '@tm/shared';
import { derive } from '@tm/shared/logic/index';
import { db } from '../runtime/firebase.js';

/**
 * Who is acting, as the thread and activity show it: the members/ row on this
 * board (people AND agents), else users/{uid} or agents/{agentId}. Cosmetic:
 * never fails.
 */
export async function actorName(ctx: Pick<CommandCtx, 'actor'>, boardId?: string): Promise<string> {
  try {
    if (boardId) {
      const m = await db().doc(paths.member(boardId, ctx.actor)).get();
      if (m.exists) return (m.data() as BoardMember).name;
    }
    if (isAgentId(ctx.actor)) {
      const a = await db().doc(paths.agent(ctx.actor)).get();
      if (a.exists) return (a.data() as Agent).name;
      return 'Agent';
    }
    const u = await db().doc(paths.user(ctx.actor)).get();
    if (u.exists) return (u.data() as User).name;
  } catch {
    /* fall through */
  }
  return 'Someone';
}

/**
 * The token's name when a token made the change ('via token orch-eng-builder'),
 * as stamped on activity rows and messages. Absent for app writes.
 */
export function viaTokenOf(ctx: Pick<CommandCtx, 'keyName'>): { viaToken?: string } {
  return ctx.keyName ? { viaToken: ctx.keyName.slice(0, 80) } : {};
}

export function activityDoc(
  ctx: Pick<CommandCtx, 'actor' | 'via' | 'now' | 'keyName'>,
  action: Activity['action'],
  changes: Activity['changes'],
  viaGrant?: string[],
): Activity {
  return {
    action,
    changes,
    actor: ctx.actor,
    via: ctx.via,
    ...viaTokenOf(ctx),
    ...(viaGrant ? { viaGrant } : {}),
    createdAt: ctx.now,
  };
}

/** A RichText from inline nodes in one paragraph (system lines). */
export function richFromInline(content: PMNode[]): RichText {
  const doc = { type: 'doc' as const, content: [{ type: 'paragraph', content }] };
  const d = derive(doc);
  return { doc, text: d.text, mentions: [], refs: [] };
}

export const EMPTY_RICH: RichText = { doc: EMPTY_DOC, text: '', mentions: [], refs: [] };

/**
 * A system line in the thread: 'Priya pinned a message', 'Referenced from
 * #ENG-40'. authorUid is null (system lines have no author); authorName
 * carries who caused it, and `via` where it came from.
 */
export function systemMessage(
  ctx: Pick<CommandCtx, 'via' | 'now' | 'keyName'>,
  byName: string,
  body: RichText,
): Message {
  return {
    kind: 'system',
    body,
    authorUid: null,
    authorName: byName,
    via: ctx.via,
    ...viaTokenOf(ctx),
    replyTo: null,
    attachments: [],
    reactions: {},
    pinnedAt: null,
    pinnedBy: null,
    editedAt: null,
    deletedAt: null,
    createdAt: ctx.now,
  };
}

/** `ticket.files` rows for attachments that arrived with a message or the description. */
export function fileRows(
  attachments: readonly Attachment[],
  source: TicketFile['source'],
  messageId: string | null,
  now: number,
): TicketFile[] {
  return attachments.map((a) => ({ ...a, source, messageId, createdAt: now, deletedAt: null }));
}
