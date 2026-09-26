/**
 * My work (app.json › My work): what is on ME across every board, from
 * collection-group queries — no board list needed, and each query is
 * provable by the collection-group rule
 *   allow read: auth.uid in assigneeUids || auth.uid in watcherUids || auth.uid == createdBy
 * straight from its own where-clause (no get()).
 *
 *   assigned  assigneeUids array-contains me, stageCategory in open, orderBy dueAt
 *             (index: group tickets assigneeUids CONTAINS, stageCategory, dueAt)
 *   created   createdBy == me
 *   watching  watcherUids array-contains me
 *
 * Pure helpers (tiles, sorting) live here and are unit-tested.
 */
import type { Millis, StageCategory, Ticket } from '@tm/shared';
import { dayRange, isOverdue, weekRange } from '@tm/shared/logic/time';
import type { QuerySpec } from '$lib/stores/live';

export type MyTicket = Ticket & { id: string; boardId: string };

export const SCOPES = [
  { id: 'assigned', label: 'Assigned to me' },
  { id: 'created', label: 'Created by me' },
  { id: 'watching', label: 'Watching' },
] as const;
export type Scope = (typeof SCOPES)[number]['id'];

export const TILES = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Due today' },
  { id: 'week', label: 'This week' },
  { id: 'committed', label: 'Committed' },
] as const;
export type Tile = (typeof TILES)[number]['id'];

export const OPEN_CATEGORIES: StageCategory[] = ['backlog', 'todo', 'active'];
const LIMIT = 300;

export function parseScope(raw: string | null | undefined): Scope {
  return SCOPES.some((s) => s.id === raw) ? (raw as Scope) : 'assigned';
}
export function parseTile(raw: string | null | undefined): Tile | null {
  return TILES.some((t) => t.id === raw) ? (raw as Tile) : null;
}

/** The collection-group query for a scope. */
export function scopeQuery(scope: Scope, uid: string): QuerySpec {
  switch (scope) {
    case 'assigned':
      return {
        path: 'tickets',
        group: true,
        where: [
          ['assigneeUids', 'array-contains', uid],
          ['stageCategory', 'in', OPEN_CATEGORIES],
        ],
        orderBy: [['dueAt', 'asc']],
        limit: LIMIT,
      };
    case 'created':
      return { path: 'tickets', group: true, where: [['createdBy', '==', uid]], limit: LIMIT };
    case 'watching':
      return {
        path: 'tickets',
        group: true,
        where: [['watcherUids', 'array-contains', uid]],
        limit: LIMIT,
      };
  }
}

/** Still work: active state, stage not done / cancelled. */
export function isOpenWork(t: Pick<Ticket, 'state' | 'stageCategory'>): boolean {
  return t.state === 'active' && OPEN_CATEGORIES.includes(t.stageCategory);
}

export function overdue(t: Pick<Ticket, 'dueAt' | 'dueAllDay'>, now: Millis, tz: string): boolean {
  return isOverdue(t.dueAt, now, { allDay: t.dueAllDay, tz });
}

/** Which tiles a ticket counts toward (tickets can be in several: due today AND committed). */
export function tilesOf(t: MyTicket, uid: string, now: Millis, tz: string): Set<Tile> {
  const out = new Set<Tile>();
  if (t.dueAt != null) {
    if (overdue(t, now, tz)) out.add('overdue');
    else {
      const d = dayRange(now, tz);
      const w = weekRange(now, tz);
      if (t.dueAt >= d.start && t.dueAt < d.end) out.add('today');
      if (t.dueAt >= w.start && t.dueAt < w.end) out.add('week');
    }
  }
  if (t.commitments?.[uid] != null) out.add('committed');
  return out;
}

export function tileCounts(
  list: MyTicket[],
  uid: string,
  now: Millis,
  tz: string,
): Record<Tile, number> {
  const c: Record<Tile, number> = { overdue: 0, today: 0, week: 0, committed: 0 };
  for (const t of list) for (const k of tilesOf(t, uid, now, tz)) c[k]++;
  return c;
}

/** Overdue first, then by due date (undated last), then most recently touched. */
export function sortWork(list: MyTicket[], now: Millis, tz: string): MyTicket[] {
  return [...list].sort((a, b) => {
    const oa = overdue(a, now, tz) ? 0 : 1;
    const ob = overdue(b, now, tz) ? 0 : 1;
    if (oa !== ob) return oa - ob;
    const da = a.dueAt ?? Infinity;
    const db = b.dueAt ?? Infinity;
    if (da !== db) return da - db;
    return (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt);
  });
}

/** Rows for the table: open work in the scope, narrowed to a tile when one is picked. */
export function visibleWork(
  list: MyTicket[],
  tile: Tile | null,
  uid: string,
  now: Millis,
  tz: string,
): MyTicket[] {
  const open = list.filter(isOpenWork);
  const picked = tile ? open.filter((t) => tilesOf(t, uid, now, tz).has(tile)) : open;
  return sortWork(picked, now, tz);
}
