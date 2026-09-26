/**
 * Agents as principals on tickets and in the thread (agents.html §A, §E, §F):
 * assignees / watchers / mentions / authorUid / activity actor hold agent ids;
 * token writes carry viaToken; scopes ∩ role; API uploads (storeUploadedFile)
 * posted by messagePost fileIds.
 */
import { describe, expect, it } from 'vitest';
import { paths, type Ticket } from '@tm/shared';
import { storeUploadedFile } from '../../src/tickets/files.js';
import { makeCtx } from '../../src/runtime/context.js';
import { call, setupEmulators } from '../harness/index.js';
import { asAgent, makeAgent } from '../agents/helpers.js';
import { doc, getDocData, people, seedBoard, spyPorts, STAGES } from './helpers.js';
import { actsOf, fileOf, msgOf } from './store.js';

setupEmulators();

const T = (b: string, t: string) => getDocData<Ticket>(paths.ticket(b, t)).then((x) => x!);
const text = (s: string) => doc(s);
const enc = (s: string) => new TextEncoder().encode(s);

describe('agents on tickets', () => {
  it('a person assigns an agent; the agent comments with Markdown, via its token', async () => {
    const s = spyPorts();
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const agent = await makeAgent(asha, { boardId: b.id, role: 'editor' });

    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'Build it' });
    await call(asha, 'ticketUpdate', {
      boardId: b.id,
      ticketId,
      patch: { assigneeUids: [agent.id] },
    });
    expect((await T(b.id, ticketId)).assigneeUids).toEqual([agent.id]);
    expect(s.notified.find((n) => n.event === 'assigned')?.extra?.recipients).toEqual([agent.id]);

    const md = '## Plan\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const { messageId } = await asAgent(
      agent,
      'messagePost',
      { boardId: b.id, ticketId, body: text('Plan a b 1 2'), markdown: md, clientId: 'm-agent-1' },
      { keyName: 'orch-eng-builder' },
    );
    const m = (await msgOf(b.id, ticketId, messageId))!;
    expect(m).toMatchObject({
      authorUid: agent.id,
      authorName: 'Builder',
      via: 'api',
      viaToken: 'orch-eng-builder',
      markdown: md,
    });
    const t = await T(b.id, ticketId);
    expect(t.watcherUids).toContain(agent.id);
    // Agents never open the app: no read pointer is written for them.
    expect(await getDocData(paths.read(agent.id, ticketId))).toBeUndefined();

    // An edit in the app editor drops the Markdown source.
    await asAgent(agent, 'messageEdit', {
      boardId: b.id,
      ticketId,
      messageId,
      body: text('edited'),
    });
    expect((await msgOf(b.id, ticketId, messageId))!.markdown).toBeNull();
  });

  it('an agent moves, updates and assigns; activity records it and the token', async () => {
    spyPorts();
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const agent = await makeAgent(asha, { boardId: b.id, role: 'editor' });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'x' });

    await asAgent(
      agent,
      'ticketUpdate',
      {
        boardId: b.id,
        ticketId,
        patch: { stageId: STAGES.doing, title: 'y', assigneeUids: [asha.uid, agent.id] },
      },
      { keyName: 'orch-1' },
    );
    const t = await T(b.id, ticketId);
    expect(t).toMatchObject({
      stageId: STAGES.doing,
      title: 'y',
      assigneeUids: [asha.uid, agent.id],
    });
    const acts = await actsOf(b.id, ticketId);
    expect(acts.find((a) => a.action === 'update')).toMatchObject({
      actor: agent.id,
      via: 'api',
      viaToken: 'orch-1',
    });

    // An agent may create a ticket (it is its reporter and first watcher) and mention itself away.
    const r = await asAgent(agent, 'ticketCreate', {
      boardId: b.id,
      title: 'agent made',
      assigneeUids: [agent.id],
    });
    const made = await T(b.id, r.ticketId);
    expect(made).toMatchObject({
      createdBy: agent.id,
      reporter: { uid: agent.id, name: 'Builder' },
    });
    expect(made.watcherUids).toEqual([agent.id]);

    // Agents may watch; no prefs row is written for them.
    await asAgent(agent, 'ticketWatch', { boardId: b.id, ticketId, watching: false });
    expect((await T(b.id, ticketId)).watcherUids).not.toContain(agent.id);
    expect(await getDocData(paths.pref(b.id, agent.id))).toBeUndefined();
  });

  it('a token needs every scope its patch touches; the role still applies', async () => {
    spyPorts();
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const editor = await makeAgent(asha, { boardId: b.id, role: 'editor' });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'x' });

    // Worker preset: no tickets:assign.
    const worker = [
      'board:read',
      'tickets:read',
      'comments:read',
      'comments:write',
      'files:write',
      'tickets:move',
      'tickets:update',
    ] as const;
    await expect(
      asAgent(
        editor,
        'ticketUpdate',
        { boardId: b.id, ticketId, patch: { assigneeUids: [asha.uid] } },
        { scopes: worker },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      asAgent(
        editor,
        'ticketCreate',
        { boardId: b.id, title: 'z', assigneeUids: [asha.uid] },
        { scopes: [...worker, 'tickets:create'] },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Only tickets:assign: assigning works, a title change does not.
    await asAgent(
      editor,
      'ticketUpdate',
      { boardId: b.id, ticketId, patch: { assigneeUids: [asha.uid] } },
      { scopes: ['tickets:assign'] },
    );
    await expect(
      asAgent(
        editor,
        'ticketUpdate',
        { boardId: b.id, ticketId, patch: { title: 'no' } },
        { scopes: ['tickets:assign'] },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Bulk: the one scope of the action.
    await expect(
      asAgent(
        editor,
        'ticketBulk',
        { boardId: b.id, ticketIds: [ticketId], action: { type: 'stage', stageId: STAGES.doing } },
        { scopes: ['tickets:update'] },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      await asAgent(
        editor,
        'ticketBulk',
        { boardId: b.id, ticketIds: [ticketId], action: { type: 'stage', stageId: STAGES.doing } },
        { scopes: ['tickets:move'] },
      ),
    ).toEqual({ updated: 1, skipped: [] });

    // A commenter agent can never move outside its StageGrant, whatever the token says.
    const commenter = await makeAgent(asha, {
      boardId: b.id,
      role: 'commenter',
      name: 'Commenter',
    });
    await call(asha, 'boardAgentSet', {
      boardId: b.id,
      agentId: commenter.id,
      role: 'commenter',
      stageGrant: { stages: [STAGES.todo, STAGES.doing] },
    });
    await asAgent(commenter, 'ticketUpdate', {
      boardId: b.id,
      ticketId,
      patch: { stageId: STAGES.todo },
    });
    await expect(
      asAgent(commenter, 'ticketUpdate', {
        boardId: b.id,
        ticketId,
        patch: { stageId: STAGES.review },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      asAgent(commenter, 'ticketUpdate', { boardId: b.id, ticketId, patch: { title: 't' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // A token narrowed to another board sees nothing here.
    await expect(
      asAgent(
        editor,
        'ticketUpdate',
        { boardId: b.id, ticketId, patch: { title: 't' } },
        { boardIds: ['elsewhere'] },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('mentions of agents on the board are kept; of agents elsewhere dropped', async () => {
    const s = spyPorts();
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const here = await makeAgent(asha, { boardId: b.id });
    const away = await makeAgent(asha, { name: 'Away' });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'x' });
    s.notified.length = 0;
    const { messageId } = (await call(asha, 'messagePost', {
      boardId: b.id,
      ticketId,
      body: doc('hey ', { uid: here.id }, ' and ', { uid: away.id }),
      clientId: 'mention-agents',
    })) as { messageId: string };
    const m = (await msgOf(b.id, ticketId, messageId))!;
    expect(m.body.mentions).toEqual([here.id]);
    expect(s.notified.find((n) => n.event === 'mentioned')?.extra?.mentioned).toEqual([here.id]);
  });
});

describe('API uploads (storeUploadedFile) and messagePost fileIds', () => {
  it('stores the blob + files/ row (source upload, unattached); a message attaches it', async () => {
    const s = spyPorts();
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const agent = await makeAgent(asha, { boardId: b.id, role: 'commenter' });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'x' });

    const ctx = makeCtx({
      actor: agent.id,
      ownerUid: asha.uid,
      via: 'api',
      scopes: ['files:write', 'comments:write'],
      keyName: 'orch',
    });
    const up = await storeUploadedFile(ctx, {
      boardId: b.id,
      ticketId,
      name: '../reports/Q3 plan.md',
      mime: 'application/octet-stream',
      data: enc('# Plan\n\nShip it.'),
    });
    expect(up).toMatchObject({
      name: 'Q3 plan.md',
      mime: 'text/markdown',
      kind: 'markdown',
      size: 16,
      uploadedBy: agent.id,
    });
    expect(s.files.has(up.path)).toBe(true);
    expect(up.path).toBe(`boards/${b.id}/tickets/${ticketId}/${up.fileId}/Q3%20plan.md`);
    const row = (await fileOf(b.id, ticketId, up.fileId))!;
    expect(row).toMatchObject({
      source: 'upload',
      messageId: null,
      uploadedBy: agent.id,
      deletedAt: null,
    });
    expect((await T(b.id, ticketId)).counts.files).toBe(1);

    const html = await storeUploadedFile(ctx, {
      boardId: b.id,
      ticketId,
      name: 'report.html',
      data: enc('<h1>hi</h1>'),
    });
    expect(html).toMatchObject({ kind: 'html', mime: 'text/html' });

    // Files only, empty body.
    const { messageId } = await asAgent(agent, 'messagePost', {
      boardId: b.id,
      ticketId,
      body: { type: 'doc', content: [{ type: 'paragraph' }] },
      fileIds: [up.fileId, html.fileId],
      clientId: 'files-only',
    });
    const m = (await msgOf(b.id, ticketId, messageId))!;
    expect(m.attachments.map((a) => a.id)).toEqual([up.fileId, html.fileId]);
    expect(m.attachments[0]).toMatchObject({
      name: 'Q3 plan.md',
      mime: 'text/markdown',
      uploadedBy: agent.id,
    });
    expect(await fileOf(b.id, ticketId, up.fileId)).toMatchObject({
      source: 'message',
      messageId,
    });
    // Counted once, at upload.
    expect((await T(b.id, ticketId)).counts.files).toBe(2);

    // Already posted, or not on this ticket → 400.
    await expect(
      asAgent(agent, 'messagePost', {
        boardId: b.id,
        ticketId,
        body: text('again'),
        fileIds: [up.fileId],
        clientId: 'again',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      asAgent(agent, 'messagePost', {
        boardId: b.id,
        ticketId,
        body: text('x'),
        fileIds: ['nope'],
        clientId: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('refuses viewers, closed tickets and files over 25 MB', async () => {
    const s = spyPorts();
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const viewer = await makeAgent(asha, { boardId: b.id, role: 'viewer' });
    const editor = await makeAgent(asha, { boardId: b.id, role: 'editor', name: 'Ed' });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'x' });
    const ctxOf = (id: string) =>
      makeCtx({ actor: id, ownerUid: asha.uid, via: 'api', scopes: ['files:write'] });

    await expect(
      storeUploadedFile(ctxOf(viewer.id), {
        boardId: b.id,
        ticketId,
        name: 'a.txt',
        data: enc('a'),
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      storeUploadedFile(makeCtx({ actor: editor.id, via: 'api', scopes: ['comments:write'] }), {
        boardId: b.id,
        ticketId,
        name: 'a.txt',
        data: enc('a'),
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      storeUploadedFile(ctxOf(editor.id), {
        boardId: b.id,
        ticketId,
        name: 'big.bin',
        data: new Uint8Array(25 * 1024 * 1024 + 1),
      }),
    ).rejects.toMatchObject({ code: 'too_large' });
    await call(asha, 'ticketState', { boardId: b.id, ticketId, state: 'archived' });
    await expect(
      storeUploadedFile(ctxOf(editor.id), {
        boardId: b.id,
        ticketId,
        name: 'a.txt',
        data: enc('a'),
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(s.files.paths().filter((p) => p.includes(ticketId))).toEqual([]);
  });
});
