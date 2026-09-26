/**
 * boards/{boardId}/tickets/{ticketId} onWrite — DERIVED DATA ONLY, never
 * business rules (app/backend.json services.onTicketWritten):
 *
 *   1. the Typesense document: upsert, or delete when the ticket is gone
 *   2. board.counts (active / done / overdue) via FieldValue.increment
 *
 * IDEMPOTENT BY EVENT ID. Triggers are at-least-once: a counter bumped twice
 * is a board that says 41 when there are 40, so the increment commits
 * together with an _triggerEvents/{eventId} marker (sync.applyCountsOnce).
 * The index side is idempotent by construction: it re-reads the ticket.
 */
import type { Ticket } from '@tm/shared';
import { defineTrigger, type TicketWrittenEvent } from '../runtime/functions.js';
import { countsDelta } from '../search/counts.js';
import { indexedFieldsChanged } from '../search/doc.js';
import { applyCountsOnce, reindexTicket } from '../search/sync.js';

export async function handleTicketWritten(event: TicketWrittenEvent): Promise<void> {
  const { boardId, ticketId } = event.params;
  const before = event.data?.before.exists ? (event.data.before.data() as Ticket) : undefined;
  const after = event.data?.after.exists ? (event.data.after.data() as Ticket) : undefined;
  if (!before && !after) return;

  // Judge overdue-ness on both sides at the same instant: the event time.
  const now = Date.parse(event.time) || Date.now();

  await Promise.all([
    // Rank moves, counts, lastActivityAt … touch nothing the index stores.
    indexedFieldsChanged(before, after) ? reindexTicket(boardId, ticketId) : Promise.resolve(),
    applyCountsOnce(event.id, boardId, countsDelta(before, after, now), now),
  ]);
}

defineTrigger('onTicketWritten', handleTicketWritten);
