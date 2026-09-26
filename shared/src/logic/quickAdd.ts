/**
 * Quick add — 'Fix login redirect @pri !high due:fri #ENG-40 +bug'
 * (app.json components 'Quick add'): inline tokens parsed into fields as you
 * type; whatever is left is the title.
 *
 *   @pri        assignee query  — people on this board whose name or email starts so
 *   !high       priority query  — a priority whose name starts so (or !1 = the first)
 *   due:fri     due date        — see parseDue (today, tomorrow, mon…sun, +3d, 2026-10-01, fri@17:00)
 *   #ENG-40     a ticket reference (a '#word' that is not a key stays in the title)
 *   +bug        a tag (unknown names are offered as new tags)
 *
 * parseQuickAdd is pure text; resolveQuickAdd matches the queries against the
 * board. The tokens carry offsets so the input can highlight them.
 */
import type { Board } from '../schema/board.js';
import type { Millis, Option, TicketKey, Uid } from '../types/index.js';
import { parseDue, type ParsedDue } from './time.js';
import { parseTicketKey } from './validators.js';

export type QuickAddTokenKind = 'assignee' | 'priority' | 'due' | 'ref' | 'tag' | 'text';

export interface QuickAddToken {
  kind: QuickAddTokenKind;
  /** The raw token as typed ('@pri'). */
  raw: string;
  /** The payload ('pri'). */
  value: string;
  start: number;
  end: number;
}

export interface QuickAdd {
  title: string;
  /** One per '@' token, in order. */
  assigneeQuery: string[];
  /** The last '!' token wins. */
  priorityQuery: string | null;
  /** Resolved when ctx was given and the text is a date; else null. */
  due: ParsedDue | null;
  /** What followed 'due:' (kept even when it did not parse). */
  dueText: string | null;
  refs: TicketKey[];
  tags: string[];
  tokens: QuickAddToken[];
}

export interface QuickAddCtx {
  now: Millis;
  tz: string;
  weekStartsOn?: number;
}

export function parseQuickAdd(input: string, ctx?: QuickAddCtx): QuickAdd {
  const out: QuickAdd = {
    title: '',
    assigneeQuery: [],
    priorityQuery: null,
    due: null,
    dueText: null,
    refs: [],
    tags: [],
    tokens: [],
  };
  const words: string[] = [];
  for (const m of input.matchAll(/\S+/g)) {
    const raw = m[0];
    const start = m.index;
    const tok = (kind: QuickAddTokenKind, value: string) =>
      out.tokens.push({ kind, raw, value, start, end: start + raw.length });
    let r: RegExpExecArray | null;

    if ((r = /^@(\S+)$/.exec(raw))) {
      out.assigneeQuery.push(r[1]!);
      tok('assignee', r[1]!);
    } else if ((r = /^!(\S+)$/.exec(raw))) {
      out.priorityQuery = r[1]!;
      tok('priority', r[1]!);
    } else if ((r = /^due:(\S+)$/i.exec(raw))) {
      const text = r[1]!;
      const due = ctx ? parseDue(text, ctx.now, ctx.tz, ctx.weekStartsOn) : null;
      if (ctx && !due) {
        // Not a date: leave it in the title rather than silently dropping it.
        words.push(raw);
        tok('text', raw);
        continue;
      }
      out.dueText = text;
      out.due = due;
      tok('due', text);
    } else if (raw.startsWith('#') && parseTicketKey(raw)) {
      const key = parseTicketKey(raw)!.key;
      if (!out.refs.includes(key)) out.refs.push(key);
      tok('ref', key);
    } else if ((r = /^\+([^\s+]+)$/.exec(raw))) {
      const tag = r[1]!;
      if (!out.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) out.tags.push(tag);
      tok('tag', tag);
    } else {
      words.push(raw);
    }
  }
  out.title = words.join(' ');
  return out;
}

// ───────────────────────── resolve against the board ─────────────────────────

export interface QuickAddPerson {
  uid: Uid;
  name: string;
  email: string;
}

/** People whose name (any word) or email starts with the query, best first. */
export function matchPeople<P extends QuickAddPerson>(query: string, people: readonly P[]): P[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const score = (p: P): number => {
    const name = p.name.toLowerCase();
    const email = p.email.toLowerCase();
    if (email === q || name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (email.startsWith(q)) return 2;
    if (name.split(/\s+/).some((w) => w.startsWith(q))) return 3;
    return -1;
  };
  return people
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.p.name.localeCompare(b.p.name))
    .map((x) => x.p);
}

/** '!high' / '!hi' → the High option; '!1' → the first priority by position. */
export function matchOption(query: string, options: readonly Option[]): Option | null {
  const sorted = [...options].sort((a, b) => a.position - b.position);
  if (/^\d+$/.test(query)) return sorted[Number(query) - 1] ?? null;
  const q = query.toLowerCase();
  return (
    sorted.find((o) => o.name.toLowerCase() === q) ??
    sorted.find((o) => o.name.toLowerCase().startsWith(q)) ??
    null
  );
}

export interface QuickAddResolved {
  title: string;
  /** One uid per '@' query that matched exactly one person (or an exact name / email). */
  assigneeUids: Uid[];
  /** '@' queries with no match or several — the UI asks. */
  ambiguousAssignees: { query: string; candidates: Uid[] }[];
  priorityId: string | null;
  dueAt: Millis | null;
  dueAllDay: boolean;
  tagIds: string[];
  /** '+name' with no tag of that name — offered as 'create tag'. */
  newTags: string[];
  refs: TicketKey[];
}

export function resolveQuickAdd(
  q: QuickAdd,
  board: Pick<Board, 'priorities' | 'tags'>,
  people: readonly QuickAddPerson[],
): QuickAddResolved {
  const assigneeUids: Uid[] = [];
  const ambiguousAssignees: QuickAddResolved['ambiguousAssignees'] = [];
  for (const query of q.assigneeQuery) {
    const hits = matchPeople(query, people);
    const exact = hits.filter(
      (p) =>
        p.email.toLowerCase() === query.toLowerCase() ||
        p.name.toLowerCase() === query.toLowerCase(),
    );
    const pick = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : undefined;
    if (pick) {
      if (!assigneeUids.includes(pick.uid)) assigneeUids.push(pick.uid);
    } else ambiguousAssignees.push({ query, candidates: hits.map((p) => p.uid) });
  }
  const tagIds: string[] = [];
  const newTags: string[] = [];
  for (const name of q.tags) {
    const t = board.tags.find((o) => o.name.toLowerCase() === name.toLowerCase());
    if (t) {
      if (!tagIds.includes(t.id)) tagIds.push(t.id);
    } else newTags.push(name);
  }
  return {
    title: q.title,
    assigneeUids,
    ambiguousAssignees,
    priorityId: q.priorityQuery
      ? (matchOption(q.priorityQuery, board.priorities)?.id ?? null)
      : null,
    dueAt: q.due?.at ?? null,
    dueAllDay: q.due?.allDay ?? false,
    tagIds,
    newTags,
    refs: q.refs,
  };
}
