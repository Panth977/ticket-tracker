/**
 * diff(before, after) — what changed, as activity and as notification copy
 * (backend.json proxyFunctions.diff).
 *
 * Compares the fields a person would call a change:
 *   title, description, stage, priority, tags, assignees, dates, estimate,
 *   fields.*, links (+ state and per-person commitments)
 * and ignores derived ones: counts, rank, lastActivityAt, updatedAt,
 * stageCategory, watchers, refs, dueNotified …
 *
 * Values are RAW IDS (activity rows store them; the UI resolves names).
 * Set-like fields (tags, assignees, links, multi-valued custom fields) compare
 * order-insensitively — re-ordering chips is not a change.
 */
import type { Ticket } from '../schema/ticket.js';

export type Change = { from: unknown; to: unknown };
export type Changes = Record<string, Change>;

/** The ticket fields diff reads. */
export type DiffTicket = Pick<
  Ticket,
  | 'title'
  | 'description'
  | 'stageId'
  | 'priorityId'
  | 'tagIds'
  | 'assigneeUids'
  | 'startAt'
  | 'dueAt'
  | 'dueAllDay'
  | 'estimate'
  | 'fields'
  | 'links'
  | 'state'
  | 'commitments'
>;

/** Structural equality; arrays compare as SETS when `asSet`. */
export function sameValue(a: unknown, b: unknown, asSet = false): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    if (asSet) {
      const key = (x: unknown) => JSON.stringify(canonical(x));
      const bs = new Set(b.map(key));
      return a.every((x) => bs.has(key(x)));
    }
    return a.every((x, i) => sameValue(x, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).filter(
      (k) => (a as Record<string, unknown>)[k] !== undefined,
    );
    const kb = Object.keys(b as object).filter(
      (k) => (b as Record<string, unknown>)[k] !== undefined,
    );
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/** Key-sorted copy, so JSON.stringify is order-independent. */
function canonical(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === 'object') {
    return Object.fromEntries(
      Object.keys(x)
        .sort()
        .map((k) => [k, canonical((x as Record<string, unknown>)[k])]),
    );
  }
  return x;
}

export function diff(before: DiffTicket, after: DiffTicket): Changes {
  const out: Changes = {};
  const put = (key: string, from: unknown, to: unknown, asSet = false) => {
    if (!sameValue(from, to, asSet)) out[key] = { from: from ?? null, to: to ?? null };
  };

  put('title', before.title, after.title);
  // The doc decides whether it changed; the activity row carries the plain text.
  if (!sameValue(before.description?.doc ?? null, after.description?.doc ?? null)) {
    out.description = {
      from: before.description?.text ?? null,
      to: after.description?.text ?? null,
    };
  }
  put('stage', before.stageId, after.stageId);
  put('priority', before.priorityId, after.priorityId);
  put('tags', before.tagIds, after.tagIds, true);
  put('assignees', before.assigneeUids, after.assigneeUids, true);
  put('start', before.startAt, after.startAt);
  put('due', before.dueAt, after.dueAt);
  put('dueAllDay', before.dueAllDay, after.dueAllDay);
  put('estimate', before.estimate, after.estimate);
  put('state', before.state, after.state);
  put('links', before.links, after.links, true);

  for (const uid of new Set([
    ...Object.keys(before.commitments ?? {}),
    ...Object.keys(after.commitments ?? {}),
  ])) {
    put(`commitments.${uid}`, before.commitments?.[uid], after.commitments?.[uid]);
  }
  for (const id of new Set([
    ...Object.keys(before.fields ?? {}),
    ...Object.keys(after.fields ?? {}),
  ])) {
    // Absent and null both mean 'not set'; list-valued fields are sets.
    put(`fields.${id}`, before.fields?.[id], after.fields?.[id], true);
  }
  return out;
}

/** For set-like changes: who / what was added and removed ('assigned' notifications). */
export function setDelta<T>(
  from: readonly T[] | null | undefined,
  to: readonly T[] | null | undefined,
): { added: T[]; removed: T[] } {
  const f = from ?? [];
  const t = to ?? [];
  return { added: t.filter((x) => !f.includes(x)), removed: f.filter((x) => !t.includes(x)) };
}

/** The keys of a diff as public change names (webhook `changes`): 'fields.f_x' → 'fields'. */
export function changedKeys(changes: Changes): string[] {
  return [...new Set(Object.keys(changes).map((k) => k.split('.')[0]!))];
}
