/**
 * The agent inbox (agents.html §D) end to end: commands → notify() → agentInbox/{agentId}/events.
 * Agents get events for tickets they are assigned to or watch and for mentions;
 * never push / email / WhatsApp; never for their own actions.
 */
import { describe, expect, it } from 'vitest';
import { paths, type AgentInboxEvent } from '@tm/shared';
import { agentRecipients, agentEventType } from '../../src/agents/inbox.js';
import { pruneAgentEvents } from '../../src/notify/housekeeping.js';
import { db } from '../../src/runtime/firebase.js';
import { call, queue, setupEmulators } from '../harness/index.js';
import { asAgent, makeAgent } from '../agents/helpers.js';
import { doc, people, seedBoard, STAGES } from '../tickets/helpers.js';

setupEmulators();

async function events(agentId: string): Promise<(AgentInboxEvent & { id: string })[]> {
  const s = await db().collection(paths.agentEvents(agentId)).orderBy('__name__').get();
  return s.docs.map((d) => ({ id: d.id, ...(d.data() as AgentInboxEvent) }));
}

describe('agentRecipients (pure)', () => {
  const access = {
    u1: 'admin',
    ag_AAAAAAAAAAAAAAAA: 'editor',
    ag_BBBBBBBBBBBBBBBB: 'viewer',
  } as const;
  const A = 'ag_AAAAAAAAAAAAAAAA';
  const B = 'ag_BBBBBBBBBBBBBBBB';
  const OFF = 'ag_CCCCCCCCCCCCCCCC';
  const ticket = { assigneeUids: [A, 'u1'], watcherUids: [B, OFF] };

  it('ticket events reach assigned + watching agents on the board, never the actor', () => {
    expect(agentRecipients({ event: 'comment', actor: 'u1', ticket, access })).toEqual([A, B]);
    expect(agentRecipients({ event: 'stage', actor: A, ticket, access })).toEqual([B]);
    expect(
      agentRecipients({ event: 'updated', actor: 'u1', ticket, access, exclude: [B] }),
    ).toEqual([A]);
  });
  it('assigned / mentioned are explicit; due dates and invites never reach agents', () => {
    expect(
      agentRecipients({ event: 'assigned', actor: 'u1', ticket, access, recipients: [B, 'u1'] }),
    ).toEqual([B]);
    expect(agentRecipients({ event: 'assigned', actor: 'u1', ticket, access })).toEqual([]);
    expect(
      agentRecipients({ event: 'mentioned', actor: 'u1', ticket, access, mentioned: [OFF, A] }),
    ).toEqual([A]);
    expect(agentRecipients({ event: 'dueSoon', actor: 'system', ticket, access })).toEqual([]);
    expect(agentEventType('state')).toBe('updated');
    expect(agentEventType('invited')).toBeNull();
  });
});

