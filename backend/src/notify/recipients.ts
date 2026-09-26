/**
 * WHO HEARS ABOUT AN EVENT — pure, so every branch is unit-tested.
 *
 *   candidates = extra.recipients                  (explicit: new assignees, the invitee, a deadline's person)
 *              | extra.mentioned                   ('mentioned' — unconditional)
 *              | board readers                      (every other ticket event: watchers and assignees are readers)
 *   ∩ board readers (a person removed from the board hears nothing) — except 'invited'
 *   − the actor, − extra.exclude
 *   then each person's OWN board pref (prefs/{uid}):
 *     watching this ticket → always (it overrides mode, events and stageIds)
 *     mode   all   → everything on the board
 *            mine  → tickets I'm assigned to, created, or watch
 *            muted → nothing (only explicitly watched tickets, and mentions)
 *     events       → absent = every event
 *     stageIds     → 'stage' events: only moves into these stages
 *
 * A mention always notifies, whatever the mode, and never twice: commands
 * pass the mentioned people in `exclude` on the accompanying 'comment'.
 */
import type { BoardNotifyPref, NotifyEvent, Uid } from '@tm/shared';

/** What a person gets when they never touched the bell on this board. */
export const DEFAULT_BOARD_PREF: BoardNotifyPref & { watching: string[] } = {
  mode: 'mine',
  watching: [],
};

export interface RecipientTicket {
  id: string;
  stageId: string;
  assigneeUids: readonly Uid[];
  watcherUids: readonly Uid[];
  createdBy: Uid;
}

export interface RecipientInput {
  event: NotifyEvent;
  actor: Uid;
  /** null for 'invited'. */
  ticket: RecipientTicket | null;
  /** board.readerUids (ignored for 'invited'). */
  readers: readonly Uid[];
  recipients?: readonly Uid[] | undefined;
  mentioned?: readonly Uid[] | undefined;
  exclude?: readonly Uid[] | undefined;
}

/** Events addressed to specific people, never broadcast to the board. */
const DIRECT_ONLY: ReadonlySet<NotifyEvent> = new Set(['invited', 'dueSoon', 'overdue']);

/** Step 1: the candidate set before anyone's preferences are consulted. */
export function candidates(input: RecipientInput): Uid[] {
  const { event, actor } = input;
  let base: readonly Uid[];
  if (event === 'mentioned') base = input.mentioned ?? input.recipients ?? [];
  else if (input.recipients) base = input.recipients;
  else if (DIRECT_ONLY.has(event)) base = [];
  else base = input.readers;

  const readers = new Set(input.readers);
  const exclude = new Set(input.exclude ?? []);
  const out: Uid[] = [];
  const seen = new Set<Uid>();
  for (const uid of base) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    if (uid === actor || exclude.has(uid)) continue;
    if (event !== 'invited' && !readers.has(uid)) continue;
    out.push(uid);
  }
  return out;
}

/** Step 2: does this person's own board pref let the event through? */
export function prefAllows(
  uid: Uid,
  event: NotifyEvent,
  ticket: RecipientTicket | null,
  pref: (BoardNotifyPref & { watching?: readonly string[] }) | undefined,
  opts: { toStageId?: string } = {},
): boolean {
  // Unconditional: a mention, an invitation (the invitee has no board pref yet),
  // and — phase 3 (§L1) — a question. A question always reaches this person by
  // name (questionAsk passes `to`, or the assignees and watchers) and an agent
  // is blocked until it is answered, so it behaves like a mention: the board's
  // mode / events filters do not silence it. The channels it uses are still the
  // person's own (user.notify.channels.question).
  if (event === 'mentioned' || event === 'invited' || event === 'question') return true;
  const p = pref ?? DEFAULT_BOARD_PREF;
  if (ticket && p.watching?.includes(ticket.id)) return true;

  const mineTicket =
    !!ticket &&
    (ticket.assigneeUids.includes(uid) ||
      ticket.watcherUids.includes(uid) ||
      ticket.createdBy === uid);
  if (p.mode === 'muted') return false;
  if (p.mode === 'mine' && !mineTicket) return false;

  if (p.events && !p.events.includes(event)) return false;
  if (event === 'stage' && p.stageIds && p.stageIds.length > 0) {
    const to = opts.toStageId ?? ticket?.stageId;
    if (!to || !p.stageIds.includes(to)) return false;
  }
  return true;
}
