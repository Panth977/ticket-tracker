/**
 * The open board, as every board component sees it. The board route builds one
 * BoardState, feeds it the live stores (board, ACTIVE tickets, members, my
 * reads) and puts it in context; Kanban / Table / Calendar / Timeline / cards
 * read from it instead of each opening its own listeners.
 *
 * LIVE: one onSnapshot per open board over state == 'active' (app.json Board
 * wire). A view that asks for archived tickets adds a second listener for
 * just those states while it is open.
 */
/* eslint-disable svelte/prefer-svelte-reactivity -- every Map / URL here is built fresh and replaced wholesale, never mutated in place */
import { getContext, setContext } from 'svelte';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import {
  type Board,
  type BoardMember,
  type BoardRole,
  type Read,
  type Ticket,
  type TicketPatch,
  type TicketWithId,
} from '@tm/shared';
import { can, roleOf, type Action } from '@tm/shared/logic/can';
import type { WithId } from '$lib/stores';
import { outbox } from '$lib/api';
import { principalChoices } from '$lib/people/pickers';
import type { ViewCtx } from '@tm/shared/logic/view';
import { isUnread, unreadTracked } from './summary';

export type BoardTicket = TicketWithId;

/** A loaded board document. Components take one of these as a PROP (§Q4). */
export type BoardDoc = WithId<Board>;

/** A move the server refused with 422: the target stage requires fields this ticket lacks. */
export interface RequiresPrompt {
  ticket: BoardTicket;
  stageId: string;
  /** FieldDef ids to fill before the move can happen. */
  missing: string[];
  /** The refused patch (retried with the filled fields merged in). */
  patch: TicketPatch;
  rank?: { after?: string; before?: string };
}
const KEY = Symbol('board');

export class BoardState {
  /**
   * The open board, read STRAIGHT from the route's live store (§Q4).
   *
   * It used to be `$state` the route pushed into from an `$effect` — and
   * effects run after children render, so the first render of a board that
   * had just loaded saw `null` and every `bs.board!.stages` threw. A getter
   * over the route's own `$derived` is read during render, in order, so the
   * board is already here by the time anything draws.
   */
  readonly #src: () => BoardDoc | null;

  constructor(src: () => BoardDoc | null = () => null) {
    this.#src = src;
  }

  get board(): BoardDoc | null {
    return this.#src();
  }
  /** Active tickets (plus archived ones when the open view includes them). */
  tickets = $state<BoardTicket[]>([]);
  ticketsLoading = $state(true);
  members = $state<WithId<BoardMember>[]>([]);
  /** ticketId → readAt (users/{me}/reads for this board). */
  reads = $state<Map<string, number>>(new Map());
  me = $state('');
  tz = $state('UTC');
  /** Set when a drop hit a stage's `requires` (422) — the page shows the prompt. */
  requires = $state<RequiresPrompt | null>(null);
  /** Tickets still being created (outbox stand-ins), by ticket id: 'sending' | 'failed'. */
  pending = $state<Map<string, { state: 'sending' | 'failed'; entryId: string }>>(new Map());
  /** Re-evaluated each minute so 'today' / overdue roll over while the tab is open. */
  now = $state(Date.now());

  readonly role: BoardRole | null = $derived(
    this.board && this.me ? roleOf(this.board, this.me) : null,
  );
  readonly isAdmin = $derived(this.role === 'admin');
  readonly canEdit = $derived(this.can('edit'));
  readonly canCreate = $derived(this.can('create'));
  readonly archived = $derived(this.board?.archivedAt != null);
  readonly byId = $derived(new Map(this.tickets.map((t) => [t.id, t])));
  readonly memberByUid = $derived(new Map(this.members.map((m) => [m.uid, m])));
  readonly viewCtx: ViewCtx = $derived({
    me: this.me,
    now: this.now,
    tz: this.tz,
    weekStartsOn: 1,
  });
  /** ChoicePicker items for people AND agents on the board (agents.html §D; agents carry their badge). */
  readonly peopleChoices = $derived(principalChoices(this.members));
  /** People for pickers and quick-add: members, by name. */
  readonly people = $derived(
    [...this.members]
      .map((m) => ({ uid: m.uid, name: m.name || m.email, email: m.email }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  /** can(action) for me on this board; archived boards are read-only for everyone. */
  can(
    action: Action,
    ticket?: Pick<Ticket, 'stageId' | 'assigneeUids'> | null,
    toStageId?: string | null,
  ): boolean {
    const b = this.board;
    if (!b || !this.me) return false;
    if (b.archivedAt != null && action !== 'read' && action !== 'admin') return false;
    return can({ actor: this.me }, b, action, ticket ?? null, toStageId ?? null);
  }

  /** May I drop this ticket in that stage? (editor+, or a commenter within their StageGrant). */
  canMoveTo(t: Pick<Ticket, 'stageId' | 'assigneeUids'>, toStageId: string): boolean {
    return this.can('edit') || this.can('move', t, toStageId);
  }

  /**
   * Unread thread: something was posted after I last read it (the rule itself
   * is in ./summary, so the board, the table and My work cannot drift apart).
   */
  unread(t: Pick<Ticket, 'lastMessageAt' | 'watcherUids' | 'counts'> & { id: string }): boolean {
    return isUnread(t, this.reads.get(t.id), this.me);
  }

  /**
   * Phase 8 (§P2) — the tickets whose unread COUNT the board keeps live. The
   * count is a small query on that ticket's own messages (see ./signals), so
   * it is worth opening only for threads that are actually unread, and even
   * then only for the most recently active ones: past this cap a card still
   * says 'something is new', just not how much. The rest of the board opens
   * nothing at all.
   */
  static readonly UNREAD_TRACKED = 40;
  readonly countedUnread = $derived(
    unreadTracked(this.tickets, (id) => this.reads.get(id), this.me, BoardState.UNREAD_TRACKED),
  );

  /**
   * The read pointer to count from, or null when this card should not count at
   * all (it is read, or past the cap). 0 = never opened: count the whole
   * thread. It is the SAME pointer the thread's 'New messages' divider uses,
   * which is why opening the ticket clears the badge everywhere.
   */
  unreadSince(t: Pick<Ticket, 'lastMessageAt' | 'watcherUids'> & { id: string }): number | null {
    if (!this.countedUnread.has(t.id)) return null;
    return this.reads.get(t.id) ?? 0;
  }

  memberName(uid: string): string {
    const m = this.memberByUid.get(uid);
    return m ? m.name || m.email : 'Former member';
  }

  stage(id: string) {
    return this.board?.stages.find((s) => s.id === id);
  }

  /** Open the ticket drawer over the current view (?ticket=KEY). A ticket still being created has nothing to open yet. */
  openTicket(key: string) {
    const t = this.tickets.find((x) => x.key === key);
    const p = t ? this.pending.get(t.id) : undefined;
    if (p) {
      if (p.state === 'failed') outbox.open(p.entryId);
      return;
    }
    const url = new URL(page.url);
    url.searchParams.set('ticket', key);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- same-page query change
    void goto(url, { noScroll: true, keepFocus: true });
  }

  setReads(rows: WithId<Read>[]) {
    this.reads = new Map(rows.map((r) => [r.id, r.readAt]));
  }
}

export function provideBoard(state: BoardState): BoardState {
  setContext(KEY, state);
  return state;
}

export function useBoard(): BoardState {
  const s = getContext<BoardState | undefined>(KEY);
  if (!s) throw new Error('useBoard() outside a board route');
  return s;
}
