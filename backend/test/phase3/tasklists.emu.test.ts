/**
 * Phase 3 §L2 — task lists inside the ticket.
 *
 * An agent publishes its plan, ticks it off, and the thread hears exactly
 * twice: once when the list appears and once when it is finished.
 */
import { describe, expect, it } from 'vitest';
import { MAX_TASKLIST_ITEMS, type Message } from '@tm/shared';
import { call, setupEmulators } from '../harness/index.js';
import { asAgent } from '../agents/helpers.js';
import { people, spyPorts } from '../tickets/helpers.js';
import { messagesOf, scene, tasklistOf, tasklistProgressOf, tasklistsOf } from './helpers.js';

setupEmulators();

const PLAN = [{ title: 'Read the spec' }, { title: 'Write the exporter' }, { title: 'Add tests' }];

const systemLines = async (boardId: string, ticketId: string): Promise<string[]> =>
  (await messagesOf(boardId, ticketId))
    .filter((m: Message) => m.kind === 'system')
    .map((m) => m.body.text);

describe('tasklistSet', () => {
  it('creates a plan, keeps item ids on replace, and adds ONE system line', async () => {
    spyPorts();
    const { asha } = await people('asha');
    const sc = await scene(asha);

    const first = await asAgent(sc.agent, 'tasklistSet', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      title: 'Plan: add CSV export',
      items: PLAN,
    });
    expect(first.itemIds).toHaveLength(3);
    const list = (await tasklistOf(sc.boardId, sc.ticketId, first.listId))!;
    expect(list).toMatchObject({
      title: 'Plan: add CSV export',
      owner: sc.agent.id,
      position: 0,
      closedAt: null,
    });
    expect(list.items.map((i) => i.status)).toEqual(['todo', 'todo', 'todo']);
    expect(await tasklistProgressOf(sc.boardId, sc.ticketId)).toEqual({ done: 0, total: 3 });
    expect(await systemLines(sc.boardId, sc.ticketId)).toEqual([
      'Builder added a plan: Plan: add CSV export',
    ]);

    // Republishing the plan keeps the ids it names and does not talk again.
    const kept = list.items[0]!;
    const again = await asAgent(sc.agent, 'tasklistSet', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      listId: first.listId,
      title: 'Plan: add CSV export',
      items: [{ id: kept.id, title: kept.title, status: 'done' }, { title: 'Write the exporter' }],
    });
    expect(again.itemIds[0]).toBe(kept.id);
    const replaced = (await tasklistOf(sc.boardId, sc.ticketId, first.listId))!;
    expect(replaced.items).toHaveLength(2);
    expect(replaced.items[0]!.status).toBe('done');
    expect(await tasklistProgressOf(sc.boardId, sc.ticketId)).toEqual({ done: 1, total: 2 });
    expect(await systemLines(sc.boardId, sc.ticketId)).toHaveLength(1);

    // A second list on the same ticket lands after the first and rolls up.
    const second = await asAgent(sc.agent, 'tasklistSet', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      title: 'Plan: docs',
      items: [{ title: 'Write it up' }],
    });
    expect((await tasklistOf(sc.boardId, sc.ticketId, second.listId))!.position).toBe(1);
    expect(await tasklistProgressOf(sc.boardId, sc.ticketId)).toEqual({ done: 1, total: 3 });
    expect(await tasklistsOf(sc.boardId, sc.ticketId)).toHaveLength(2);
  });

  it('refuses a viewer, a stranger and more than 100 items', async () => {
    spyPorts();
    const { asha, vic } = await people('asha', 'vic');
    const sc = await scene(asha, { viewers: [vic] });
    await expect(
      call(vic, 'tasklistSet', {
        boardId: sc.boardId,
        ticketId: sc.ticketId,
        title: 'Mine',
        items: [{ title: 'a' }],
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await expect(
      call(asha, 'tasklistSet', {
        boardId: sc.boardId,
        ticketId: sc.ticketId,
        title: 'Too long',
        items: Array.from({ length: MAX_TASKLIST_ITEMS + 1 }, (_, i) => ({ title: `t${i}` })),
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it("a commenter agent owns its own list; an editor's list it may not touch", async () => {
    spyPorts();
    const { asha } = await people('asha');
    const sc = await scene(asha, { role: 'commenter' });

    const own = await asAgent(sc.agent, 'tasklistSet', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      title: 'Mine',
      items: [{ title: 'a' }],
    });
    expect((await tasklistOf(sc.boardId, sc.ticketId, own.listId))!.owner).toBe(sc.agent.id);

    const hers = await call(asha, 'tasklistSet', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      title: 'Hers',
      items: [{ title: 'b' }],
    });
    await expect(
      asAgent(sc.agent, 'tasklistSet', {
        boardId: sc.boardId,
        ticketId: sc.ticketId,
        listId: hers.listId,
        title: 'Hijacked',
        items: [{ title: 'c' }],
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // …but a person with editor rights (the admin) may tick the agent's list.
    await call(asha, 'tasklistItemUpdate', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      listId: own.listId,
      itemId: own.itemIds[0]!,
      status: 'doing',
    });
  });
});

describe('tasklistItemUpdate', () => {
  it('ticks items silently, and only the LAST tick talks', async () => {
    spyPorts();
    const { asha } = await people('asha');
    const sc = await scene(asha);
    const { listId, itemIds } = await asAgent(sc.agent, 'tasklistSet', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      title: 'Plan: add CSV export',
      items: PLAN,
    });
    const base = { boardId: sc.boardId, ticketId: sc.ticketId, listId };

    await asAgent(sc.agent, 'tasklistItemUpdate', {
      ...base,
      itemId: itemIds[0]!,
      status: 'doing',
    });
    let list = (await tasklistOf(sc.boardId, sc.ticketId, listId))!;
    expect(list.items[0]!.status).toBe('doing');
    expect(await systemLines(sc.boardId, sc.ticketId)).toHaveLength(1);

    await asAgent(sc.agent, 'tasklistItemUpdate', { ...base, itemId: itemIds[0]!, status: 'done' });
    await asAgent(sc.agent, 'tasklistItemUpdate', {
      ...base,
      itemId: itemIds[1]!,
      status: 'failed',
      note: 'the API changed',
    });
    expect(await tasklistProgressOf(sc.boardId, sc.ticketId)).toEqual({ done: 1, total: 3 });
    // A failed item is not settled, so the list is not finished.
    expect((await tasklistOf(sc.boardId, sc.ticketId, listId))!.closedAt).toBeNull();
    expect(await systemLines(sc.boardId, sc.ticketId)).toHaveLength(1);

    // Settle the rest: the list closes itself and says so, once.
    await asAgent(sc.agent, 'tasklistItemUpdate', {
      ...base,
      itemId: itemIds[1]!,
      status: 'skipped',
      note: null,
    });
    await asAgent(sc.agent, 'tasklistItemUpdate', { ...base, itemId: itemIds[2]!, status: 'done' });
    list = (await tasklistOf(sc.boardId, sc.ticketId, listId))!;
    expect(list.closedAt).not.toBeNull();
    expect(list.items[1]!.note).toBeUndefined();
    expect(await tasklistProgressOf(sc.boardId, sc.ticketId)).toEqual({ done: 3, total: 3 });
    expect(await systemLines(sc.boardId, sc.ticketId)).toEqual([
      'Builder added a plan: Plan: add CSV export',
      'Builder finished the plan: Plan: add CSV export',
    ]);
  });

  it('404s an unknown list or item', async () => {
    spyPorts();
    const { asha } = await people('asha');
    const sc = await scene(asha);
    const { listId, itemIds } = await asAgent(sc.agent, 'tasklistSet', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      title: 'Plan',
      items: PLAN,
    });
    await expect(
      call(asha, 'tasklistItemUpdate', {
        boardId: sc.boardId,
        ticketId: sc.ticketId,
        listId: 'nope',
        itemId: itemIds[0]!,
        status: 'done',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      call(asha, 'tasklistItemUpdate', {
        boardId: sc.boardId,
        ticketId: sc.ticketId,
        listId,
        itemId: 'nope',
        status: 'done',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('tasklistDelete', () => {
  it('removes the list silently and recomputes the chip', async () => {
    spyPorts();
    const { asha } = await people('asha');
    const sc = await scene(asha);
    const a = await asAgent(sc.agent, 'tasklistSet', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      title: 'A',
      items: [{ title: 'a1' }, { title: 'a2' }],
    });
    const b = await asAgent(sc.agent, 'tasklistSet', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      title: 'B',
      items: [{ title: 'b1' }],
    });
    const linesBefore = (await systemLines(sc.boardId, sc.ticketId)).length;

    await asAgent(sc.agent, 'tasklistDelete', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      listId: a.listId,
    });
    expect(await tasklistOf(sc.boardId, sc.ticketId, a.listId)).toBeUndefined();
    expect(await tasklistProgressOf(sc.boardId, sc.ticketId)).toEqual({ done: 0, total: 1 });
    expect(await systemLines(sc.boardId, sc.ticketId)).toHaveLength(linesBefore);

    await asAgent(sc.agent, 'tasklistDelete', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      listId: b.listId,
    });
    expect(await tasklistProgressOf(sc.boardId, sc.ticketId)).toBeNull();
  });
});
