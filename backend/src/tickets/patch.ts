/**
 * Applying a validated patch to a ticket, and turning before → after into
 * the smallest Firestore update.
 *
 * FIELD-LEVEL MERGE, not last-write-wins on the document: only the keys that
 * changed are written, and `fields` / `commitments` per entry
 * (`fields.f_abc`, `commitments.{uid}`), so two people changing the priority
 * and a custom field at once both land. Used by ticketUpdate (inside its
 * transaction) and ticketBulk (batched).
 */
import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import type {
  BoardWithId,
  FieldValue as TmFieldValue,
  RichText,
  Ticket,
  TicketLink,
} from '@tm/shared';
import { sameValue } from '@tm/shared/logic/index';
import { findStage } from './validate.js';

/** A ticketUpdate patch after validation against the board. */
export interface CleanPatch {
  title?: string;
  description?: RichText | null;
  stageId?: string;
  priorityId?: string | null;
  tagIds?: string[];
  assigneeUids?: string[];
  startAt?: number | null;
  dueAt?: number | null;
  dueAllDay?: boolean;
  estimate?: number | null;
  commitments?: Record<string, number | null>;
  fields?: Record<string, TmFieldValue>;
  links?: TicketLink[];
  /** Added to refs (never removed: refs is description ∪ thread). */
  addRefs?: string[];
  addWatchers?: string[];
  rank?: string;
  state?: Ticket['state'];
}

/** The ticket after `p`; derived fields (stageCategory, completedAt, watchers) follow. */
export function applyPatch(board: BoardWithId, before: Ticket, p: CleanPatch, now: number): Ticket {
  const next: Ticket = structuredClone(before);
  if (p.title !== undefined) next.title = p.title;
  if (p.description !== undefined) next.description = p.description;
  if (p.stageId !== undefined && p.stageId !== before.stageId) {
    const stage = findStage(board, p.stageId);
    next.stageId = stage.id;
    next.stageCategory = stage.category;
    // completedAt is set on ENTERING 'done' and cleared on leaving it.
    if (stage.category === 'done' && before.stageCategory !== 'done') next.completedAt = now;
    if (stage.category !== 'done') next.completedAt = null;
  }
  if (p.priorityId !== undefined) next.priorityId = p.priorityId;
  if (p.tagIds !== undefined) next.tagIds = p.tagIds;
  if (p.assigneeUids !== undefined) {
    next.assigneeUids = p.assigneeUids;
    // Watchers = creator + assignees + opted-in: a new assignee starts watching.
    next.watcherUids = [...new Set([...next.watcherUids, ...p.assigneeUids])];
  }
  if (p.addWatchers?.length)
    next.watcherUids = [...new Set([...next.watcherUids, ...p.addWatchers])];
  if (p.startAt !== undefined) next.startAt = p.startAt;
  if (p.dueAt !== undefined) {
    next.dueAt = p.dueAt;
    // A new due date re-arms everyone's reminders.
    if (p.dueAt !== before.dueAt) next.dueNotified = {};
  }
  if (p.dueAllDay !== undefined) next.dueAllDay = p.dueAllDay;
  if (p.estimate !== undefined) next.estimate = p.estimate;
  if (p.commitments !== undefined) {
    for (const [uid, v] of Object.entries(p.commitments)) {
      if (v === null) delete next.commitments[uid];
      else next.commitments[uid] = v;
    }
    next.nextCommitmentAt = nextCommitment(next.commitments, now);
  }
  for (const [id, v] of Object.entries(p.fields ?? {})) {
    if (v === null) delete next.fields[id];
    else next.fields[id] = v;
  }
  if (p.links !== undefined) next.links = p.links;
  if (p.addRefs?.length) next.refs = [...new Set([...next.refs, ...p.addRefs])];
  if (p.rank !== undefined) next.rank = p.rank;
  if (p.state !== undefined) next.state = p.state;
  return next;
}

/**
 * The earliest commitment still ahead (deadlineSweep picks it up once it
 * passes). A commitment set in the past is not nudged — the person knows.
 */
export function nextCommitment(commitments: Record<string, number>, now: number): number | null {
  let min: number | null = null;
  for (const at of Object.values(commitments)) if (at > now && (min === null || at < min)) min = at;
  return min;
}

/**
 * One field of a ticket update, as PATH SEGMENTS rather than a FieldPath: the
 * segments are also the key TicketWriter dedupes on, so a computed field and a
 * caller's own value for it can never both reach Firestore (which rejects a
 * document field specified twice).
 */
export type Pair = [path: string[], value: unknown];

const TOP_LEVEL: (keyof Ticket)[] = [
  'title',
  'description',
  'stageId',
  'stageCategory',
  'completedAt',
  'priorityId',
  'tagIds',
  'assigneeUids',
  'watcherUids',
  'startAt',
  'dueAt',
  'dueAllDay',
  'dueNotified',
  'estimate',
  'nextCommitmentAt',
  'links',
  'refs',
  'rank',
  'state',
];

/** [path, value] pairs for update(): only what changed; maps per entry. */
export function updatesFor(before: Ticket, next: Ticket): Pair[] {
  const out: Pair[] = [];
  for (const k of TOP_LEVEL) {
    if (!sameValue(before[k], next[k])) out.push([[k], next[k]]);
  }
  for (const map of ['fields', 'commitments'] as const) {
    const a = before[map] as Record<string, unknown>;
    const b = next[map] as Record<string, unknown>;
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (sameValue(a[id], b[id])) continue;
      out.push([[map, id], id in b ? b[id] : FieldValue.delete()]);
    }
  }
  return out;
}

/** Flatten pairs into update()'s varargs form (FieldPath keys survive odd uids). */
export function updateArgs(pairs: readonly Pair[]): [FieldPath, unknown, ...unknown[]] {
  return pairs.flatMap(([p, v]) => [new FieldPath(...p), v]) as [FieldPath, unknown, ...unknown[]];
}
