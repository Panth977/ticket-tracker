/**
 * Inbox logic with no Firebase in it (unit-tested): which rows each tab shows,
 * how rows collapse, the one-line copy a row prints, where it links.
 *
 * Rows come from users/{uid}/inbox (app/db.json › inbox). The notify router
 * already collapses a burst into ONE document (`count`), but a burst that
 * straddles its window can still leave two documents with the same
 * `groupKey`; the list folds those together too, so "5 comments on ENG-42"
 * is always one row.
 */
import type { InboxItem, Millis, NotifyEvent } from '@tm/shared';
import { routes } from '$lib/layout/routes';

export type Row = InboxItem & { id: string };

export const INBOX_TABS = [
  { id: 'unread', label: 'Unread' },
  { id: 'mentions', label: 'Mentions' },
  { id: 'assigned', label: 'Assigned' },
  { id: 'invitations', label: 'Invitations' },
  { id: 'all', label: 'All' },
  { id: 'snoozed', label: 'Snoozed' },
] as const;
export type InboxTab = (typeof INBOX_TABS)[number]['id'];

export function parseTab(raw: string | null | undefined): InboxTab {
  return INBOX_TABS.some((t) => t.id === raw) ? (raw as InboxTab) : 'unread';
}

/** Snoozed = hidden until `snoozedUntil`; once it passes the row is back in its tabs. */
export function isSnoozed(r: Pick<InboxItem, 'snoozedUntil'>, now: Millis): boolean {
  return r.snoozedUntil != null && r.snoozedUntil > now;
}

/** Does this (un-archived) row belong on `tab` at `now`? */
export function inTab(r: Row, tab: InboxTab, now: Millis): boolean {
  if (r.archivedAt != null) return false;
  if (tab === 'snoozed') return isSnoozed(r, now);
  if (isSnoozed(r, now)) return false;
  switch (tab) {
    case 'unread':
      return r.readAt == null;
    case 'mentions':
      return r.event === 'mentioned';
    case 'assigned':
      return r.event === 'assigned';
    case 'invitations':
      return r.event === 'invited';
    case 'all':
      return true;
  }
}

/** One visible row: the newest document of a group plus the ids it stands for. */
export interface Group {
  key: string;
  /** Newest document — what the row prints. */
  head: Row;
  /** Every document folded into this row (actions apply to all of them). */
  ids: string[];
  /** Total events represented (sum of each document's `count`). */
  count: number;
  unread: boolean;
}

/**
 * Fold rows sharing a groupKey (input may be in any order; output is newest
 * first). Invitations never fold: each is its own Accept / Decline.
 */
export function collapse(rows: Row[]): Group[] {
  const byKey = new Map<string, Group>();
  const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
  for (const r of sorted) {
    const key = r.event === 'invited' ? `invite:${r.inviteId ?? r.id}` : r.groupKey;
    const g = byKey.get(key);
    if (g) {
      g.ids.push(r.id);
      g.count += r.count;
      g.unread ||= r.readAt == null;
    } else {
      byKey.set(key, { key, head: r, ids: [r.id], count: r.count, unread: r.readAt == null });
    }
  }
  return [...byKey.values()];
}

/** Rows for a tab, collapsed, newest first. */
export function groupsForTab(rows: Row[], tab: InboxTab, now: Millis): Group[] {
  return collapse(rows.filter((r) => inTab(r, tab, now)));
}

/** Badge counts per tab (unread rows only, except Snoozed which counts everything waiting). */
export function tabCounts(rows: Row[], now: Millis): Record<InboxTab, number> {
  const out = { unread: 0, mentions: 0, assigned: 0, invitations: 0, all: 0, snoozed: 0 } as Record<
    InboxTab,
    number
  >;
  for (const t of INBOX_TABS) {
    const gs = groupsForTab(rows, t.id, now);
    out[t.id] = t.id === 'snoozed' ? gs.length : gs.filter((g) => g.unread).length;
  }
  return out;
}

/** What happened, after the actor's name: 'mentioned you', 'assigned you', … */
const VERB: Record<NotifyEvent, string> = {
  assigned: 'assigned you',
  mentioned: 'mentioned you',
  comment: 'commented',
  stage: 'moved',
  updated: 'updated',
  created: 'created',
  dueSoon: 'Due soon',
  overdue: 'Overdue',
  state: 'changed the state of',
  invited: 'invited you to a board',
  // Phase 3 (§L1): an agent is waiting on an answer.
  question: 'asked you a question',
  // Phase 3 (§L3): the sweep's own summary says which agent and for how long.
  agentSilence: 'stopped reporting',
};

/** Short event label for badges / the push prompt. */
export function eventLabel(e: NotifyEvent): string {
  return VERB[e];
}

/**
 * "{actor} mentioned you on ENG-42 · 3 more" — the Notification row
 * (app.json). The server's `summary` is the specific part ('moved to QA',
 * 'mentioned you: …'); `count` > 1 adds "· n more".
 */
export function rowHeadline(g: Pick<Group, 'head' | 'count'>, actorName: string | null): string {
  const { head } = g;
  const who = actorName ?? (head.actor ? 'Someone' : null);
  const summary = head.summary?.trim() || VERB[head.event];
  const text = who ? `${who} ${summary}` : summary;
  const more = g.count > 1 ? ` · ${g.count - 1} more` : '';
  return text + more;
}

/** A ticket key's board key: 'ENG-42' → 'ENG'. */
export function boardKeyOf(ticketKey: string): string {
  const i = ticketKey.lastIndexOf('-');
  return i > 0 ? ticketKey.slice(0, i) : ticketKey;
}

/**
 * Where a row leads outside the inbox (bell, push): the ticket in its board
 * with the drawer open, or the invitations tab for an invite.
 */
export function rowHref(
  r: Pick<InboxItem, 'event' | 'ticketKey'> & Pick<Partial<InboxItem>, 'artifactId'>,
): string {
  // A row about an ARTIFACT (shared with you, a new build on yours) has no
  // ticket: it leads to the artifact. An invite to one still needs answering.
  if (r.artifactId && r.event !== 'invited') return routes.artifact(r.artifactId);
  if (r.event === 'invited' || !r.ticketKey) return routes.invitations();
  return routes.board(boardKeyOf(r.ticketKey), null, r.ticketKey);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** '2m', '3h', '4d', then a date — compact enough for a one-line row. */
export function timeAgo(at: Millis, now: Millis, locale?: string): string {
  const d = Math.max(0, now - at);
  if (d < MIN) return 'now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d`;
  return new Date(at).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}
