/**
 * Agent profiles and agents on boards (agents.html §B, §C):
 * agentCreate / agentUpdate / agentArchive / boardAgentSet / agentInboxAck,
 * and boardAccessSet refusing agent ids.
 */
import { describe, expect, it } from 'vitest';
import {
  agentEventId,
  paths,
  storage,
  type Agent,
  type AgentInboxEvent,
  type Board,
  type BoardMember,
  type Ticket,
} from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { call, setPorts, setupEmulators } from '../harness/index.js';
import { getDocData, memoryFiles, people, seedBoard, STAGES } from '../tickets/helpers.js';
import { msgOf } from '../tickets/store.js';
import { apiKeyOf, asAgent, makeAgent, seedAgentToken } from './helpers.js';

setupEmulators();

const agentDoc = (id: string) => getDocData<Agent>(paths.agent(id)).then((a) => a!);
const boardDoc = (id: string) => getDocData<Board>(paths.board(id)).then((b) => b!);
const memberDoc = (b: string, id: string) => getDocData<BoardMember>(paths.member(b, id));

describe('agentCreate', () => {
  it('creates a profile owned by the caller; only the owner sees it', async () => {
    const { asha, vic } = await people('asha', 'vic');
    const { agentId } = await call(asha, 'agentCreate', {
      name: 'Builder',
      description: 'Builds the thing',
      systemPrompt: '# Build',
    });
    expect(agentId).toMatch(/^ag_[A-Za-z0-9]{16}$/);
    expect(await agentDoc(agentId)).toMatchObject({
      ownerUid: asha.uid,
      name: 'Builder',
      description: 'Builds the thing',
      systemPrompt: '# Build',
      avatarPath: null,
      icon: null,
      archivedAt: null,
    });
    // Private: someone else gets 404, never 403.
    await expect(call(vic, 'agentUpdate', { agentId, name: 'Mine' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('takes a client-chosen id (409 when taken) and an avatar uploaded under it', async () => {
    const files = memoryFiles();
    setPorts({ files });
    const { asha } = await people('asha');
    const agentId = 'ag_' + Math.random().toString(36).slice(2, 10).padEnd(8, 'x') + 'AbCd1234';
    const avatar = storage.agentAvatar(asha.uid, agentId, 1);
    files.put(avatar, 1000, 'image/webp');
    await call(asha, 'agentCreate', { agentId, name: 'Pic', avatarPath: avatar });
    expect((await agentDoc(agentId)).avatarPath).toBe(avatar);
    await expect(call(asha, 'agentCreate', { agentId, name: 'Again' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('stores a prebuilt icon id and refuses an unknown one', async () => {
    const { asha } = await people('asha');
    const { agentId } = await call(asha, 'agentCreate', { name: 'Claude', icon: 'claude' });
    expect((await agentDoc(agentId)).icon).toBe('claude');
    await expect(
      call(asha, 'agentCreate', { name: 'x', icon: 'unicorn' as never }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('refuses avatars outside the agent prefix, missing, or not images', async () => {
    const files = memoryFiles();
    setPorts({ files });
    const { asha, vic } = await people('asha', 'vic');
    const agentId = 'ag_' + 'Qz' + Math.random().toString(36).slice(2, 12).padEnd(10, 'y') + 'Zz12';
    const theirs = storage.agentAvatar(vic.uid, agentId, 1);
    files.put(theirs, 10, 'image/png');
    await expect(
      call(asha, 'agentCreate', { agentId, name: 'x', avatarPath: theirs }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      call(asha, 'agentCreate', {
        agentId,
        name: 'x',
        avatarPath: storage.agentAvatar(asha.uid, agentId, 9),
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    const html = storage.agentAvatar(asha.uid, agentId, 2);
    files.put(html, 10, 'text/html');
    await expect(
      call(asha, 'agentCreate', { agentId, name: 'x', avatarPath: html }),
    ).rejects.toMatchObject({ code: 'invalid' });
    // Without a chosen id there is no prefix to upload to.
    await expect(
      call(asha, 'agentCreate', { name: 'x', avatarPath: storage.avatar(asha.uid, 1) }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('boardAgentSet', () => {
  it('the owning admin adds it directly: access + members/{agentId}, never a reader', async () => {
    const { asha, priya } = await people('asha', 'priya');
    const b = await seedBoard({ admin: asha, editors: [priya] });
    const agent = await makeAgent(asha, {
      boardId: b.id,
      role: 'commenter',
      description: 'one line',
      icon: 'terminal',
    });

    const board = await boardDoc(b.id);
    expect(board.access[agent.id]).toBe('commenter');
    expect(board.readerUids).not.toContain(agent.id);
    expect(board.editorUids).not.toContain(agent.id);
    expect(await memberDoc(b.id, agent.id)).toMatchObject({
      kind: 'agent',
      uid: agent.id,
      role: 'commenter',
      stageGrant: null,
      name: 'Builder',
      email: '',
      invitedBy: null,
      ownerUid: asha.uid,
      addedBy: asha.uid,
      description: 'one line',
      icon: 'terminal',
    });
  });

  it('only its owner may add it; an editor may not touch agents at all', async () => {
    const { asha, ravi, priya } = await people('asha', 'ravi', 'priya');
    const b = await seedBoard({ admin: asha, editors: [priya] });
    // ravi is an admin too, but the agent is his, and priya is only an editor.
    const { addMember } = await import('../tickets/helpers.js');
    await addMember(b.id, ravi, 'admin');
    const ashas = await makeAgent(asha);
    await expect(
      call(ravi, 'boardAgentSet', { boardId: b.id, agentId: ashas.id, role: 'editor' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const pri = await makeAgent(priya);
    await expect(
      call(priya, 'boardAgentSet', { boardId: b.id, agentId: pri.id, role: 'editor' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Never admin: the schema has no such agent role.
    await expect(
      call(asha, 'boardAgentSet', { boardId: b.id, agentId: ashas.id, role: 'admin' as 'editor' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('any admin re-roles it, sets a commenter grant, and removes it', async () => {
    const { asha, ravi } = await people('asha', 'ravi');
    const b = await seedBoard({ admin: asha });
    const { addMember } = await import('../tickets/helpers.js');
    await addMember(b.id, ravi, 'admin');
    const agent = await makeAgent(asha, { boardId: b.id, role: 'editor' });

    await call(ravi, 'boardAgentSet', {
      boardId: b.id,
      agentId: agent.id,
      role: 'commenter',
      stageGrant: { stages: [STAGES.todo, STAGES.doing] },
    });
    expect((await boardDoc(b.id)).stageGrants[agent.id]).toEqual({
      stages: [STAGES.todo, STAGES.doing],
    });
    expect(await memberDoc(b.id, agent.id)).toMatchObject({
      role: 'commenter',
      stageGrant: { stages: [STAGES.todo, STAGES.doing] },
    });
    await expect(
      call(ravi, 'boardAgentSet', {
        boardId: b.id,
        agentId: agent.id,
        role: 'commenter',
        stageGrant: { stages: ['st_nope'] },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    // Becoming a viewer drops the grant.
    await call(ravi, 'boardAgentSet', { boardId: b.id, agentId: agent.id, role: 'viewer' });
    expect((await boardDoc(b.id)).stageGrants[agent.id]).toBeUndefined();

    await call(ravi, 'boardAgentSet', { boardId: b.id, agentId: agent.id, role: null });
    expect((await boardDoc(b.id)).access[agent.id]).toBeUndefined();
    expect(await memberDoc(b.id, agent.id)).toBeUndefined();
    // Removing twice is fine.
    await call(ravi, 'boardAgentSet', { boardId: b.id, agentId: agent.id, role: null });
  });

  it('removal takes it off assignees and watchers (messages stay) and revokes its tokens for this board', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const other = await seedBoard({ admin: asha });
    const agent = await makeAgent(asha, { boardId: b.id, role: 'editor' });
    await call(asha, 'boardAgentSet', { boardId: other.id, agentId: agent.id, role: 'viewer' });
    const here = await seedAgentToken(asha, agent, b.id);
    const there = await seedAgentToken(asha, agent, other.id);

    const { ticketId } = await call(asha, 'ticketCreate', {
      boardId: b.id,
      title: 'x',
      assigneeUids: [agent.id],
    });
    const { messageId } = await asAgent(agent, 'messagePost', {
      boardId: b.id,
      ticketId,
      body: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
      },
      clientId: 'agentmsg1',
    });
    expect((await getDocData<Ticket>(paths.ticket(b.id, ticketId)))!.watcherUids).toContain(
      agent.id,
    );

    await call(asha, 'boardAgentSet', { boardId: b.id, agentId: agent.id, role: null });
    const t = (await getDocData<Ticket>(paths.ticket(b.id, ticketId)))!;
    expect(t.assigneeUids).toEqual([]);
    expect(t.watcherUids).not.toContain(agent.id);
    expect(await msgOf(b.id, ticketId, messageId)).toBeDefined();
    expect(await apiKeyOf(asha, here)).toMatchObject({ revokedReason: 'agentRemoved' });
    expect((await apiKeyOf(asha, here)).revokedAt).not.toBeNull();
    expect((await apiKeyOf(asha, there)).revokedAt).toBeNull();
  });

  it('refuses an archived agent and an archived board', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const agent = await makeAgent(asha);
    await call(asha, 'agentArchive', { agentId: agent.id });
    await expect(
      call(asha, 'boardAgentSet', { boardId: b.id, agentId: agent.id, role: 'editor' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const b2 = await seedBoard({ admin: asha, patch: { archivedAt: 1 } });
    const a2 = await makeAgent(asha);
    await expect(
      call(asha, 'boardAgentSet', { boardId: b2.id, agentId: a2.id, role: 'editor' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('boardAccessSet will not manage agents', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const agent = await makeAgent(asha, { boardId: b.id });
    await expect(
      call(asha, 'boardAccessSet', { boardId: b.id, people: { [agent.id]: 'admin' } }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a person removed from the board loses their tokens for it (ownerLeft)', async () => {
    const { asha, priya } = await people('asha', 'priya');
    const b = await seedBoard({ admin: asha, editors: [priya] });
    const agent = await makeAgent(priya);
    const k = await seedAgentToken(priya, agent, b.id, 'user');
    await call(asha, 'boardAccessSet', { boardId: b.id, people: { [priya.uid]: null } });
    expect(await apiKeyOf(priya, k)).toMatchObject({ revokedReason: 'ownerLeft' });
  });
});

describe('agentUpdate', () => {
  it('copies name / picture / description to every board, deletes the old picture', async () => {
    const files = memoryFiles();
    setPorts({ files });
    const { asha } = await people('asha');
    const b1 = await seedBoard({ admin: asha });
    const b2 = await seedBoard({ admin: asha });
    const agent = await makeAgent(asha, { boardId: b1.id });
    await call(asha, 'boardAgentSet', { boardId: b2.id, agentId: agent.id, role: 'viewer' });

    const p1 = storage.agentAvatar(asha.uid, agent.id, 1);
    const p2 = storage.agentAvatar(asha.uid, agent.id, 2);
    files.put(p1, 100, 'image/webp');
    files.put(p2, 100, 'image/webp');
    await call(asha, 'agentUpdate', { agentId: agent.id, avatarPath: p1 });
    await call(asha, 'agentUpdate', {
      agentId: agent.id,
      name: 'Reviewer',
      avatarPath: p2,
      description: 'Reviews',
      systemPrompt: 'new prompt',
    });
    expect(files.has(p1)).toBe(false);
    expect(await agentDoc(agent.id)).toMatchObject({
      name: 'Reviewer',
      avatarPath: p2,
      description: 'Reviews',
      systemPrompt: 'new prompt',
    });
    for (const b of [b1, b2])
      expect(await memberDoc(b.id, agent.id)).toMatchObject({
        name: 'Reviewer',
        avatarPath: p2,
        description: 'Reviews',
      });
  });

  it('icon: set, copied to every board, cleared with null; the picture stays', async () => {
    const files = memoryFiles();
    setPorts({ files });
    const { asha } = await people('asha');
    const b1 = await seedBoard({ admin: asha });
    const b2 = await seedBoard({ admin: asha });
    const agent = await makeAgent(asha, { boardId: b1.id });
    await call(asha, 'boardAgentSet', { boardId: b2.id, agentId: agent.id, role: 'viewer' });
    const pic = storage.agentAvatar(asha.uid, agent.id, 1);
    files.put(pic, 100, 'image/webp');
    await call(asha, 'agentUpdate', { agentId: agent.id, avatarPath: pic });

    await call(asha, 'agentUpdate', { agentId: agent.id, icon: 'gemini' });
    expect(await agentDoc(agent.id)).toMatchObject({ icon: 'gemini', avatarPath: pic });
    for (const b of [b1, b2])
      expect(await memberDoc(b.id, agent.id)).toMatchObject({ icon: 'gemini', avatarPath: pic });
    expect(files.has(pic)).toBe(true);

    await expect(
      call(asha, 'agentUpdate', { agentId: agent.id, icon: 'unicorn' as never }),
    ).rejects.toMatchObject({ code: 'invalid' });

    await call(asha, 'agentUpdate', { agentId: agent.id, icon: null });
    expect((await agentDoc(agent.id)).icon).toBeNull();
    for (const b of [b1, b2]) expect((await memberDoc(b.id, agent.id))?.icon).toBeNull();
  });

  it('archived → 409; someone else’s → 404', async () => {
    const { asha, vic } = await people('asha', 'vic');
    const agent = await makeAgent(asha);
    await expect(call(vic, 'agentArchive', { agentId: agent.id })).rejects.toMatchObject({
      code: 'not_found',
    });
    await call(asha, 'agentArchive', { agentId: agent.id });
    await expect(call(asha, 'agentUpdate', { agentId: agent.id, name: 'x' })).rejects.toMatchObject(
      {
        code: 'conflict',
      },
    );
  });
});

describe('agentArchive', () => {
  it('takes it off every board and revokes every token; restore brings back neither', async () => {
    const { asha } = await people('asha');
    const b1 = await seedBoard({ admin: asha });
    const b2 = await seedBoard({ admin: asha });
    const agent = await makeAgent(asha, { boardId: b1.id });
    await call(asha, 'boardAgentSet', { boardId: b2.id, agentId: agent.id, role: 'commenter' });
    const k1 = await seedAgentToken(asha, agent, b1.id);
    const k2 = await seedAgentToken(asha, agent, b2.id);
    const { ticketId } = await call(asha, 'ticketCreate', {
      boardId: b1.id,
      title: 'x',
      assigneeUids: [agent.id],
    });

    const r = await call(asha, 'agentArchive', { agentId: agent.id });
    expect(r).toEqual({ ok: true, boardsLeft: 2, tokensRevoked: 2 });
    expect((await agentDoc(agent.id)).archivedAt).not.toBeNull();
    for (const b of [b1, b2]) {
      expect((await boardDoc(b.id)).access[agent.id]).toBeUndefined();
      expect(await memberDoc(b.id, agent.id)).toBeUndefined();
    }
    expect((await getDocData<Ticket>(paths.ticket(b1.id, ticketId)))!.assigneeUids).toEqual([]);
    for (const k of [k1, k2])
      expect(await apiKeyOf(asha, k)).toMatchObject({ revokedReason: 'agentArchived' });

    // Archiving again is a no-op.
    expect(await call(asha, 'agentArchive', { agentId: agent.id })).toEqual({
      ok: true,
      boardsLeft: 0,
      tokensRevoked: 0,
    });
    await call(asha, 'agentArchive', { agentId: agent.id, action: 'restore' });
    expect((await agentDoc(agent.id)).archivedAt).toBeNull();
    expect((await boardDoc(b1.id)).access[agent.id]).toBeUndefined();
    expect((await apiKeyOf(asha, k1)).revokedAt).not.toBeNull();
  });
});

describe('agentInboxAck', () => {
  async function seedEvents(agentId: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = agentEventId(1_700_000_000_000 + i, `e${i}`);
      const ev: AgentInboxEvent = {
        type: 'comment',
        boardId: 'b',
        ticketId: 't',
        ticketKey: 'ENG-1',
        actor: null,
        summary: 's',
        createdAt: 1_700_000_000_000 + i,
        ackedAt: null,
      };
      await db().doc(paths.agentEvent(agentId, id)).set(ev);
      ids.push(id);
    }
    return ids;
  }
  const acked = async (agentId: string, id: string) =>
    (await getDocData<AgentInboxEvent>(paths.agentEvent(agentId, id)))!.ackedAt;

  it('the agent’s token acks by ids (twice is ok) and up to a cursor', async () => {
    const { asha } = await people('asha');
    const agent = await makeAgent(asha);
    const ids = await seedEvents(agent.id, 5);

    expect(
      await asAgent(agent, 'agentInboxAck', { agentId: agent.id, ids: [ids[0]!, 'nope'] }),
    ).toEqual({
      ok: true,
      acked: 1,
    });
    expect(await asAgent(agent, 'agentInboxAck', { agentId: agent.id, ids: [ids[0]!] })).toEqual({
      ok: true,
      acked: 0,
    });
    expect(await asAgent(agent, 'agentInboxAck', { agentId: agent.id, upTo: ids[2]! })).toEqual({
      ok: true,
      acked: 2,
    });
    expect(await acked(agent.id, ids[2]!)).not.toBeNull();
    expect(await acked(agent.id, ids[3]!)).toBeNull();
    // The owner may ack from the app.
    expect(await call(asha, 'agentInboxAck', { agentId: agent.id, upTo: ids[4]! })).toEqual({
      ok: true,
      acked: 2,
    });
  });

  it('another agent → 403; a person who does not own it → 404; a token without events:read → 403', async () => {
    const { asha, vic } = await people('asha', 'vic');
    const agent = await makeAgent(asha);
    const other = await makeAgent(asha, { name: 'Other' });
    const ids = await seedEvents(agent.id, 1);
    await expect(asAgent(other, 'agentInboxAck', { agentId: agent.id, ids })).rejects.toMatchObject(
      { code: 'forbidden' },
    );
    await expect(call(vic, 'agentInboxAck', { agentId: agent.id, ids })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      asAgent(agent, 'agentInboxAck', { agentId: agent.id, ids }, { scopes: ['comments:write'] }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('agent commands are app-only: a token cannot create or archive agents', async () => {
    const { asha } = await people('asha');
    const agent = await makeAgent(asha);
    await expect(asAgent(agent, 'agentCreate', { name: 'Sneaky' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      asAgent(agent, 'boardAgentSet', { boardId: 'b', agentId: agent.id, role: null }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
