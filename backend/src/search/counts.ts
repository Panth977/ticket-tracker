/**
 * board.counts — { active, done, overdue } — as a pure function of one
 * ticket, so onTicketWritten can bump the board by (after − before) with
 * FieldValue.increment instead of recounting the board on every write.
 *
 *   state ≠ 'active' (archived)                → counts nowhere
 *   stageCategory 'done'                      → done
 *   stageCategory 'cancelled'                 → nowhere
 *   otherwise (backlog / todo / active)       → active, and overdue when its due date has passed
 *
 * OVERDUE AND TIME. A ticket becomes overdue by the clock, which no write
 * notices; deadlineSweep recomputes counts.overdue for every board it
 * touches (app/backend.json). Writes still move a ticket in or out of
 * overdue (completed, due date moved), and both sides are judged at the SAME
 * instant (the event time) so a write that changes nothing about the ticket's
 * deadline contributes 0 even if the deadline passed between the two writes.
 * deadlineSweep should use ticketCountBuckets() too, so the two agree.
 */
import type { Board, Ticket } from '@tm/shared';
import { isOverdue } from '@tm/shared/logic/time';

export type BoardCounts = Board['counts'];
export type CountFields = Pick<Ticket, 'state' | 'stageCategory' | 'dueAt' | 'dueAllDay'>;

export const ZERO_COUNTS: BoardCounts = { active: 0, done: 0, overdue: 0 };

/**
 * All-day due dates end at the end of their UTC day: a board has no time
 * zone of its own, and the count is a board-wide number, not a per-viewer one.
 */
export const COUNTS_TZ = 'UTC';

export function ticketCountBuckets(t: CountFields | undefined | null, now: number): BoardCounts {
  if (!t || t.state !== 'active') return { ...ZERO_COUNTS };
  if (t.stageCategory === 'done') return { active: 0, done: 1, overdue: 0 };
  if (t.stageCategory === 'cancelled') return { ...ZERO_COUNTS };
  const overdue = isOverdue(t.dueAt, now, { allDay: t.dueAllDay, tz: COUNTS_TZ }) ? 1 : 0;
  return { active: 1, done: 0, overdue };
}

/** after − before, per bucket. */
export function countsDelta(
  before: CountFields | undefined | null,
  after: CountFields | undefined | null,
  now: number,
): BoardCounts {
  const b = ticketCountBuckets(before, now);
  const a = ticketCountBuckets(after, now);
  return { active: a.active - b.active, done: a.done - b.done, overdue: a.overdue - b.overdue };
}

export const isZeroDelta = (d: BoardCounts) => !d.active && !d.done && !d.overdue;
