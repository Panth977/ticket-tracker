/**
 * Pure: ticket (+ its recent thread) → the TicketDoc stored in the index.
 * No I/O here, so the shape is unit-testable and identical whichever
 * trigger builds it.
 */
import type { Message, Ticket, TicketDoc } from '@tm/shared';
import { INDEXED_MESSAGES, MAX_INDEX_TEXT } from './schema.js';

/** The fields of a Ticket the index reads — a write touching none of them needs no reindex. */
export const INDEXED_TICKET_FIELDS = [
  'key',
  'title',
  'description',
  'stageCategory',
  'assigneeUids',
  'state',
] as const satisfies readonly (keyof Ticket)[];

/** Whether a message contributes text: live comments only (system lines are noise). */
export function isIndexedMessage(m: Pick<Message, 'kind' | 'deletedAt'>): boolean {
  return m.kind === 'comment' && m.deletedAt == null;
}

/**
 * @param messages newest first (as queried); only the first INDEXED_MESSAGES
 *        indexable ones are used, stored oldest → newest.
 */
export function buildTicketDoc(
  ids: { boardId: string; ticketId: string },
  ticket: Pick<Ticket, (typeof INDEXED_TICKET_FIELDS)[number] | 'updatedAt'>,
  messages: readonly Pick<Message, 'kind' | 'deletedAt' | 'body'>[] = [],
): TicketDoc {
  const thread = messages
    .filter(isIndexedMessage)
    .slice(0, INDEXED_MESSAGES)
    .map((m) => m.body.text.trim())
    .filter(Boolean)
    .reverse();
  const description = ticket.description?.text.trim() ?? '';
  let text = [description, ...thread].filter(Boolean).join('\n');
  if (text.length > MAX_INDEX_TEXT) {
    // Keep the description's start and the NEWEST messages: drop from the middle.
    const head = description.slice(0, MAX_INDEX_TEXT / 2);
    const tail = thread.join('\n');
    text = head + '\n' + tail.slice(Math.max(0, tail.length - (MAX_INDEX_TEXT - head.length - 1)));
  }
  return {
    id: ids.ticketId,
    boardId: ids.boardId,
    key: ticket.key,
    title: ticket.title,
    text,
    stageCategory: ticket.stageCategory,
    assigneeUids: [...ticket.assigneeUids],
    state: ticket.state,
    updatedAt: ticket.updatedAt,
  };
}

/** The folded thread text, so a write that changed no comment needs no reindex. */
const threadText = (t: Partial<Ticket> | undefined): string =>
  (t?.recentMessages ?? [])
    .filter(isIndexedMessage)
    .map((m) => m.body.text.trim())
    .join('\n');

/**
 * True when before/after differ in a field the index stores.
 *
 * Phase 15 (§W): the thread is part of the ticket, so this also compares the
 * folded message text — posting a comment is a ticket write now, and
 * onTicketWritten is the only trigger that has to notice it.
 */
export function indexedFieldsChanged(
  before: Partial<Ticket> | undefined,
  after: Partial<Ticket> | undefined,
): boolean {
  if (!before || !after) return true;
  if (threadText(before) !== threadText(after)) return true;
  return INDEXED_TICKET_FIELDS.some((f) => {
    const a = f === 'description' ? (before.description?.text ?? null) : before[f];
    const b = f === 'description' ? (after.description?.text ?? null) : after[f];
    return JSON.stringify(a) !== JSON.stringify(b);
  });
}
