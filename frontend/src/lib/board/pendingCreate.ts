/**
 * Creating a ticket without waiting (agents.html § K › Creating a ticket).
 * QuickAdd queues ticketCreate with a client-chosen ticketId; until the
 * board's listener delivers that ticket, the board shows a stand-in built from
 * the outbox entry — in the right column for any grouping, since it is a
 * normal ticket to the view engine — dimmed with a spinner and the key
 * 'KEY-…'. When the real one arrives (same id) it simply takes its place.
 * A failed create stays, with a red edge; its toast's Open reopens the form.
 */
import type { Board, CommandReq, FieldValue } from '@tm/shared';
import type { OutboxEntry } from '$lib/api';
import type { WithId } from '$lib/stores';
import type { BoardTicket } from './context.svelte';

/** What the full form needs to come back prefilled (QuickAdd's `f`). */
export interface CreateDraft {
  title: string;
  description: string;
  stageId: string;
  priorityId: string | null;
  assigneeUids: string[];
  tagIds: string[];
  dueAt: number | null;
  dueAllDay: boolean;
  startAt: number | null;
  estimate: number | null;
  fields: Record<string, FieldValue>;
}

export type PendingState = 'sending' | 'failed';

/** Sorts after every real fractional rank: a new ticket shows at the end of its column. */
const LAST_RANK = '~';

export function pendingTicket(e: OutboxEntry, board: WithId<Board>, me: string): BoardTicket {
  const i = e.input as Partial<CommandReq<'ticketCreate'>>;
  const byPos = [...board.stages].sort((a, b) => a.position - b.position);
  const stage =
    board.stages.find((s) => s.id === i.stageId) ??
    byPos.find((s) => s.category === 'todo') ??
    byPos[0];
  const id = i.ticketId ?? e.id;
  return {
    id,
    boardId: board.id,
    key: `${board.key}-…`,
    number: 0,
    title: i.title ?? '…',
    description: null,
    stageId: stage?.id ?? '',
    stageCategory: stage?.category ?? 'todo',
    priorityId: i.priorityId ?? null,
    tagIds: i.tagIds ?? [],
    state: 'active',
    rank: LAST_RANK,
    assigneeUids: i.assigneeUids ?? [],
    watcherUids: [me],
    reporter: { uid: me, name: '' },
    startAt: i.startAt ?? null,
    dueAt: i.dueAt ?? null,
    dueAllDay: i.dueAllDay ?? true,
    commitments: {},
    estimate: i.estimate ?? null,
    fields: i.fields ?? {},
    refs: [],
    referencedBy: [],
    links: [],
    counts: { messages: 0, files: 0, pinned: 0 },
    lastMessageAt: null,
    lastActivityAt: e.createdAt,
    dueNotified: {},
    createdBy: me,
    createdVia: 'app',
    createdAt: e.createdAt,
    updatedAt: e.createdAt,
    completedAt: null,
  } as BoardTicket;
}

/**
 * The stand-ins for this board's queued creates whose ticket has not arrived
 * yet, and the state of each (by ticket id).
 */
export function pendingCreates(
  entries: readonly OutboxEntry[],
  board: WithId<Board> | null,
  me: string,
  live: ReadonlySet<string>,
): { tickets: BoardTicket[]; state: Map<string, { state: PendingState; entryId: string }> } {
  const tickets: BoardTicket[] = [];
  const state = new Map<string, { state: PendingState; entryId: string }>();
  if (!board) return { tickets, state };
  for (const e of entries) {
    if (e.kind !== 'ticketCreate' || e.boardId !== board.id) continue;
    const t = pendingTicket(e, board, me);
    if (live.has(t.id)) continue;
    tickets.push(t);
    state.set(t.id, { state: e.status === 'failed' ? 'failed' : 'sending', entryId: e.id });
  }
  return { tickets, state };
}
