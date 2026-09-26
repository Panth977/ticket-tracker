/**
 * WHAT A BOARD CARD KNOWS — read off the ticket document, with no query at all
 * (docs/plan/agents.html §W).
 *
 * Phase 3 gave the cards two collection-group listeners (tasklists, question
 * messages) and phase 8 gave every UNREAD card a small query of its own on
 * that ticket's messages. §W deleted all three: a ticket is ONE document now,
 * it carries `signals` (the rollup), `tasklists`, `files` and `recentMessages`
 * inline, and the board list already read it. So every function here is PURE —
 * ticket in, card signal out — and a board of ten cards costs one query of ten
 * documents, refreshed by the delta ($lib/stores/app › boardActiveTickets).
 *
 *   tasklistSignalOfTicket   the '4/7' chip (§L2)
 *   questionSignalOfTicket   the ❓ Waiting badge (§L1)
 *   unreadOfTicket           the 💬 count (§P2), counted from the inline window
 *
 * §W2 — UNREAD WITH NO QUERY. The count is 'inline messages newer than my read
 * pointer that I did not write'. `signals.unreadFrom` is where the inline
 * window starts: a pointer OLDER than that can only be read as 'at least this
 * many', which is exactly what the badge already knows how to say ('20+').
 */
import { inlineMessages, tasklistRollup, type StoredMessage, type Ticket } from '@tm/shared';

/** What one ticket's card shows for its task lists. */
export interface TasklistSignal {
  /** '4/7' — the compact chip (§L2). */
  chip: string;
  settled: number;
  total: number;
  failed: number;
  /** The item with the spinner on it, if any. */
  doing: string | null;
}

/** What one ticket's card shows for open questions. */
export interface QuestionSignal {
  /** Blocking open questions addressed to me. */
  waiting: number;
  /** Any blocking open question, whoever it is for. */
  open: number;
  /** The first one's title, for the tooltip. */
  title: string | null;
}

/**
 * The '4/7' chip (§L2). `signals.tasklist` is the §W rollup (it also names the
 * item that is RUNNING, which the old per-ticket roll-up could not carry);
 * `tasklistProgress` is the phase-3 field, still written, and the floor for a
 * ticket the migration has not folded yet. The whole lists are inline too, so
 * a ticket that has them but no rollup is summed here rather than shown empty.
 */
export function tasklistSignalOfTicket(
  t: Pick<Ticket, 'tasklistProgress'> & Pick<Partial<Ticket>, 'signals' | 'tasklists'>,
): TasklistSignal | null {
  const roll = t.signals?.tasklist ?? (t.tasklists ? tasklistRollup(t.tasklists) : null);
  if (roll) {
    if (roll.total === 0) return null;
    return {
      chip: `${roll.done}/${roll.total}`,
      settled: roll.done,
      total: roll.total,
      // A failure is a state of an ITEM; §W's rollup keeps only the counts, so
      // the red chip comes from the lists themselves when they are inline.
      failed: (t.tasklists ?? []).reduce(
        (n, l) => n + l.items.filter((i) => i.status === 'failed').length,
        0,
      ),
      doing: roll.working,
    };
  }
  const p = t.tasklistProgress;
  if (!p || p.total === 0) return null;
  return { chip: `${p.done}/${p.total}`, settled: p.done, total: p.total, failed: 0, doing: null };
}

/**
 * The ❓ badge (§L1), from `signals.question` (or `waitingOn`, its phase-3
 * spelling). The rollup is written when a question is asked, answered or
 * cancelled — an expiry that has simply PASSED since is applied here, so the
 * badge goes away on the clock rather than on the next write.
 */
export function questionSignalOfTicket(
  t: Pick<Ticket, 'waitingOn'> & Pick<Partial<Ticket>, 'signals'>,
  principalId: string,
  now: number,
): QuestionSignal | null {
  const q = t.signals?.question ?? t.waitingOn ?? null;
  if (!q || q.count === 0) return null;
  if (q.expiresAt != null && q.expiresAt <= now) return null;
  const forMe = q.to === null || q.to.length === 0 || q.to.includes(principalId);
  return { waiting: forMe ? q.count : 0, open: q.count, title: q.title };
}

// ─────────── §W2 (was §P2): how many messages I have NOT read ──────────────

/** How far we count before giving up and printing '20+'. */
export const UNREAD_WINDOW = 20;

/** A ticket as the unread count reads it — everything is inline already. */
export type UnreadSource = Pick<Partial<Ticket>, 'recentMessages' | 'signals' | 'counts'>;

export interface UnreadCount {
  count: number;
  /** There may be more than `count`: the window or the inline thread ran out. */
  capped: boolean;
}

/**
 * Messages on this ticket newer than my read pointer that I did not write.
 *
 * `since` null = do not count this one (it is read, or the board is not
 * tracking it); 0 counts the whole thread, which is what a never-opened ticket
 * wants. null comes back when the count cannot be known at all — a ticket
 * written before §W, whose thread is still in a subcollection nobody reads
 * any more; the badge then falls back to the total, still in accent, so
 * 'something is new' is never lost (./summary › unreadBadge).
 */
export function unreadOfTicket(
  t: UnreadSource,
  since: number | null,
  principalId: string,
  window = UNREAD_WINDOW,
): UnreadCount | null {
  if (since == null) return null;
  const msgs = t.recentMessages;
  if (!msgs) return null;
  const inline = inlineMessages({ recentMessages: msgs });
  let count = 0;
  for (const m of inline) {
    if (m.createdAt <= since) continue;
    if (m.authorUid === principalId) continue;
    if (m.deletedAt != null) continue;
    count += 1;
  }
  // The pointer predates the inline window AND the thread has spilled: the
  // messages in data/{NNN} cannot be counted from here, so 'at least this
  // many'. A thread that fits inline is counted exactly, however old the
  // pointer is — including a ticket I have never opened.
  const from = t.signals?.unreadFrom ?? inline[0]?.createdAt ?? null;
  const total = t.signals?.messageCount ?? t.counts?.messages ?? null;
  const spilled = total != null && total > inline.length;
  const beyond = from != null && from > since && spilled;
  return { count: Math.min(count, window), capped: beyond || count > window };
}

/**
 * The rows as a count — kept as its own function because the thread's own
 * bubbles (optimistic or paged) are counted the same way.
 */
export function countUnread(
  rows: readonly Pick<StoredMessage, 'authorUid' | 'deletedAt'>[],
  principalId: string,
  window = UNREAD_WINDOW,
): UnreadCount {
  let count = 0;
  for (const m of rows) {
    if (m.authorUid === principalId) continue;
    if (m.deletedAt != null) continue;
    count += 1;
  }
  return { count: Math.min(count, window), capped: count > window };
}
