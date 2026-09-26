/**
 * Firestore → search index / board counts. The triggers are thin wrappers
 * around these.
 *
 * Phase 15 (§W): the ticket document carries its own recent messages, so a
 * reindex is ONE read and onMessageWritten has nothing left to do — a message
 * write IS a ticket write, and onTicketWritten already sees it.
 *
 * REINDEX FROM THE CURRENT DOCUMENT, NOT THE EVENT. Firestore triggers are
 * at-least-once and unordered; building the index doc from the event's
 * `after` would let a late, stale event overwrite a newer one. Reading the
 * ticket (and its last messages) at handling time makes every run converge
 * on the present state, so a duplicate or reordered event is harmless.
 */
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { COLLECTIONS, paths, type SearchIndex } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { typedDoc } from '../runtime/converters.js';
import { db } from '../runtime/firebase.js';
import { type BoardCounts, isZeroDelta } from './counts.js';
import { buildTicketDoc } from './doc.js';
import { INDEXED_MESSAGES } from './schema.js';

export type ReindexResult = 'upserted' | 'deleted' | 'missing';

export interface ReindexOptions {
  /**
   * What a missing ticket means. 'delete' (onTicketWritten): it was deleted.
   * 'ignore' (onMessageWritten): the thread is being torn down with its
   * ticket — the ticket's own event owns the index doc.
   */
  onMissing?: 'delete' | 'ignore';
}

/** The index the triggers write to (ports().search, so tests can swap it). */
const index = (): SearchIndex => ports().search;

/** Bring the index doc for one ticket in line with Firestore. */
export async function reindexTicket(
  boardId: string,
  ticketId: string,
  { onMissing = 'delete' }: ReindexOptions = {},
): Promise<ReindexResult> {
  const snap = await typedDoc('tickets', paths.ticket(boardId, ticketId)).get();
  const ticket = snap.data();
  if (!ticket) {
    if (onMissing === 'ignore') return 'missing';
    await index().delete(ticketId);
    return 'deleted';
  }

  // §W: the thread is on the ticket. Newest last inline, so take the tail and
  // over-fetch so deleted / system lines still leave 20 comments.
  const inline = ticket.recentMessages ?? [];
  const msgs = inline.slice(Math.max(0, inline.length - INDEXED_MESSAGES * 2)).reverse();
  await index().upsert(buildTicketDoc({ boardId, ticketId }, ticket, msgs));
  return 'upserted';
}

// ─── once per event ──────────────────────────────────────────────────────────

/**
 * _triggerEvents/{eventId} — a marker written in the SAME transaction as a
 * non-idempotent effect (a counter bump), so a redelivered event is a no-op.
 * Server-only (rules deny unknown collections); `expiresAt` is for a TTL
 * policy — a redelivery comes within minutes, not weeks.
 */
export const TRIGGER_EVENTS = COLLECTIONS.triggerEvents;
export const TRIGGER_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const markerRef = (eventId: string) =>
  // Event ids are opaque; keep them one path segment.
  db().collection(TRIGGER_EVENTS).doc(eventId.replace(/\//g, '_'));

/**
 * Apply `delta` to boards/{boardId}.counts exactly once for `eventId`.
 * Returns false when the event was already applied, the delta is zero, or
 * the board no longer exists (boardDelete removes tickets after the board).
 */
export async function applyCountsOnce(
  eventId: string,
  boardId: string,
  delta: BoardCounts,
  now: number,
): Promise<boolean> {
  if (isZeroDelta(delta)) return false;
  const boardRef = db().doc(paths.board(boardId));
  const marker = markerRef(eventId);
  return db().runTransaction(async (tx) => {
    const [m, b] = await Promise.all([tx.get(marker), tx.get(boardRef)]);
    if (m.exists || !b.exists) return false;
    const patch: Record<string, FieldValue> = {};
    for (const k of ['active', 'done', 'overdue'] as const) {
      if (delta[k]) patch[`counts.${k}`] = FieldValue.increment(delta[k]);
    }
    tx.update(boardRef, patch);
    tx.set(marker, {
      kind: 'boardCounts',
      boardId,
      delta,
      at: now,
      expiresAt: Timestamp.fromMillis(now + TRIGGER_EVENT_TTL_MS),
    });
    return true;
  });
}