describe('agent inbox through the commands', () => {
  it('assigned, comment, mentioned, stage, updated, unassigned — and nothing for its own actions', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const agent = await makeAgent(asha, { boardId: b.id, role: 'editor' });
    const { ticketId, key } = await call(asha, 'ticketCreate', {
      boardId: b.id,
      title: 'Build it',
      assigneeUids: [agent.id],
    });
    let ev = await events(agent.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      type: 'assigned',
      boardId: b.id,
      ticketId,
      ticketKey: key,
      actor: asha.uid,
      ackedAt: null,
    });
    expect(ev[0]!.summary).toContain('assigned you');
    expect(ev[0]!.summary).toContain(key);

    // A comment on a ticket it is assigned to.
    const { messageId } = (await call(asha, 'messagePost', {
      boardId: b.id,
      ticketId,
      body: doc('please start'),
      clientId: 'inbox-c1',
    })) as { messageId: string };
    ev = await events(agent.id);
    expect(ev.at(-1)).toMatchObject({ type: 'comment', messageId });

    // A mention is one event, not a mention AND a comment.
    const m2 = (await call(asha, 'messagePost', {
      boardId: b.id,
      ticketId,
      body: doc('hey ', { uid: agent.id }),
      clientId: 'inbox-c2',
    })) as { messageId: string };
    ev = await events(agent.id);
    expect(ev.slice(2).map((e) => [e.type, e.messageId])).toEqual([['mentioned', m2.messageId]]);

    await call(asha, 'ticketUpdate', { boardId: b.id, ticketId, patch: { stageId: STAGES.doing } });
    await call(asha, 'ticketUpdate', {
      boardId: b.id,
      ticketId,
      patch: { title: 'Build it well' },
    });
    ev = await events(agent.id);
    expect(ev.slice(3).map((e) => e.type)).toEqual(['stage', 'updated']);
    expect(ev[3]!.summary).toContain('Doing');

    // Its own actions: nothing.
    const before = (await events(agent.id)).length;
    await asAgent(agent, 'messagePost', {
      boardId: b.id,
      ticketId,
      body: doc('on it'),
      clientId: 'inbox-own',
    });
    await asAgent(agent, 'ticketUpdate', {
      boardId: b.id,
      ticketId,
      patch: { stageId: STAGES.review },
    });
    expect((await events(agent.id)).length).toBe(before);

    // Taken off the ticket → 'unassigned' (it still watches, having commented).
    await call(asha, 'ticketUpdate', { boardId: b.id, ticketId, patch: { assigneeUids: [] } });
    ev = await events(agent.id);
    expect(ev.at(-1)).toMatchObject({ type: 'unassigned', actor: asha.uid });

    // Never push / email / WhatsApp for an agent.
    const deliver = queue()
      .history()
      .filter((t) => t.queue === 'deliver')
      .map((t) => (t.payload as { uid: string }).uid);
    expect(deliver).not.toContain(agent.id);
    // Ids sort by time: the feed order is the id order.
    const ids = ev.map((e) => e.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it('agents on other boards, or not involved in the ticket, hear nothing', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const idle = await makeAgent(asha, { boardId: b.id, name: 'Idle' });
    const away = await makeAgent(asha, { name: 'Away' });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'x' });
    await call(asha, 'messagePost', {
      boardId: b.id,
      ticketId,
      body: doc('hello ', { uid: away.id }),
      clientId: 'x1',
    });
    await call(asha, 'ticketUpdate', { boardId: b.id, ticketId, patch: { stageId: STAGES.doing } });
    expect(await events(idle.id)).toEqual([]);
    expect(await events(away.id)).toEqual([]);
  });

  it('an agent watching (not assigned) gets comments; another agent’s action is an event', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const watcher = await makeAgent(asha, { boardId: b.id, name: 'Watcher' });
    const worker = await makeAgent(asha, { boardId: b.id, name: 'Worker' });
    const { ticketId } = await call(asha, 'ticketCreate', { boardId: b.id, title: 'x' });
    await asAgent(watcher, 'ticketWatch', { boardId: b.id, ticketId, watching: true });
    const { messageId } = await asAgent(worker, 'messagePost', {
      boardId: b.id,
      ticketId,
      body: doc('done'),
      clientId: 'w1',
    });
    const ev = await events(watcher.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'comment', actor: worker.id, messageId });
    expect(ev[0]!.summary.startsWith('Worker ')).toBe(true);
  });

  it('bulk: one assigned event per agent; state changes arrive as updated', async () => {
    const { asha } = await people('asha');
    const b = await seedBoard({ admin: asha });
    const agent = await makeAgent(asha, { boardId: b.id });
    const t1 = await call(asha, 'ticketCreate', { boardId: b.id, title: '1' });
    const t2 = await call(asha, 'ticketCreate', { boardId: b.id, title: '2' });
    await call(asha, 'ticketBulk', {
      boardId: b.id,
      ticketIds: [t1.ticketId, t2.ticketId],
      action: { type: 'addAssignee', uid: agent.id },
    });
    let ev = await events(agent.id);
    expect(ev.map((e) => e.type)).toEqual(['assigned']);
    expect(ev[0]!.summary).toContain('2 tickets');
    await call(asha, 'ticketState', { boardId: b.id, ticketId: t1.ticketId, state: 'archived' });
    ev = await events(agent.id);
    expect(ev.at(-1)).toMatchObject({ type: 'updated', ticketId: t1.ticketId });
  });

  it('housekeeping deletes events acked over 30 days ago, keeps unacked ones', async () => {
    const { asha } = await people('asha');
    const agent = await makeAgent(asha);
    const now = Date.now();
    const base = {
      type: 'comment',
      boardId: 'b',
      ticketId: 't',
      ticketKey: 'K-1',
      actor: null,
      summary: 's',
      createdAt: 1,
    } as const;
    await db()
      .doc(paths.agentEvent(agent.id, '000000001_old'))
      .set({ ...base, ackedAt: now - 31 * 86_400_000 });
    await db()
      .doc(paths.agentEvent(agent.id, '000000002_new'))
      .set({ ...base, ackedAt: now - 86_400_000 });
    await db()
      .doc(paths.agentEvent(agent.id, '000000003_open'))
      .set({ ...base, ackedAt: null });
    expect(await pruneAgentEvents(now)).toBeGreaterThanOrEqual(1);
    expect((await events(agent.id)).map((e) => e.id)).toEqual(['000000002_new', '000000003_open']);
  });
});
