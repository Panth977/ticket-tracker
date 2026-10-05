/**
 * Thread layout, pure: messages → day sections → author groups, and where the
 * 'New' divider goes. "Grouped by author and day" (app.json Thread): a run of
 * comments by one person on one day, each within GROUP_GAP_MS of the last,
 * shares a single header. System lines always stand alone — and so does a
 * turn receipt (phase 17, §Y1: a message with `run` is a row, not a bubble)
 * and an 'agg' message (aggregates.html: entries are a row too).
 */
import type { Message } from '@tm/shared';

/** Google Chat grouping (agents.html § K): same author within 5 minutes. */
export const GROUP_GAP_MS = 5 * 60 * 1000;

export interface ThreadMsg extends Pick<
  Message,
  'kind' | 'authorUid' | 'authorName' | 'createdAt'
> {
  id: string;
  /** §Y1: a turn receipt — drawn as its own row, never inside an author group. */
  run?: Message['run'];
}

/** System lines, turn receipts and 'agg' rows never share a header with anything. */
const alone = (m: ThreadMsg): boolean => m.kind === 'system' || m.kind === 'agg' || !!m.run;

export interface MsgGroup<M extends ThreadMsg> {
  key: string;
  authorUid: string | null;
  authorName: string;
  system: boolean;
  messages: M[];
}

export interface DaySection<M extends ThreadMsg> {
  /** 'YYYY-MM-DD' in the viewer's zone. */
  day: string;
  groups: MsgGroup<M>[];
}

/** 'YYYY-MM-DD' of `ms` in time zone `tz`. */
export function dayKey(ms: number, tz?: string): string {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return f.format(new Date(ms));
}

/** Oldest-first messages → sections. */
export function groupThread<M extends ThreadMsg>(msgs: readonly M[], tz?: string): DaySection<M>[] {
  const out: DaySection<M>[] = [];
  for (const m of msgs) {
    const day = dayKey(m.createdAt, tz);
    let sec = out[out.length - 1];
    if (!sec || sec.day !== day) {
      sec = { day, groups: [] };
      out.push(sec);
    }
    const g = sec.groups[sec.groups.length - 1];
    const last = g?.messages[g.messages.length - 1];
    const joins =
      g &&
      last &&
      !g.system &&
      !alone(m) &&
      g.authorUid === m.authorUid &&
      g.authorName === m.authorName &&
      m.createdAt - last.createdAt <= GROUP_GAP_MS;
    if (joins) g.messages.push(m);
    else
      sec.groups.push({
        key: m.id,
        authorUid: m.authorUid,
        authorName: m.authorName,
        system: alone(m),
        messages: [m],
      });
  }
  return out;
}

/**
 * The first message to mark 'New': the oldest one after my read pointer that
 * someone ELSE wrote. null = nothing unread (or never opened: no divider).
 */
export function firstUnread<M extends ThreadMsg>(
  msgs: readonly M[],
  readAt: number | null | undefined,
  me: string | null | undefined,
): string | null {
  if (readAt == null) return null;
  const m = msgs.find((x) => x.createdAt > readAt && x.authorUid !== me);
  return m?.id ?? null;
}

/** 'Today', 'Yesterday', 'Mon 3 Oct', '3 Oct 2025'. */
export function dayLabel(day: string, now: number, tz?: string): string {
  const today = dayKey(now, tz);
  const yesterday = dayKey(now - 86_400_000, tz);
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d, 12));
  const sameYear = today.slice(0, 4) === day.slice(0, 4);
  return date.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: sameYear ? 'short' : undefined,
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
  });
}

/** Merge a page (newest-first from Firestore) with optimistic bubbles into oldest-first order. */
export function mergeThread<M extends ThreadMsg>(page: readonly M[], pending: readonly M[]): M[] {
  const ids = new Set(page.map((m) => m.id));
  return [...page.filter(Boolean)]
    .concat(pending.filter((p) => !ids.has(p.id)))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
