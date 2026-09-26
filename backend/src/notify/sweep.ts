/**
 * deadlineSweep — every 15 minutes (app/backend.json services.deadlineSweep).
 *
 *   collection group: tickets where state == 'active' && dueAt <= now + 72h
 *   (72h = the longest lead time anyone may choose)
 *
 *   for each ticket not in a done / cancelled stage, for each assignee:
 *     overdue (their zone decides when an all-day date ends) && !dueNotified[uid].overdue
 *        → notify('overdue', to: uid)
 *     due within THEIR lead time && !dueNotified[uid].soon
 *        → notify('dueSoon', to: uid)
 *
 * dueNotified IS PER PERSON AND MAKES A RE-RUN HARMLESS; ticketUpdate clears
 * it when dueAt changes, so a moved deadline warns again.
 *
 * commitments[uid] that passed, for people with commitmentReminders on → a
 * nudge to THAT person. Tickets carry nextCommitmentAt (the earliest one not
 * nudged yet, written by ticketUpdate): a second query finds every ticket
 * whose nextCommitmentAt has passed — due date or not — nudges the
 * commitments in [nextCommitmentAt, now] and moves it to the next one.
 * (Older tickets without the field keep the due-window check below.)
 *
 * board.counts.overdue is recomputed for every board touched, and for every
 * board that still claims overdue tickets: time makes a ticket overdue and no
 * write would notice.
 */
import { FieldPath, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import {
  parseTicketPath,
  paths,
  type CommandCtx,
  type Ticket,
  type TicketWithId,
  type User,
} from '@tm/shared';
import { dueSoon, effectiveDue } from '@tm/shared/logic/time';
import { db } from '../runtime/firebase.js';
import { nextCommitment } from '../tickets/patch.js';
import { converterFor, typedCol, typedDoc } from '../runtime/index.js';
import { ticketCountBuckets } from '../search/counts.js';
import { SYSTEM_ACTOR } from './config.js';
import { notify } from './router.js';

export const SWEEP_HORIZON_MS = 72 * 60 * 60 * 1000;
/** The schedule's period: a commitment is nudged by the run that crosses it. */
export const SWEEP_PERIOD_MS = 15 * 60 * 1000;

export interface SweepResult {
  dueSoon: string[];
  overdue: string[];
  nudges: string[];
  /** boardId → the recomputed overdue count (only boards whose count changed). */
  boardCounts: Record<string, number>;
}

export async function deadlineSweep(now: number): Promise<SweepResult> {
  const out: SweepResult = { dueSoon: [], overdue: [], nudges: [], boardCounts: {} };
  const ctx: CommandCtx = { actor: SYSTEM_ACTOR, via: 'system', now };

  const snap = await db()
    .collectionGroup('tickets')
    .withConverter(converterFor('tickets'))
    .where('state', '==', 'active')
    .where('dueAt', '<=', now + SWEEP_HORIZON_MS)
    .get();

  const users = new Map<string, Promise<User | undefined>>();
  const userOf = (uid: string) => {
    let p = users.get(uid);
    if (!p) {
      p = typedDoc('users', paths.user(uid))
        .get()
        .then((s) => (s.exists ? s.data() : undefined));
      users.set(uid, p);
    }
    return p;
  };

  const boards = new Set<string>();
  for (const doc of snap.docs) {
    const ids = parseTicketPath(doc.ref.path);
    if (!ids) continue;
    boards.add(ids.boardId);
    const t = doc.data();
    if (t.stageCategory === 'done' || t.stageCategory === 'cancelled' || t.dueAt === null) continue;
    const ticket: TicketWithId = { ...t, id: ids.ticketId, boardId: ids.boardId };

    for (const uid of t.assigneeUids) {
      const user = await userOf(uid);
      if (!user || user.deletedAt) continue;
      const seen = t.dueNotified[uid] ?? {};
      const at = effectiveDue(t.dueAt, t.dueAllDay, user.timezone);
      if (at <= now) {
        if (seen.overdue) continue;
        await notify('overdue', ticket, ctx, { recipients: [uid] });
        await mark(doc, uid, 'overdue', now);
        out.overdue.push(`${ticket.key}:${uid}`);
      } else if (!seen.soon && dueSoon(at, user.notify.dueSoonLeadMinutes, now)) {
        await notify('dueSoon', ticket, ctx, { recipients: [uid] });
        await mark(doc, uid, 'soon', now);
        out.dueSoon.push(`${ticket.key}:${uid}`);
      }
    }

    // Tickets with nextCommitmentAt are handled by the commitments query below.
    if (t.nextCommitmentAt !== undefined) continue;
    for (const [uid, at] of Object.entries(t.commitments)) {
      if (!(at <= now && at > now - SWEEP_PERIOD_MS)) continue;
      const user = await userOf(uid);
      if (!user || user.deletedAt || !user.notify.commitmentReminders) continue;
      await notify('dueSoon', ticket, ctx, {
        recipients: [uid],
        summary: 'you planned to pick this up now',
      });
      out.nudges.push(`${ticket.key}:${uid}`);
    }
  }

  // Commitments that passed, on any active ticket (index: tickets.nextCommitmentAt, collection group).
  const committed = await db()
    .collectionGroup('tickets')
    .withConverter(converterFor('tickets'))
    .where('nextCommitmentAt', '<=', now)
    .get();
  for (const doc of committed.docs) {
    const ids = parseTicketPath(doc.ref.path);
    const t = doc.data();
    if (!ids || t.nextCommitmentAt == null) continue;
    const from = t.nextCommitmentAt;
    if (t.state === 'active' && t.stageCategory !== 'done' && t.stageCategory !== 'cancelled') {
      const ticket: TicketWithId = { ...t, id: ids.ticketId, boardId: ids.boardId };
      for (const [uid, at] of Object.entries(t.commitments)) {
        if (!(at >= from && at <= now)) continue;
        const user = await userOf(uid);
        if (!user || user.deletedAt || !user.notify.commitmentReminders) continue;
        await notify('dueSoon', ticket, ctx, {
          recipients: [uid],
          summary: 'you planned to pick this up now',
        });
        out.nudges.push(`${ticket.key}:${uid}`);
      }
    }
    await doc.ref.update({ nextCommitmentAt: nextCommitment(t.commitments, now) });
  }

  // Boards that still claim overdue tickets may have none left without a write noticing.
  const claiming = await typedCol('boards', paths.boards()).where('counts.overdue', '>', 0).get();
  for (const b of claiming.docs) boards.add(b.id);

  for (const boardId of boards) {
    const n = await overdueCount(boardId, now);
    const ref = typedDoc('boards', paths.board(boardId));
    const board = await ref.get();
    if (!board.exists || board.data()!.counts.overdue === n) continue;
    await ref.update({ 'counts.overdue': n });
    out.boardCounts[boardId] = n;
  }
  return out;
}

async function mark(
  doc: QueryDocumentSnapshot<Ticket>,
  uid: string,
  which: 'soon' | 'overdue',
  now: number,
) {
  await doc.ref.update(new FieldPath('dueNotified', uid, which), now);
}

/** The same judgement onTicketWritten uses (search/counts.ts), at one instant. */
export async function overdueCount(boardId: string, now: number): Promise<number> {
  const s = await typedCol('tickets', paths.tickets(boardId))
    .where('state', '==', 'active')
    .where('dueAt', '<=', now)
    .get();
  return s.docs.reduce((n, d) => n + ticketCountBuckets(d.data(), now).overdue, 0);
}
