/**
 * What a drop means. Kanban columns (and swimlanes) are groups of the view
 * engine; dragging a card from group A to group B rewrites the ticket's value
 * for the grouping field — ONE ticketUpdate on ONE document (spec: "drag writes
 * { stageId, rank } — one document").
 *
 * Multi-valued fields (assignees, tags, multiSelect, people) swap the value the
 * card was dragged FROM for the one it was dropped ON, keeping the rest:
 * a ticket assigned to Ana + Raj dragged from Ana's column to Lee's ends up
 * with Raj + Lee. Dropping on 'none' clears the field.
 */
import type { Board, TicketPatch, TicketWithId } from '@tm/shared';
import { rankAt } from '@tm/shared/logic/rank';
import { NONE_KEY } from '@tm/shared/logic/view';
import { fieldInfo } from './fields';

type MoveTicket = Pick<
  TicketWithId,
  'stageId' | 'priorityId' | 'assigneeUids' | 'tagIds' | 'fields'
>;
type BoardShape = Pick<Board, 'stages' | 'priorities' | 'tags' | 'fields'>;

const swap = (list: readonly string[], from: string, to: string): string[] => {
  const rest = list.filter((x) => x !== from && x !== to);
  return to === NONE_KEY ? rest : [...rest, to];
};

/**
 * The patch that moves `t` from group `fromKey` to group `toKey` of `by`.
 * null = nothing to change (same group) or a field that cannot be written by a drop.
 */
export function movePatch(
  by: string | null | undefined,
  fromKey: string,
  toKey: string,
  t: MoveTicket,
  board: BoardShape,
): TicketPatch | null {
  if (!by || fromKey === toKey) return null;
  const to = toKey === NONE_KEY ? null : toKey;
  switch (by) {
    case 'stage':
      return to ? { stageId: to } : null; // every ticket has a stage
    case 'priority':
      return { priorityId: to };
    case 'assignee':
      return { assigneeUids: toKey === NONE_KEY ? [] : swap(t.assigneeUids, fromKey, toKey) };
    case 'tag':
      return { tagIds: toKey === NONE_KEY ? [] : swap(t.tagIds, fromKey, toKey) };
  }
  const info = fieldInfo(board, by);
  if (!info?.def) return null;
  const id = info.def.id;
  const cur = t.fields[id];
  switch (info.kind) {
    case 'select':
    case 'person':
      return { fields: { [id]: to } };
    case 'multiSelect':
    case 'people': {
      const list = Array.isArray(cur) ? cur : [];
      return { fields: { [id]: toKey === NONE_KEY ? [] : swap(list, fromKey, toKey) } };
    }
    case 'checkbox':
      return { fields: { [id]: toKey === 'true' } };
    default:
      return null;
  }
}

/** Merge two patches (column + swimlane moves), `fields` merged per key. */
export function mergePatches(a: TicketPatch | null, b: TicketPatch | null): TicketPatch | null {
  if (!a) return b;
  if (!b) return a;
  const out: TicketPatch = { ...a, ...b };
  if (a.fields || b.fields) out.fields = { ...a.fields, ...b.fields };
  return out;
}

/**
 * Where a dropped ticket lands in a column: its neighbours (for ticketUpdate's
 * `rank: { after, before }`) and a local rank for the optimistic overlay.
 * `column` is the column as displayed AFTER the drop (it includes the ticket).
 */
export function dropPosition<T extends { id: string; rank: string }>(
  column: readonly T[],
  ticketId: string,
): { after?: string; before?: string; rank: string } | null {
  const i = column.findIndex((t) => t.id === ticketId);
  if (i === -1) return null;
  const prev = column[i - 1];
  const next = column[i + 1];
  const others = column.filter((t) => t.id !== ticketId).map((t) => t.rank);
  let rank: string;
  try {
    rank = rankAt(others, i);
  } catch {
    // Neighbours out of order (the view is sorted by something else): let the server decide.
    rank = column[i]!.rank;
  }
  return { after: prev?.id, before: next?.id, rank };
}

/** The optimistic overlay for a patch: dotted keys for custom fields so other fields survive. */
export function overlayFor(
  patch: TicketPatch,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...extra };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'fields' && v && typeof v === 'object') {
      for (const [fid, fv] of Object.entries(v as Record<string, unknown>))
        out[`fields.${fid}`] = fv;
    } else if (k === 'commitments') {
      continue;
    } else out[k] = v;
  }
  return out;
}
