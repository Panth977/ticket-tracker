/**
 * Stage.auto (tickets/stageRules.ts): a ticket idle in a stage for its rule's
 * time is archived or moved on; activity restarts the clock.
 */
import { describe, expect, it } from 'vitest';
import { paths, type Ticket } from '@tm/shared';
import { fixtures } from '@tm/shared/schema/fixtures';
import { dueRule, runStageRules } from '../../src/tickets/stageRules.js';
import { typedDoc } from '../../src/runtime/index.js';
import { setupEmulators } from '../harness/index.js';
import { seedBoard, seedTicket, seedUser, T, useFakes } from '../notify/_seed.js';

setupEmulators();
const H = 60 * 60 * 1000;
const ticket = async (b: string, id: string) =>
  (await typedDoc('tickets', paths.ticket(b, id)).get()).data() as Ticket;

describe('stage rules (Stage.auto)', () => {
  const stages = fixtures.boards.stages.map((s) =>
    s.id === 'st_done'
      ? { ...s, auto: { afterHours: 24, action: 'archive' as const } }
      : s.id === 'st_rev'
        ? { ...s, auto: { afterHours: 24 * 7, action: 'move' as const, toStageId: 'st_todo' } }
        : s,
  );

  it('dueRule: idle long enough, in a stage with a rule', () => {
    const b = { stages };
    const t = (stageId: string, idle: number) => ({
      stageId,
      state: 'active' as const,
      lastActivityAt: T - idle,
      updatedAt: T - idle,
    });
    expect(dueRule(b, t('st_done', 25 * H), T)?.action).toBe('archive');
    expect(dueRule(b, t('st_done', 23 * H), T)).toBeNull();
    expect(dueRule(b, t('st_todo', 1000 * H), T)).toBeNull();
    expect(dueRule(b, { ...t('st_done', 25 * H), state: 'archived' }, T)).toBeNull();
  });

  it('archives the idle Done ticket, moves the week-idle Review one, leaves the fresh ones', async () => {
    useFakes();
    const u = await seedUser();
    const board = await seedBoard([u.uid], { stages });
    const idleDone = await seedTicket(board.id, {
      stageId: 'st_done',
      stageCategory: 'done',
      lastActivityAt: T - 30 * H,
    });
    const freshDone = await seedTicket(board.id, {
      stageId: 'st_done',
      stageCategory: 'done',
      lastActivityAt: T - 2 * H,
    });
    const idleReview = await seedTicket(board.id, {
      stageId: 'st_rev',
      stageCategory: 'active',
      lastActivityAt: T - 8 * 24 * H,
    });
    const r = await runStageRules(T);
    expect(r.errors).toEqual([]);
    expect((await ticket(board.id, idleDone.id)).state).toBe('archived');
    expect((await ticket(board.id, freshDone.id)).state).toBe('active');
    const moved = await ticket(board.id, idleReview.id);
    expect(moved.stageId).toBe('st_todo');
    expect(moved.stageCategory).toBe('todo');
    expect(moved.lastActivityAt).toBe(T);
    expect(r).toMatchObject({ archived: 1, moved: 1 });
    // Ran again at once: nothing more is due (the move restarted the clock).
    const again = await runStageRules(T);
    expect(again).toMatchObject({ archived: 0, moved: 0 });
  });
});
