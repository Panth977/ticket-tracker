/**
 * Phase 8 (agents.html §P2) — WHAT A CARD SAYS, as data.
 *
 * "A card is the only thing you see for a ticket you have not opened. It should
 * answer: is anything new, who has it, is it late, is something waiting on me.
 * Empty facts are never drawn — a card with nothing to say stays two lines."
 *
 * The rendering lives in TicketSummary.svelte; the DECIDING lives here, with no
 * Svelte in it, because three places draw the same ticket — the kanban card,
 * the table's title cell and My work — and §P2 asks that all three agree. A
 * pure function is also the only way to test 'this fact is not drawn when it is
 * empty' without a browser.
 */
import type { Board, FieldValue, Indicator, Millis, Ticket } from '@tm/shared';
import { stageMark } from './stageMark';
import type { Tone } from '$lib/ui/types';
import { dueTone, fieldText, formatDate, formatNumber } from '$lib/views/format';

/** The parts of a ticket a summary reads — My work rows carry no more than this. */
export type SummaryTicket = Pick<
  Ticket,
  | 'key'
  | 'title'
  | 'state'
  | 'stageId'
  | 'stageCategory'
  | 'priorityId'
  | 'tagIds'
  | 'dueAt'
  | 'dueAllDay'
  | 'startAt'
  | 'estimate'
  | 'counts'
  | 'lastMessageAt'
  | 'assigneeUids'
> & { id: string; fields?: Record<string, FieldValue | undefined>; links?: Ticket['links'] };

/** A small picture beside a fact — the renderer maps these to lucide icons. */
export type FactIcon = 'tasks' | 'tasksDoing' | 'files' | 'blocked';

/** One chip on the meta row. */
export interface Fact {
  /** Keyed-each id (and what a test asks for). */
  id: string;
  kind:
    | 'priority'
    | 'tag'
    | 'due'
    | 'start'
    | 'stage'
    | 'estimate'
    | 'tasks'
    | 'files'
    | 'blocked'
    | 'field';
  /** The chip's text — '' when the chip is only an icon. */
  text: string;
  tone?: Tone;
  /** A board option's colour (tints the chip). */
  color?: string | null;
  /** indicators.html: the stage chip draws its stage's mark. */
  indicator?: Indicator;
  icon?: FactIcon;
  /** Tooltip / aria wording when the text alone is not enough. */
  title?: string;
  /** A person / people field: drawn as avatars after `label`. */
  uids?: string[];
  /** A custom field's name, drawn faintly in front of the value. */
  label?: string;
}

/** The task-list roll-up a card shows ('4/7'), from ./signals. */
export interface TaskFact {
  chip: string;
  failed: number;
  doing: string | null;
}

export interface FactCtx {
  board: Pick<Board, 'priorities' | 'tags' | 'fields' | 'stages'>;
  tz: string;
  now: Millis;
  /**
   * The view's `cardFields`. null = "everything this ticket actually has",
   * which is what the table's title cell and My work want — they have no view
   * of their own to ask.
   */
  fields: readonly string[] | null;
  /** A 'blockedBy' link to a ticket that is not done yet (⛔). */
  blocked?: boolean;
  tasks?: TaskFact | null;
}

/** Facts a card draws even when no view asked for them (table title cell, My work). */
const ALWAYS = new Set(['priority', 'tag', 'due', 'estimate', 'tasks', 'files', 'blocked']);
/**
 * SIGNALS, not fields: a view's `cardFields` chooses which of a ticket's
 * FIELDS to show, but 'there is work running', 'there are attachments' and
 * 'this is blocked' are things the card has always said whatever the view
 * asked for — they are how it answers 'is this stuck?' at a glance (§L2 · §P2).
 */
const SIGNALS = new Set(['tasks', 'files', 'blocked']);

const nonEmpty = (v: FieldValue | undefined): boolean =>
  v != null && v !== '' && v !== false && !(Array.isArray(v) && v.length === 0);

/**
 * The meta row, in §P2's order: priority · tags · due · estimate · task-list
 * progress · attachments · ⛔. Anything empty is simply absent — there is no
 * 'No tags' and no '0 files'.
 */
