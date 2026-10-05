/** ticketBulk, ticketState, ticketDelete under the emulators. */
import { describe, expect, it } from 'vitest';
import { paths, type KeyIndex, type Ticket } from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { call, setupEmulators } from '../harness/index.js';
import {
  doc,
  getDocData,
  people,
  putMemoryObject,
  seedAttachMemory,
  seedBoard,
  spyPorts,
  STAGES,
} from './helpers.js';
import { actsOf, filesOf, msgsOf } from './store.js';

setupEmulators();

const T = (b: string, t: string) => getDocData<Ticket>(paths.ticket(b, t));

describe('ticketBulk', () => {
  it('editor: any action; one digest notification; per-ticket webhooks', async () => {
    const s = spyPorts();
    const { asha, priya } = await people('asha', 'priya');
    const b = await seedBoard({ admin: asha, editors: [priya] });
    const ids = [];
    for (let i = 0; i < 3; i++)
      ids.push(
        (
          await call(asha, 'ticketCreate', {
            boardId: b.id,
            title: `t${i}`,
            assigneeUids: [priya.uid],
          })
        ).ticketId,
      );
    s.notified.length = 0;
    s.emitted.length = 0;

    const r = await call(priya, 'ticketBulk', {
      boardId: b.id,
      ticketIds: [...ids, 'missing'],
      action: { type: 'stage', stageId: STAGES.review },
    });
    expect(r).toEqual({ updated: 3, skipped: ['missing'] });
    for (const id of ids)
      expect((await T(b.id, id))!).toMatchObject({
        stageId: STAGES.review,
        stageCategory: 'active',
      });
    expect(s.notified).toHaveLength(1);
    expect(s.notified[0]).toMatchObject({
      event: 'stage',
      extra: { summary: 'priya moved 3 tickets to Review' },
    });
    expect(s.notified[0]!.extra!.recipients).toEqual([asha.uid]); // actor excluded
    expect(s.emitted.filter((e) => e.event === 'ticket.moved')).toHaveLength(3);

    await call(asha, 'ticketBulk', {
      boardId: b.id,
      ticketIds: ids,
      action: { type: 'addTag', tagId: 'tg_ui' },
    });
    await call(asha, 'ticketBulk', {
      boardId: b.id,
      ticketIds: ids,
      action: { type: 'field', fieldId: 'f_points', value: 8 },
    });
    const t0 = (await T(b.id, ids[0]!))!;
    expect(t0.tagIds).toEqual(['tg_ui']);
    expect(t0.fields).toEqual({ f_points: 8 });
    const acts = await actsOf(b.id, ids[0]!);
    expect(acts.filter((a) => a.action === 'update')).toHaveLength(3);

    // Into Done needs f_soluti: every ticket skipped, none failed.
    expect(
      await call(asha, 'ticketBulk', {
        boardId: b.id,
        ticketIds: ids,
        action: { type: 'stage', stageId: STAGES.done },
      }),
    ).toEqual({
      updated: 0,
      skipped: ids,
    });

    // State: archive two; then non-state actions skip closed tickets.
    expect(
      await call(asha, 'ticketBulk', {
        boardId: b.id,
        ticketIds: ids.slice(0, 2),
        action: { type: 'state', state: 'archived' },
      }),
    ).toEqual({
      updated: 2,
      skipped: [],
    });
    expect((await T(b.id, ids[0]!))!.state).toBe('archived');
    expect(
      await call(asha, 'ticketBulk', {
        boardId: b.id,
        ticketIds: ids,
        action: { type: 'priority', priorityId: 'p_low' },
      }),
    ).toEqual({
      updated: 1,
      skipped: ids.slice(0, 2),
    });
    // Restore is admin-only: an editor's restore run skips.
    expect(
      await call(priya, 'ticketBulk', {
        boardId: b.id,
        ticketIds: ids.slice(0, 2),
        action: { type: 'state', state: 'active' },
      }),
    ).toEqual({
      updated: 0,
      skipped: ids.slice(0, 2),
    });
  });

  it('commenter: stage only, over the tickets their grant covers — the rest skipped', async () => {
    spyPorts();
    const { asha, cora, vic } = await people('asha', 'cora', 'vic');
    const b = await seedBoard({
      admin: asha,
      commenters: [cora],
      viewers: [vic],
      grants: { [cora.uid]: { stages: [STAGES.todo, STAGES.doing], assignedOnly: true } },
    });
    const mine = (
      await call(asha, 'ticketCreate', { boardId: b.id, title: 'mine', assigneeUids: [cora.uid] })
    ).ticketId;
    const notMine = (await call(asha, 'ticketCreate', { boardId: b.id, title: 'not mine' }))
      .ticketId;
    const r = await call(cora, 'ticketBulk', {
      boardId: b.id,
      ticketIds: [mine, notMine],
      action: { type: 'stage', stageId: STAGES.doing },
    });
    expect(r).toEqual({ updated: 1, skipped: [notMine] });
    const act = (await actsOf(b.id, mine)).find((a) => a.action === 'update')!;
    expect(act.viaGrant).toEqual([STAGES.todo, STAGES.doing]);

    await expect(
      call(cora, 'ticketBulk', {
        boardId: b.id,
        ticketIds: [mine],
        action: { type: 'priority', priorityId: 'p_high' },
      }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      call(vic, 'ticketBulk', {
        boardId: b.id,
        ticketIds: [mine],
        action: { type: 'stage', stageId: STAGES.doing },
      }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('ticketState', () => {
  it('archive: can(state); restore: admin only; activity + system line + notify', async () => {
    const s = spyPorts();
    const { asha, priya, cora } = await people('asha', 'priya', 'cora');
    const b = await seedBoard({ admin: asha, editors: [priya], commenters: [cora] });
    const { ticketId } = await call(priya, 'ticketCreate', { boardId: b.id, title: 'x' });

    await expect(
      call(cora, 'ticketState', { boardId: b.id, ticketId, state: 'archived' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    s.notified.length = 0;
    await call(priya, 'ticketState', { boardId: b.id, ticketId, state: 'archived' });
    const t = (await T(b.id, ticketId))!;
    expect(t.state).toBe('archived');
    expect(t.counts.messages).toBe(1);
    const msgs = await msgsOf(b.id, ticketId);
    expect(msgs).toEqual([
      expect.objectContaining({ kind: 'system', authorUid: null, authorName: 'priya' }),
    ]);
    expect(msgs[0]!.body.text).toBe('priya archived this ticket');
    const acts = await actsOf(b.id, ticketId);
    expect(acts.find((a) => a.action === 'state')!.changes).toEqual({
      state: { from: 'active', to: 'archived' },
    });
    expect(s.notified.map((n) => n.event)).toEqual(['state']);
    expect(s.emitted.at(-1)).toMatchObject({ event: 'ticket.state', data: { state: 'archived' } });

    await expect(
      call(priya, 'ticketState', { boardId: b.id, ticketId, state: 'active' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      call(asha, 'ticketState', { boardId: b.id, ticketId, state: 'archived' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await call(asha, 'ticketState', { boardId: b.id, ticketId, state: 'active' });
    expect((await T(b.id, ticketId))!.state).toBe('active');
  });
});

describe('ticketDelete', () => {
  it('needs allowDelete; cleans links / referencedBy / prefs; tombstones the key; recursive delete', async () => {
    const s = spyPorts();
    const { asha, priya, cora } = await people('asha', 'priya', 'cora');
    const off = await seedBoard({ admin: asha });
    const x = await call(asha, 'ticketCreate', { boardId: off.id, title: 'x' });
    await expect(
      call(asha, 'ticketDelete', { boardId: off.id, ticketId: x.ticketId }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const b = await seedBoard({
      admin: asha,
      editors: [priya],
      commenters: [cora],
      allowDelete: true,
    });
    const target = await call(asha, 'ticketCreate', { boardId: b.id, title: 'target' });
    const other = await call(asha, 'ticketCreate', { boardId: b.id, title: 'other' });
    const path = (id: string) => `boards/${b.id}/tickets/${id}/a1/f.txt`;
    const victimId = 'victim' + Date.now();
    // An object from before memory.html §J under the ticket's prefix: it goes with the ticket.
    s.files.put(path(victimId), 5, 'text/plain');
    // A file put on it now lives in a memory: it stays when the ticket goes.
    const memoryId = await seedAttachMemory(b.id, asha);
    const up = await putMemoryObject(s.files, memoryId, 'f.txt');
    const victim = await call(asha, 'ticketCreate', {
      boardId: b.id,
      ticketId: victimId,
      title: 'victim',
      description: doc('see ', { ticketId: target.ticketId, key: target.key }),
      memoryUploads: [{ memoryId, path: 'f.txt', storagePath: up.storagePath }],
    });
    await call(asha, 'ticketUpdate', {
      boardId: b.id,
      ticketId: victimId,
      patch: { links: [{ type: 'blocks', ticketId: other.ticketId }] },
    });
    await db()
      .doc(paths.pref(b.id, priya.uid))
      .set({ mode: 'mine', watching: [victimId], starred: false, lastViewId: 'v' });
    await db()
      .doc(paths.ticket(b.id, victimId))
      .update({ watcherUids: [asha.uid, priya.uid] });
    expect((await T(b.id, target.ticketId))!.referencedBy).toEqual([victimId]);

    // can(delete) is editor+ (and only with allowDelete).
    await expect(
      call(cora, 'ticketDelete', { boardId: b.id, ticketId: victimId }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await call(priya, 'ticketDelete', { boardId: b.id, ticketId: victimId });

    expect(await T(b.id, victimId)).toBeUndefined();
    expect(await actsOf(b.id, victimId)).toEqual([]);
    expect(await filesOf(b.id, victimId)).toEqual([]);
    expect(s.files.has(path(victimId))).toBe(false);
    expect(s.files.has(up.storagePath)).toBe(true);
    expect((await T(b.id, target.ticketId))!.referencedBy).toEqual([]);
    expect((await T(b.id, other.ticketId))!.links).toEqual([]);
    expect(
      (await getDocData<{ watching: string[] }>(paths.pref(b.id, priya.uid)))!.watching,
    ).toEqual([]);
    expect(await getDocData<KeyIndex>(paths.key(victim.key))).toMatchObject({
      ticketId: victimId,
      deleted: true,
    });
    expect(s.emitted.at(-1)).toMatchObject({
      event: 'ticket.deleted',
      data: { id: victimId, key: victim.key },
    });

    // Never reissued: the next ticket gets a fresh number.
    const next = await call(asha, 'ticketCreate', { boardId: b.id, title: 'next' });
    expect(next.key).not.toBe(victim.key);
  });
});
