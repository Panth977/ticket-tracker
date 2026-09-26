/** allocateKey + ticketCreate under the emulators. */
import { describe, expect, it } from 'vitest';
import { paths, type KeyIndex, type Ticket } from '@tm/shared';
import { call, setupEmulators, uniq } from '../harness/index.js';
import { doc, getDocData, listDocs, people, seedBoard, spyPorts, STAGES } from './helpers.js';
import { actsOf, filesOf } from './store.js';

setupEmulators();

describe('ticketCreate', () => {
  it('allocates consecutive keys, indexes them, and writes the ticket + activity', async () => {
    const s = spyPorts();
    const { asha, priya } = await people('asha', 'priya');
    const b = await seedBoard({ admin: asha, editors: [priya] });

    const r1 = await call(asha, 'ticketCreate', {
      boardId: b.id,
      title: 'First',
      assigneeUids: [priya.uid],
    });
    const r2 = await call(priya, 'ticketCreate', {
      boardId: b.id,
      title: 'Second',
      priorityId: 'p_high',
      tagIds: ['tg_bug', 'tg_bug'],
    });
    expect(r1.key).toBe(`${b.key}-1`);
    expect(r2.key).toBe(`${b.key}-2`);

    const board = await getDocData<{ nextNumber: number }>(paths.board(b.id));
    expect(board!.nextNumber).toBe(3);
    expect(await getDocData<KeyIndex>(paths.key(r1.key))).toEqual({
      ticketId: r1.ticketId,
      boardId: b.id,
      current: r1.key,
    });

    const t1 = (await getDocData<Ticket>(paths.ticket(b.id, r1.ticketId)))!;
    expect(t1).toMatchObject({
      key: r1.key,
      number: 1,
      title: 'First',
      stageId: STAGES.todo, // default: first 'todo' stage
      stageCategory: 'todo',
      state: 'active',
      assigneeUids: [priya.uid],
      watcherUids: [asha.uid, priya.uid],
      reporter: { uid: asha.uid, name: 'asha' },
      createdBy: asha.uid,
      createdVia: 'app',
      completedAt: null,
      counts: { messages: 0, files: 0, pinned: 0 },
    });
    const t2 = (await getDocData<Ticket>(paths.ticket(b.id, r2.ticketId)))!;
    expect(t2.tagIds).toEqual(['tg_bug']);
    expect(t2.rank > t1.rank).toBe(true); // appended to the column

    const acts = await actsOf(b.id, r1.ticketId);
    expect(acts).toEqual([
      expect.objectContaining({ action: 'create', actor: asha.uid, via: 'app' }),
    ]);

    expect(s.notified.map((n) => n.event)).toEqual(expect.arrayContaining(['created', 'assigned']));
    expect(s.notified.find((n) => n.event === 'assigned')!.extra!.recipients).toEqual([priya.uid]);
    expect(s.emitted.filter((e) => e.event === 'ticket.created')).toHaveLength(2);
    expect(s.emitted[0]!.data).toMatchObject({
      key: r1.key,
      title: 'First',
      stage: { id: STAGES.todo },
    });
  });

  it('validates against the board: stage, tags, fields, members, required, requires', async () => {
    spyPorts();
    const { asha, out } = await people('asha', 'out');
    const b = await seedBoard({
      admin: asha,
      patch: {
        fields: [
          { id: 'f_soluti', name: 'Solution', type: 'longText', position: 0 },
          {
            id: 'f_client',
            name: 'Client',
            type: 'select',
            position: 1,
            required: true,
            options: [{ id: 'o_acme', name: 'Acme', position: 0 }],
          },
        ],
      },
    });
    const base = { boardId: b.id, title: 'x', fields: { f_client: 'o_acme' } };
    await expect(call(asha, 'ticketCreate', { ...base, stageId: 'nope' })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(call(asha, 'ticketCreate', { ...base, tagIds: ['tg_zzz'] })).rejects.toMatchObject(
      { code: 'invalid' },
    );
    await expect(
      call(asha, 'ticketCreate', { ...base, priorityId: 'p_zzz' }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      call(asha, 'ticketCreate', { ...base, assigneeUids: [out.uid] }),
    ).rejects.toMatchObject({
      code: 'invalid',
      details: { uids: [out.uid] },
    });
    await expect(
      call(asha, 'ticketCreate', { ...base, fields: { f_client: 'o_nope' } }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(call(asha, 'ticketCreate', { boardId: b.id, title: 'x' })).rejects.toMatchObject({
      code: 'invalid',
      details: { missing: ['f_client'] },
    });
    // Done requires f_soluti → 422 { missing }
    await expect(
      call(asha, 'ticketCreate', { ...base, stageId: STAGES.done }),
    ).rejects.toMatchObject({
      code: 'unprocessable',
      details: { missing: ['f_soluti'] },
    });
    const ok = await call(asha, 'ticketCreate', {
      ...base,
      stageId: STAGES.done,
      fields: { f_client: 'o_acme', f_soluti: 'fixed' },
    });
    const t = (await getDocData<Ticket>(paths.ticket(b.id, ok.ticketId)))!;
    expect(t.stageCategory).toBe('done');
    expect(t.completedAt).toEqual(expect.any(Number));
  });

  it('permissions: editor+ creates; commenter / viewer 403; outsider 404', async () => {
    spyPorts();
    const { asha, cora, vic, out } = await people('asha', 'cora', 'vic', 'out');
    const b = await seedBoard({ admin: asha, commenters: [cora], viewers: [vic] });
    await expect(call(cora, 'ticketCreate', { boardId: b.id, title: 'x' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(call(vic, 'ticketCreate', { boardId: b.id, title: 'x' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(call(out, 'ticketCreate', { boardId: b.id, title: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      call(asha, 'ticketCreate', { boardId: uniq('nob'), title: 'x' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('description: mentions of members only, refs → referencedBy on the target, attachments → files/', async () => {
    const s = spyPorts();
    const { asha, priya, out } = await people('asha', 'priya', 'out');
    const b = await seedBoard({ admin: asha, editors: [priya] });
    const target = await call(asha, 'ticketCreate', { boardId: b.id, title: 'Target' });

    const ticketId = uniq('t');
    const path = `boards/${b.id}/tickets/${ticketId}/att1/screen shot.png`;
    s.files.put(path, 1234, 'image/png');
    const r = await call(asha, 'ticketCreate', {
      boardId: b.id,
      ticketId,
      title: 'Source',
      description: doc('Hey ', { uid: priya.uid }, ' and ', { uid: out.uid }, ' see ', {
        ticketId: target.ticketId,
        key: target.key,
      }),
      attachments: [path],
    });
    expect(r.ticketId).toBe(ticketId);
    const t = (await getDocData<Ticket>(paths.ticket(b.id, ticketId)))!;
    expect(t.description!.mentions).toEqual([priya.uid]); // the outsider became plain text
    expect(t.description!.text).toBe(`Hey @priya and @someone see #${target.key}`);
    expect(t.refs).toEqual([target.ticketId]);
    expect(t.counts.files).toBe(1);
    const tgt = (await getDocData<Ticket>(paths.ticket(b.id, target.ticketId)))!;
    expect(tgt.referencedBy).toEqual([ticketId]);
    const files = await filesOf(b.id, ticketId);
    expect(files).toEqual([
      expect.objectContaining({
        id: 'att1',
        name: 'screen shot.png',
        size: 1234,
        mime: 'image/png',
        source: 'description',
        messageId: null,
      }),
    ]);
    expect(s.notified.find((n) => n.event === 'mentioned')!.extra!.mentioned).toEqual([priya.uid]);

    // same client id again → 409, never a second ticket
    await expect(
      call(asha, 'ticketCreate', { boardId: b.id, ticketId, title: 'Again' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // attachments must be under the ticket's prefix and exist
    await expect(
      call(asha, 'ticketCreate', {
        boardId: b.id,
        title: 'x',
        attachments: [`boards/${b.id}/tickets/other/a/b.png`],
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    const t2 = uniq('t');
    await expect(
      call(asha, 'ticketCreate', {
        boardId: b.id,
        ticketId: t2,
        title: 'x',
        attachments: [`boards/${b.id}/tickets/${t2}/a/missing.png`],
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a retried create (same clientId) is one ticket', async () => {
    spyPorts();
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const clientId = uniq('c');
    const a = await call(asha, 'ticketCreate', { boardId: b.id, title: 'Once', clientId });
    const again = await call(asha, 'ticketCreate', { boardId: b.id, title: 'Once', clientId });
    expect(again).toEqual(a);
    expect(await listDocs(paths.tickets(b.id))).toHaveLength(1);
  });
});
