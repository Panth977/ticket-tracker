/**
 * STAGE RULES (Stage.auto) — hourly: a ticket left idle in a stage for its
 * rule's time is archived, or moved to the rule's stage. Idle = no activity of
 * any kind (lastActivityAt): a comment, an edit or a move restarts the clock,
 * and an auto-move restarts it too, so rules chain (Review → Won't do after a
 * week → archived a day later).
 *
 * Written as the system (actor null, via 'system'), the way housekeeping's
 * done-archive is; an archive also clears everyone's unread rows about it.
 */
import { paths, type BoardWithId, type StoredActivity, type Ticket } from '@tm/shared';
import { betweenN } from '@tm/shared/logic/index';
import { ports } from '../adapters/index.js';
import { clearTicketInbox } from '../notify/inboxClean.js';
import { db } from '../runtime/firebase.js';
import { typedCol } from '../runtime/index.js';
import { batchWriter } from './doc.js';
import { applyPatch, updatesFor } from './patch.js';
import { lastRankInStage } from './rank.js';

const HOUR = 60 * 60 * 1000;

export interface StageRulesResult {
  archived: number;
  moved: number;
  errors: string[];
}

/** The rule that is due for this ticket now, if any. */
export function dueRule(
  board: Pick<BoardWithId, 'stages'>,
  t: Pick<Ticket, 'stageId' | 'state' | 'lastActivityAt' | 'updatedAt'>,
  now: number,
) {
  if (t.state !== 'active') return null;
  const rule = board.stages.find((s) => s.id === t.stageId)?.auto;
  if (!rule) return null;
  const idleSince = t.lastActivityAt ?? t.updatedAt;
  if (now - idleSince < rule.afterHours * HOUR) return null;
  if (rule.action === 'move' && (!rule.toStageId || rule.toStageId === t.stageId)) return null;
  if (rule.action === 'move' && !board.stages.some((s) => s.id === rule.toStageId)) return null;
  return rule;
}

export async function runStageRules(now: number): Promise<StageRulesResult> {
  const r: StageRulesResult = { archived: 0, moved: 0, errors: [] };
  // Every live board: a rule lives inside `stages` (no query reaches it).
  const listed = await typedCol('boards', paths.boards()).where('archivedAt', '==', null).get();
  const boards: BoardWithId[] = listed.docs
    .map((s) => ({ ...(s.data()! as Omit<BoardWithId, 'id'>), id: s.id }) as BoardWithId)
    .filter((b) => !b.archivedAt && b.stages?.some((s) => s.auto));

  for (const board of boards) {
    try {
      await boardRules(board, now, r);
    } catch (e) {
      console.error('[stageRules] board failed', board.id, e);
      r.errors.push(`${board.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return r;
}

async function boardRules(board: BoardWithId, now: number, r: StageRulesResult): Promise<void> {
  const ruled = board.stages.filter((s) => s.auto).map((s) => s.id);
  const active = await typedCol('tickets', paths.tickets(board.id))
    .where('state', '==', 'active')
    .get();
  const due = active.docs.filter((d) => {
    const t = d.data();
    return ruled.includes(t.stageId) && dueRule(board, t, now);
  });
  if (!due.length) return;
  const ctx = { now, ids: ports().ids };
  for (const d of due) {
    const ticket = d.data();
    const rule = dueRule(board, ticket, now);
    if (!rule) continue;
    const id = db().collection('_').doc().id;
    const batch = db().batch();
    const w = batchWriter(batch, ctx, board.id, d.id, ticket);
    if (rule.action === 'archive') {
      const activity: StoredActivity = {
        id,
        action: 'state',
        changes: { state: { from: 'active', to: 'archived' } },
        actor: null,
        via: 'system',
        createdAt: now,
      };
      w.set({ state: 'archived', updatedAt: now });
      w.addActivity(activity, id);
      w.touch(now);
      w.commit();
      await batch.commit();
      await clearTicketInbox(board.id, d.id, now);
      r.archived++;
    } else {
      const to = rule.toStageId!;
      const next = applyPatch(board, ticket, { stageId: to }, now);
      next.rank = betweenN(await lastRankInStage(board.id, to), null, 1)[0] ?? next.rank;
      const activity: StoredActivity = {
        id,
        action: 'update',
        changes: { stageId: { from: ticket.stageId, to } },
        actor: null,
        via: 'system',
        createdAt: now,
      };
      w.setPairs([...updatesFor(ticket, next), [['updatedAt'], now]]);
      w.addActivity(activity, id);
      w.touch(now);
      w.commit();
      await batch.commit();
      r.moved++;
    }
  }
}