export function cardFacts(t: SummaryTicket, ctx: FactCtx): Fact[] {
  const { board, fields, tz, now } = ctx;
  const show = (k: string) => SIGNALS.has(k) || (fields ? fields.includes(k) : ALWAYS.has(k));
  const out: Fact[] = [];

  if (show('priority') && t.priorityId) {
    const p = board.priorities.find((x) => x.id === t.priorityId);
    if (p) out.push({ id: `priority:${p.id}`, kind: 'priority', text: p.name, color: p.color });
  }

  if (show('tag')) {
    for (const id of t.tagIds) {
      const tag = board.tags.find((x) => x.id === id);
      if (tag) out.push({ id: `tag:${tag.id}`, kind: 'tag', text: tag.name, color: tag.color });
    }
  }

  if (show('stage')) {
    const st = board.stages.find((s) => s.id === t.stageId);
    if (st) {
      const m = stageMark(st);
      out.push({
        id: 'stage',
        kind: 'stage',
        text: st.name,
        color: m.color,
        indicator: m.indicator,
        ...(m.hint ? { title: m.hint } : {}),
      });
    }
  }

  if (show('due') && t.dueAt != null) {
    const tone = dueTone(t, tz, now);
    out.push({
      id: 'due',
      kind: 'due',
      text: formatDate(t.dueAt, tz, { allDay: t.dueAllDay, now }),
      tone,
      title: tone === 'danger' ? 'Overdue' : tone === 'warning' ? 'Due today' : undefined,
    });
  }

  if (show('start') && t.startAt != null) {
    out.push({ id: 'start', kind: 'start', text: `Starts ${formatDate(t.startAt, tz, { now })}` });
  }

  if (show('estimate') && t.estimate != null) {
    out.push({ id: 'estimate', kind: 'estimate', text: `${formatNumber(t.estimate)} pts` });
  }

  if (show('tasks') && ctx.tasks) {
    const k = ctx.tasks;
    out.push({
      id: 'tasks',
      kind: 'tasks',
      text: k.chip,
      tone: k.failed ? 'danger' : 'neutral',
      icon: k.doing ? 'tasksDoing' : 'tasks',
      title: k.doing ?? `${k.chip} done`,
    });
  }

  if (show('files') && t.counts.files > 0) {
    out.push({
      id: 'files',
      kind: 'files',
      text: String(t.counts.files),
      icon: 'files',
      title: `${t.counts.files} attachment${t.counts.files === 1 ? '' : 's'}`,
    });
  }

  // Custom fields the view asked for, and only where the ticket has a value.
  if (fields) {
    for (const k of fields) {
      if (!k.startsWith('fields.')) continue;
      const def = board.fields.find((f) => f.id === k.slice(7) && !f.archived);
      const v = def ? t.fields?.[def.id] : undefined;
      if (!def || !nonEmpty(v)) continue;
      if (def.type === 'person' && typeof v === 'string') {
        out.push({ id: `field:${def.id}`, kind: 'field', text: '', label: def.name, uids: [v] });
      } else if (def.type === 'people' && Array.isArray(v)) {
        out.push({
          id: `field:${def.id}`,
          kind: 'field',
          text: '',
          label: def.name,
          uids: v as string[],
        });
      } else {
        const text = fieldText(board, def.id, v, tz);
        if (text) out.push({ id: `field:${def.id}`, kind: 'field', text, label: def.name });
      }
    }
  }

  if (show('blocked') && ctx.blocked) {
    out.push({
      id: 'blocked',
      kind: 'blocked',
      text: 'blocked',
      tone: 'danger',
      icon: 'blocked',
      title: 'Blocked by another ticket',
    });
  }

  return out;
}

// ─────────────────────────── the 💬 badge (§P2 top row) ────────────────────

export interface UnreadBadge {
  /** How many I have not read; null = we know only THAT there are some. */
  count: number | null;
  total: number;
  unread: boolean;
  /** What the badge prints — '3', '12+', or the muted total. */
  text: string;
  label: string;
}

/**
 * "💬 3 when there are messages you have not read, muted total when there are
 * none" (§P2). `count` comes from the same read pointer the thread's 'New
 * messages' divider uses, so opening the ticket clears it everywhere; when the
 * count is not known yet (still loading, or more than the window we count) the
 * badge falls back to the total, still in accent, so 'something is new' is
 * never lost. A ticket with no thread has nothing to say and draws nothing.
 */
export function unreadBadge(
  total: number,
  unread: boolean,
  count: number | null,
  capped = false,
): UnreadBadge | null {
  if (total <= 0) return null;
  // Everything new is mine: the thread has nothing new FOR ME.
  const isNew = unread && (count == null || count > 0);
  if (!isNew) {
    return {
      count: 0,
      total,
      unread: false,
      text: String(total),
      label: `${total} message${total === 1 ? '' : 's'}`,
    };
  }
  if (count == null) {
    return {
      count: null,
      total,
      unread: true,
      text: String(total),
      label: `${total} messages, unread`,
    };
  }
  const text = capped ? `${count}+` : String(count);
  return {
    count,
    total,
    unread: true,
    text,
    label: `${text} unread message${count === 1 && !capped ? '' : 's'}`,
  };
}

// ─────────────── who says a thread is unread, and how blocked ──────────────
/*
 * The board, the table and My work all have to agree on these two, and only
 * the board has a BoardState — so they live here, as functions over the data
 * each of those three already holds.
 */

/** A ticket as the unread rules see it. */
export type UnreadTicket = Pick<Ticket, 'lastMessageAt' | 'watcherUids' | 'counts'> & {
  id: string;
};

/**
 * Something was posted after I last read it. A ticket I have never opened
 * (no read pointer) counts only when I watch it — otherwise every ticket on a
 * busy board would shout at a newcomer.
 */
export function isUnread(t: UnreadTicket, readAt: number | null | undefined, me: string): boolean {
  if (t.lastMessageAt == null) return false;
  if (readAt == null) return t.watcherUids.includes(me);
  return t.lastMessageAt > readAt;
}

/**
 * Which tickets are worth keeping an unread COUNT for: the unread ones, most
 * recently spoken-in first, capped — past the cap a card still says 'something
 * is new', just not how much (§P2), and the screen opens no more listeners.
 */
export function unreadTracked(
  rows: readonly UnreadTicket[],
  readAtOf: (id: string) => number | null | undefined,
  me: string,
  cap: number,
): Set<string> {
  const live = rows.filter((t) => t.counts.messages > 0 && isUnread(t, readAtOf(t.id), me));
  live.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  return new Set(live.slice(0, cap).map((t) => t.id));
}

/**
 * ⛔ — a 'blockedBy' link to a ticket that is not done yet. A blocker we
 * cannot see (archived, moved, on a board we are not reading) still counts
 * until someone unlinks it: better a ⛔ too many than a card that lies.
 */
export function isBlocked(
  t: Pick<Ticket, 'links'> | { links?: Ticket['links'] },
  byId: ReadonlyMap<string, Pick<Ticket, 'stageCategory' | 'state'>>,
): boolean {
  return (t.links ?? []).some((l) => {
    if (l.type !== 'blockedBy') return false;
    const other = byId.get(l.ticketId);
    return (
      !other ||
      (other.stageCategory !== 'done' &&
        other.stageCategory !== 'cancelled' &&
        other.state === 'active')
    );
  });
}
