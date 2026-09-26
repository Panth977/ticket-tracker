/**
 * Phase 3 — TASK LISTS INSIDE THE TICKET (docs/plan/agents.html §L2), phase 15
 * (§W) inside the ticket DOCUMENT: `ticket.tasklists`, an array of
 * StoredTasklist in `position` order.
 *
 * An agent publishes its plan as a checklist and ticks it off as it works. The
 * list used to be its own document so that ticking an item did not rewrite the
 * ticket; §W reversed that trade deliberately — a card already shows '4/7' and
 * a board shows hundreds of cards, so reading the lists from the snapshot the
 * board already has is what removes a listener per card. Ticking an item is
 * now one write on the ticket.
 *
 * What the thread hears (§L2): 'Creating a list and finishing it each add a
 * system line to the thread. Every change to an item does not, to keep the
 * thread readable.'
 */
import type { StoredTasklist, TaskItem, TaskItemInput } from '@tm/shared';
import type { ServerCtx } from '../runtime/context.js';
import type { TicketWriter } from './doc.js';
import { richFromInline, systemMessage } from './writes.js';

/**
 * Item ids and timestamps for a whole-list write. An item keeps its id (and
 * its updatedAt, when nothing about it changed), so replacing a plan does not
 * make every row look touched.
 */
export function mergeItems(
  input: readonly TaskItemInput[],
  previous: readonly TaskItem[],
  now: number,
  newId: () => string,
): TaskItem[] {
  const before = new Map(previous.map((i) => [i.id, i]));
  const used = new Set<string>();
  return input.map((raw) => {
    let id = raw.id ?? newId();
    // A repeated id in one request would collapse two rows into one.
    while (used.has(id)) id = newId();
    used.add(id);
    const status = raw.status ?? before.get(id)?.status ?? 'todo';
    const note = raw.note ?? before.get(id)?.note;
    const old = before.get(id);
    const same = old && old.title === raw.title && old.status === status && old.note === note;
    return {
      id,
      title: raw.title,
      status,
      ...(note !== undefined && note !== '' ? { note } : {}),
      updatedAt: same ? old.updatedAt : now,
    };
  });
}

/** Where a new list goes: after the ones already on the ticket. */
export const nextPosition = (lists: readonly StoredTasklist[]): number =>
  lists.length ? Math.max(...lists.map((l) => l.position)) + 1 : 0;

/**
 * One of the TWO system lines a task list ever writes (§L2): 'Builder added a
 * plan: Add CSV export' and 'Builder finished the plan: Add CSV export'.
 * Ticking items writes nothing.
 */
export function writeTasklistLine(
  w: TicketWriter,
  ctx: ServerCtx,
  byName: string,
  verb: 'added' | 'finished',
  title: string,
): void {
  const text =
    verb === 'added' ? `${byName} added a plan: ${title}` : `${byName} finished the plan: ${title}`;
  w.addMessage(ctx.ids.id(), systemMessage(ctx, byName, richFromInline([{ type: 'text', text }])));
}
