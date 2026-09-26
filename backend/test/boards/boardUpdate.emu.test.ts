import { describe, expect, it } from 'vitest';
import { paths, type Ticket } from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { setupEmulators } from '../harness/index.js';
import {
  addMember,
  call,
  createUser,
  getBoard,
  getViews,
  newBoard,
  seedTicket,
} from './helpers.js';
import { actsOf } from '../tickets/store.js';

setupEmulators();

const ticket = async (boardId: string, id: string) =>
  (await db().doc(paths.ticket(boardId, id)).get()).data() as Ticket;
// §W: the activity rows are a field of the ticket document.
const activity = async (boardId: string, id: string) => actsOf(boardId, id);

describe('boardUpdate', () => {
  it('admin only: editors 403, strangers 404', async () => {
    const alice = await createUser();
    const ed = await createUser();
    const eve = await createUser();
    const { boardId } = await newBoard(alice);
    await addMember(boardId, ed, 'editor');
    await expect(call(ed, 'boardUpdate', { boardId, patch: { name: 'X' } })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(call(eve, 'boardUpdate', { boardId, patch: { name: 'X' } })).rejects.toMatchObject(
      {
        code: 'not_found',
      },
    );
  });

  it('per-section patches: name, settings merged key by key, description derived', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    await call(alice, 'boardUpdate', {
      boardId,
      patch: {
        name: 'Platform',
        settings: { allowDelete: true },
        description: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
        },
      },
    });
    await call(alice, 'boardUpdate', { boardId, patch: { settings: { editorsCanInvite: true } } });
    const b = (await getBoard(boardId))!;
    expect(b.name).toBe('Platform');
    expect(b.settings).toMatchObject({
      allowDelete: true,
      editorsCanInvite: true,
      emailReplies: true,
    });
    expect(b.description).toMatchObject({ text: 'Hello', mentions: [], refs: [] });
  });

  it('removing a stage with tickets → 409 { stageId, count }; with remap tickets move', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    const b = (await getBoard(boardId))!;
    const [todo, doing, done] = b.stages;
    const t1 = await seedTicket(boardId, { stageId: doing!.id });
    await seedTicket(boardId, { stageId: doing!.id });

    const without = [todo!, done!];
    await expect(
      call(alice, 'boardUpdate', { boardId, patch: { stages: without } }),
    ).rejects.toMatchObject({ code: 'conflict', details: { stageId: doing!.id, count: 2 } });

    await call(alice, 'boardUpdate', {
      boardId,
      patch: { stages: without },
      remap: { stages: { [doing!.id]: done!.id } },
    });
    const t = await ticket(boardId, t1);
    expect(t).toMatchObject({ stageId: done!.id, stageCategory: 'done' });
    expect(t.completedAt).toEqual(expect.any(Number));
    expect(await activity(boardId, t1)).toEqual([
      expect.objectContaining({
        action: 'update',
        actor: alice.uid,
        changes: expect.objectContaining({ stageId: { from: doing!.id, to: done!.id } }),
      }),
    ]);
    expect((await getBoard(boardId))!.stages.map((s) => s.id)).toEqual([todo!.id, done!.id]);
  });

  it('removing an empty stage needs no remap; bad remap targets are 400', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    const [todo, doing, done] = (await getBoard(boardId))!.stages;
    await expect(
      call(alice, 'boardUpdate', {
        boardId,
        patch: { stages: [todo!, done!] },
        remap: { stages: { [doing!.id]: 'nope' } },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await call(alice, 'boardUpdate', { boardId, patch: { stages: [todo!, done!] } });
    expect((await getBoard(boardId))!.stages).toHaveLength(2);
  });

  it('a stage category change propagates stageCategory (and completedAt) to its tickets', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    const stages = (await getBoard(boardId))!.stages;
    const t1 = await seedTicket(boardId, { stageId: stages[1]!.id });
    const t2 = await seedTicket(boardId, { stageId: stages[0]!.id });
    await call(alice, 'boardUpdate', {
      boardId,
      patch: { stages: stages.map((s, i) => (i === 1 ? { ...s, category: 'done' as const } : s)) },
    });
    expect(await ticket(boardId, t1)).toMatchObject({
      stageCategory: 'done',
      completedAt: expect.any(Number),
    });
    expect(await ticket(boardId, t2)).toMatchObject({ stageCategory: 'todo' });
  });

  it('a removed field is archived, never deleted; type changes are refused', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice, { template: 'bugs' });
    const fields = (await getBoard(boardId))!.fields;
    await call(alice, 'boardUpdate', { boardId, patch: { fields: fields.slice(1) } });
    const after = (await getBoard(boardId))!.fields;
    expect(after).toHaveLength(fields.length);
    expect(after.find((f) => f.id === fields[0]!.id)).toMatchObject({ archived: true });
    await expect(
      call(alice, 'boardUpdate', {
        boardId,
        patch: { fields: [{ ...fields[2]!, type: 'number' as const }] },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('priorities: removal in use → 409 { priorityId, count }; remap rewrites priorityId', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    const b = (await getBoard(boardId))!;
    const [urgent, high] = b.priorities;
    const t = await seedTicket(boardId, { stageId: b.stages[0]!.id, priorityId: urgent!.id });
    const rest = b.priorities.slice(1);
    await expect(
      call(alice, 'boardUpdate', { boardId, patch: { priorities: rest } }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { priorityId: urgent!.id, count: 1 },
    });
    await call(alice, 'boardUpdate', {
      boardId,
      patch: { priorities: rest },
      remap: { priorities: { [urgent!.id]: high!.id } },
    });
    expect((await ticket(boardId, t)).priorityId).toBe(high!.id);
  });

  it('a removed tag is pulled from tickets', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice, { template: 'bugs' });
    const b = (await getBoard(boardId))!;
    const [bug, reg] = b.tags;
    const t = await seedTicket(boardId, { stageId: b.stages[0]!.id, tagIds: [bug!.id, reg!.id] });
    await call(alice, 'boardUpdate', { boardId, patch: { tags: b.tags.slice(1) } });
    expect((await ticket(boardId, t)).tagIds).toEqual([reg!.id]);
  });

  it('defaultViewId must be an existing shared view', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    const views = await getViews(boardId);
    const table = views.find((v) => v.name === 'Table')!;
    await call(alice, 'boardUpdate', { boardId, patch: { defaultViewId: table.id } });
    expect((await getBoard(boardId))!.defaultViewId).toBe(table.id);
    await expect(
      call(alice, 'boardUpdate', { boardId, patch: { defaultViewId: 'nope' } }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('archived boards are read-only → 409', async () => {
    const alice = await createUser();
    const { boardId } = await newBoard(alice);
    await call(alice, 'boardArchive', { boardId, action: 'archive' });
    await expect(
      call(alice, 'boardUpdate', { boardId, patch: { name: 'Y' } }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});
