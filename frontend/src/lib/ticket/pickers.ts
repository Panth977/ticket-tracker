/**
 * The @ and # pickers for this ticket's editors (composer, description,
 * message edit): people ON THIS BOARD matched by name or email and shown with
 * picture + email (agents with their badge); tickets from the search index (or the dev fallback).
 */
import type { BoardMember } from '@tm/shared';
import { principalSuggestItems } from '$lib/people/pickers';
import { searchTickets, type SuggestItem } from '$lib/editor';
import type { TicketCtx } from './context';

const STAGE_WORD: Record<string, string> = { done: 'done', cancelled: 'cancelled' };

/**
 * The @ menu's people AND agents on this board (agents.html §D); agents'
 * detail reads 'Agent · description'. Delegates to $lib/people.
 */
export function peopleItems(
  members: readonly BoardMember[],
  query: string,
  max = 8,
): Promise<SuggestItem[]> {
  return principalSuggestItems(members, query, max);
}

export async function ticketItems(
  t: Pick<TicketCtx, 'boardId' | 'ticketId'>,
  query: string,
): Promise<SuggestItem[]> {
  const hits = await searchTickets(query, { boardId: t.boardId, exclude: [t.ticketId] });
  return hits.map((h) => ({
    id: h.ticketId,
    kind: 'ticket' as const,
    ticketId: h.ticketId,
    key: h.key,
    label: h.title,
    detail:
      h.state && h.state !== 'active'
        ? h.state
        : h.stageCategory
          ? STAGE_WORD[h.stageCategory]
          : undefined,
  }));
}

/** EditorOptions pieces bound to the ticket context (reads stay live through the getters). */
export function ticketPickers(t: TicketCtx) {
  return {
    people: (q: string) => peopleItems(t.members, q),
    tickets: (q: string) => ticketItems(t, q),
    nameOf: (uid: string) => t.members.find((m) => m.uid === uid)?.name,
  };
}
