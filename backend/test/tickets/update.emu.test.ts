/** ticketUpdate under the emulators. */
import { describe, expect, it } from 'vitest';
import { paths, type Ticket } from '@tm/shared';
import { call, fixedClock, setPorts, setupEmulators } from '../harness/index.js';
import { doc, getDocData, people, seedBoard, spyPorts, STAGES } from './helpers.js';
import { actsOf } from './store.js';

setupEmulators();

const T = (b: string, t: string) => getDocData<Ticket>(paths.ticket(b, t)).then((x) => x!);

describe('ticketUpdate', () => {
  it('field-level merge, stageCategory / completedAt, diff → activity, notify + webhooks', async () => {
    const s = spyPorts();
    const { asha, priya } = await people('asha', 'priya');
    const b = await seedBoard({ admin: asha, editors: [priya] });
    const { ticketId } = await call(asha, 'ticketCreate', {
      boardId: b.id,
      title: 'T',
      fields: { f_points: 3 },
    });

    // Two people patch different things: both land.
    await call(asha, 'ticketUpdate', { boardId: b.id, ticketId, patch: { priorityId: 'p_high' } });
    await call(priya, 'ticketUpdate', {
      boardId: b.id,
      ticketId,
      patch: { fields: { f_client: 'o_acme' } },
    });
    let t = await T(b.id, ticketId);
    expect(t.priorityId).toBe('p_high');
    expect(t.fields).toEqual({ f_points: 3, f_client: 'o_acme' });

    // null clears one field only.
    await call(asha, 'ticketUpdate', {
      boardId: b.id,
      ticketId,
      patch: { fields: { f_points: null } },
    });
    expect((await T(b.id, ticketId)).fields).toEqual({ f_client: 'o_acme' });

    // Into Done: requires f_soluti → 422 { missing }; then with it → done + completedAt.
    await expect(
      call(asha, 'ticketUpdate', { boardId: b.id, ticketId, patch: { stageId: STAGES.done } }),
    ).rejects.toMatchObject({
      code: 'unprocessable',
      details: { missing: ['f_soluti'] },
    });
    s.notified.length = 0;
    s.emitted.length = 0;
    const r = await call(asha, 'ticketUpdate', {
      boardId: b.id,
      ticketId,
      patch: { stageId: STAGES.done, fields: { f_soluti: 'done it' }, assigneeUids: [priya.uid] },
    });
    t = await T(b.id, ticketId);
    expect(t).toMatchObject({
      stageId: STAGES.done,
      stageCategory: 'done',
      completedAt: expect.any(Number),
      updatedAt: r.updatedAt,
    });
    expect(t.watcherUids).toContain(priya.uid); // new assignee watches
    expect(s.notified.map((n) => n.event).sort()).toEqual(['assigned', 'stage', 'updated']);
    expect(s.emitted.map((e) => e.event).sort()).toEqual(['ticket.moved', 'ticket.updated']);
    expect(s.emitted.find((e) => e.event === 'ticket.moved')!.data).toMatchObject({
      from_stage: { id: STAGES.todo },
    });

    // Leaving done clears completedAt.
    await call(asha, 'ticketUpdate', { boardId: b.id, ticketId, patch: { stageId: STAGES.doing } });
    expect((await T(b.id, ticketId)).completedAt).toBeNull();

    const acts = await actsOf(b.id, ticketId);
    const moved = acts.find(
      (a) =>
        a.action === 'update' && a.changes.stage && (a.changes.stage.to as string) === STAGES.done,
    )!;
    expect(moved.changes).toMatchObject({
      stage: { from: STAGES.todo, to: STAGES.done },
      'fields.f_soluti': { from: null, to: 'done it' },
      assignees: { from: [], to: [priya.uid] },
    });
  });

  it('commenter: only moves within their StageGrant (viaGrant recorded); anything else 403', async () => {
    spyPorts();
    const { asha, cora } = await people('asha', 'cora');
    const b = await seedBoard({
      admin: asha,
      commenters: [cora],
      grants: { [cora.uid]: { stages: [STAGES.todo, STAGES.doing] } },
    });

    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'T' });
    await call(cora, 'ticketUpdate', { boardId: b.id, ticketId, patch: { stageId: STAGES.doing } });
    expect((await T(b.id, ticketId)).stageId).toBe(STAGES.doing);
    const acts = await actsOf(b.id, ticketId);
    expect(acts.find((a) => a.action === 'update')!.viaGrant).toEqual([STAGES.todo, STAGES.doing]);

    await expect(
      call(cora, 'ticketUpdate', { boardId: b.id, ticketId, patch: { stageId: STAGES.review } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      call(cora, 'ticketUpdate', { boardId: b.id, ticketId, patch: { title: 'x' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      call(cora, 'ticketUpdate', {
        boardId: b.id,
        ticketId,
        patch: { stageId: STAGES.todo, title: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('ifUpdatedAt: stale title edit → 409 with the current ticket', async () => {
    spyPorts();
    let now = 1_800_000_000_000;
    setPorts({ clock: { now: () => (now += 1000) } });
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'v1' });
    const opened = (await T(b.id, ticketId)).updatedAt;
    await call(asha, 'ticketUpdate', {
      boardId: b.id,
      ticketId,
      patch: { title: 'v2' },
      ifUpdatedAt: opened,
    });
    await expect(
      call(asha, 'ticketUpdate', {
        boardId: b.id,
        ticketId,
        patch: { title: 'v3' },
        ifUpdatedAt: opened,
      }),
    ).rejects.toMatchObject({ code: 'conflict', details: { current: { title: 'v2' } } });
    // Not about the text → no check.
    await call(asha, 'ticketUpdate', {
      boardId: b.id,
      ticketId,
      patch: { priorityId: 'p_low' },
      ifUpdatedAt: opened,
    });
  });

  it('links are written both ways (blocks ↔ blockedBy) with activity on both; removal too', async () => {
    spyPorts();
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const a = await call(asha, 'ticketCreate', { boardId: b.id, title: 'A' });
    const c = await call(asha, 'ticketCreate', { boardId: b.id, title: 'B' });
    await call(asha, 'ticketUpdate', {
      boardId: b.id,
      ticketId: a.ticketId,
      patch: { links: [{ type: 'blocks', ticketId: c.ticketId }] },
    });
    expect((await T(b.id, c.ticketId)).links).toEqual([
      { type: 'blockedBy', ticketId: a.ticketId },
    ]);
    expect((await actsOf(b.id, c.ticketId)).some((x) => x.action === 'link')).toBe(true);
    expect((await actsOf(b.id, a.ticketId)).some((x) => x.action === 'link')).toBe(true);

    await call(asha, 'ticketUpdate', {
      boardId: b.id,
      ticketId: a.ticketId,
      patch: { links: [{ type: 'relates', ticketId: c.ticketId }] },
    });
    expect((await T(b.id, c.ticketId)).links).toEqual([{ type: 'relates', ticketId: a.ticketId }]);
    await call(asha, 'ticketUpdate', { boardId: b.id, ticketId: a.ticketId, patch: { links: [] } });
    expect((await T(b.id, c.ticketId)).links).toEqual([]);

    await expect(
      call(asha, 'ticketUpdate', {
        boardId: b.id,
        ticketId: a.ticketId,
        patch: { links: [{ type: 'relates', ticketId: a.ticketId }] },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      call(asha, 'ticketUpdate', {
        boardId: b.id,
        ticketId: a.ticketId,
        patch: { links: [{ type: 'relates', ticketId: 'nope' }] },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rank between neighbours; closed tickets are read-only; description refs + new mentions', async () => {
    const s = spyPorts();
    const { asha, priya } = await people('asha', 'priya');
    const b = await seedBoard({ admin: asha, editors: [priya] });
    const t1 = await call(asha, 'ticketCreate', { boardId: b.id, title: '1' });
    const t2 = await call(asha, 'ticketCreate', { boardId: b.id, title: '2' });
    const t3 = await call(asha, 'ticketCreate', { boardId: b.id, title: '3' });
    await call(asha, 'ticketUpdate', {
      boardId: b.id,
      ticketId: t3.ticketId,
      patch: {},
      rank: { after: t1.ticketId, before: t2.ticketId },
    });
    const [r1, r2, r3] = await Promise.all([
      T(b.id, t1.ticketId),
      T(b.id, t2.ticketId),
      T(b.id, t3.ticketId),
    ]);
    expect(r1.rank < r3.rank && r3.rank < r2.rank).toBe(true);

    s.notified.length = 0;
    await call(asha, 'ticketUpdate', {
      boardId: b.id,
      ticketId: t1.ticketId,
      patch: {
        description: doc('cc ', { uid: priya.uid }, ' ', { ticketId: t2.ticketId, key: t2.key }),
      },
    });
    expect((await T(b.id, t2.ticketId)).referencedBy).toEqual([t1.ticketId]);
    expect((await T(b.id, t1.ticketId)).refs).toEqual([t2.ticketId]);
    expect(s.notified.find((n) => n.event === 'mentioned')!.extra!.mentioned).toEqual([priya.uid]);
    s.notified.length = 0;
    // Same mention again: not re-notified.
    await call(asha, 'ticketUpdate', {
      boardId: b.id,
      ticketId: t1.ticketId,
      patch: { description: doc('cc ', { uid: priya.uid }, ' again') },
    });
    expect(s.notified.some((n) => n.event === 'mentioned')).toBe(false);

    const { db } = await import('../../src/runtime/firebase.js');
    await db().doc(paths.ticket(b.id, t1.ticketId)).update({ state: 'archived' });
    await expect(
      call(asha, 'ticketUpdate', { boardId: b.id, ticketId: t1.ticketId, patch: { title: 'x' } }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('fixed clock: updatedAt comes from ctx.now', async () => {
    spyPorts();
    setPorts({ clock: fixedClock(1_900_000_000_000) });
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'x' });
    const r = await call(asha, 'ticketUpdate', { boardId: b.id, ticketId, patch: { estimate: 5 } });
    expect(r.updatedAt).toBe(1_900_000_000_000);
  });
});
