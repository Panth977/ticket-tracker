/**
 * Phase 3 §L1 — questions with options.
 *
 * An agent asks a form card; a person submits it; the card locks where it sits,
 * the answer shows as the person's reply bubble, the ticket stops waiting and
 * the agent hears question_answered with the values.
 */
import { describe, expect, it } from 'vitest';
import { paths, questionId, type Message } from '@tm/shared';
import { db } from '../../src/runtime/firebase.js';
import { expireQuestions } from '../../src/tickets/questions.js';
import { call, setupEmulators } from '../harness/index.js';
import { asAgent } from '../agents/helpers.js';
import { doc, people, spyPorts } from '../tickets/helpers.js';
import { msgOf, patchMessage } from '../tickets/store.js';
import { seedUser } from '../notify/_seed.js';
import { inboxOf, messageOf, messagesOf, scene, waitingOnOf } from './helpers.js';

setupEmulators();

const FIELDS = [
  {
    id: 'f_db',
    label: 'Database',
    type: 'single' as const,
    options: [
      { id: 'o_pg', label: 'Postgres' },
      { id: 'o_my', label: 'MySQL' },
    ],
    required: true,
  },
  { id: 'f_why', label: 'Why', type: 'text' as const },
];

describe('questionAsk', () => {
  it('an agent asks a blocking question; the ticket waits and the people are told', async () => {
    const s = spyPorts();
    const { asha, priya } = await people('asha', 'priya');
    const sc = await scene(asha, { editors: [priya], assignees: [priya.uid] });

    const { messageId, questionId: qid } = await asAgent(
      sc.agent,
      'questionAsk',
      {
        boardId: sc.boardId,
        ticketId: sc.ticketId,
        title: 'Which database should the report use?',
        fields: FIELDS,
        allowComment: true,
        clientId: 'q-1',
      },
      { keyName: 'orch-eng-builder' },
    );
    expect(messageId).toBe('q-1');
    expect(qid).toBe(questionId(sc.ticketId, 'q-1'));

    const m = await messageOf(sc.boardId, sc.ticketId, messageId);
    expect(m.kind).toBe('question');
    expect(m.authorUid).toBe(sc.agent.id);
    expect(m.viaToken).toBe('orch-eng-builder');
    // The title is in body.text, so search and the notification line read it.
    expect(m.body.text).toContain('Which database');
    expect(m.question).toMatchObject({
      status: 'open',
      blocking: true,
      allowComment: true,
      to: null,
    });

    // §L1: the ticket shows 'Waiting for your answer'.
    expect(await waitingOnOf(sc.boardId, sc.ticketId)).toMatchObject({
      count: 1,
      messageId,
      title: 'Which database should the report use?',
      askedBy: sc.agent.id,
    });

    // Told through their normal channels: no `to`, so assignees + watchers.
    const asked = s.notified.find((n) => n.event === 'question');
    expect(asked?.extra?.recipients).toEqual(expect.arrayContaining([priya.uid, asha.uid]));
    expect(asked?.extra?.recipients).not.toContain(sc.agent.id);
  });

  it('`to` must be on the board, and a past expiry is rejected', async () => {
    spyPorts();
    const { asha, zed } = await people('asha', 'zed');
    const sc = await scene(asha);
    await expect(
      asAgent(sc.agent, 'questionAsk', {
        boardId: sc.boardId,
        ticketId: sc.ticketId,
        title: 'Who?',
        fields: [{ id: 'f', label: 'Pick', type: 'text' }],
        to: [zed.uid],
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      asAgent(sc.agent, 'questionAsk', {
        boardId: sc.boardId,
        ticketId: sc.ticketId,
        title: 'Soon?',
        fields: [{ id: 'f', label: 'Pick', type: 'text' }],
        expiresAt: 1,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a viewer may not ask', async () => {
    spyPorts();
    const { asha, vic } = await people('asha', 'vic');
    const sc = await scene(asha, { viewers: [vic] });
    await expect(
      call(vic, 'questionAsk', {
        boardId: sc.boardId,
        ticketId: sc.ticketId,
        title: 'May I?',
        fields: [{ id: 'f', label: 'Pick', type: 'text' }],
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('questionAnswer', () => {
  it('locks the card, posts the reply bubble and tells the agent the values', async () => {
    spyPorts();
    const { asha, priya } = await people('asha', 'priya');
    const sc = await scene(asha, { editors: [priya] });
    const { messageId } = await asAgent(sc.agent, 'questionAsk', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      title: 'Which database?',
      fields: FIELDS,
      allowComment: true,
      clientId: 'q-2',
    });

    await call(priya, 'questionAnswer', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      messageId,
      values: { f_db: 'o_pg', f_why: 'we already run it' },
      comment: 'ping me if that is wrong',
    });

    const card = await messageOf(sc.boardId, sc.ticketId, messageId);
    expect(card.question).toMatchObject({
      status: 'answered',
      answer: {
        values: { f_db: 'o_pg', f_why: 'we already run it' },
        comment: 'ping me if that is wrong',
        by: priya.uid,
      },
    });
    // The answer also appears as the person's reply bubble.
    const reply = (await messagesOf(sc.boardId, sc.ticketId)).find(
      (m) => m.replyTo === messageId,
    ) as Message;
    expect(reply.authorUid).toBe(priya.uid);
    expect(reply.body.text).toContain('Database: Postgres');
    expect(reply.body.text).toContain('ping me if that is wrong');

    // Nothing waits any more.
    expect(await waitingOnOf(sc.boardId, sc.ticketId)).toBeNull();

    // The agent hears it, with the values.
    const events = await inboxOf(sc.agent.id);
    const answered = events.find((e) => e.type === 'question_answered')!;
    expect(answered.question).toMatchObject({
      id: questionId(sc.ticketId, messageId),
      status: 'answered',
      values: { f_db: 'o_pg' },
      answeredBy: priya.uid,
    });
    expect(answered.messageId).toBe(messageId);
  });

  it('checks the values, the audience and the status', async () => {
    spyPorts();
    const { asha, priya, otto } = await people('asha', 'priya', 'otto');
    const sc = await scene(asha, { editors: [priya, otto] });
    const { messageId } = await asAgent(sc.agent, 'questionAsk', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      title: 'Which database?',
      fields: FIELDS,
      to: [priya.uid],
      clientId: 'q-3',
    });
    const base = { boardId: sc.boardId, ticketId: sc.ticketId, messageId };

    // Not in `to`.
    await expect(
      call(otto, 'questionAnswer', { ...base, values: { f_db: 'o_pg' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // An option that is not on the field, and a missing required field.
    await expect(
      call(priya, 'questionAnswer', { ...base, values: { f_db: 'o_nope' } }),
    ).rejects.toMatchObject({ code: 'unprocessable' });
    await expect(
      call(priya, 'questionAnswer', { ...base, values: { f_why: 'because' } }),
    ).rejects.toMatchObject({ code: 'unprocessable' });
    // A comment the question never asked for.
    await expect(
      call(priya, 'questionAnswer', { ...base, values: { f_db: 'o_pg' }, comment: 'hi' }),
    ).rejects.toMatchObject({ code: 'unprocessable' });
    // An agent never answers, even its own question.
    await expect(
      asAgent(sc.agent, 'questionAnswer', { ...base, values: { f_db: 'o_pg' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await call(priya, 'questionAnswer', { ...base, values: { f_db: 'o_my' } });
    // Twice is a conflict.
    await expect(
      call(priya, 'questionAnswer', { ...base, values: { f_db: 'o_pg' } }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('questionCancel and expiry', () => {
  it('the asker cancels silently; an admin cancelling tells the agent', async () => {
    spyPorts();
    const { asha, priya } = await people('asha', 'priya');
    const sc = await scene(asha, { editors: [priya] });
    const ask = (clientId: string) =>
      asAgent(sc.agent, 'questionAsk', {
        boardId: sc.boardId,
        ticketId: sc.ticketId,
        title: `Q ${clientId}`,
        fields: [{ id: 'f', label: 'Pick', type: 'text' }],
        clientId,
      });

    const a = await ask('q-a');
    const b = await ask('q-b');
    expect(await waitingOnOf(sc.boardId, sc.ticketId)).toMatchObject({
      count: 2,
      messageId: a.messageId,
    });

    // The asker cancels its own: no inbox event for itself.
    await asAgent(sc.agent, 'questionCancel', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      messageId: a.messageId,
    });
    expect((await messageOf(sc.boardId, sc.ticketId, a.messageId)).question).toMatchObject({
      status: 'cancelled',
    });
    expect(await waitingOnOf(sc.boardId, sc.ticketId)).toMatchObject({
      count: 1,
      messageId: b.messageId,
    });
    expect(
      (await inboxOf(sc.agent.id)).filter((e) => e.type === 'question_cancelled'),
    ).toHaveLength(0);

    // An editor is neither the asker nor an admin.
    await expect(
      call(priya, 'questionCancel', {
        boardId: sc.boardId,
        ticketId: sc.ticketId,
        messageId: b.messageId,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // The board admin may, and then the agent hears about it.
    await call(asha, 'questionCancel', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      messageId: b.messageId,
    });
    expect(await waitingOnOf(sc.boardId, sc.ticketId)).toBeNull();
    const cancelled = (await inboxOf(sc.agent.id)).find((e) => e.type === 'question_cancelled')!;
    expect(cancelled.question).toMatchObject({ status: 'cancelled' });

    // Cancelling again is a conflict.
    await expect(
      call(asha, 'questionCancel', {
        boardId: sc.boardId,
        ticketId: sc.ticketId,
        messageId: b.messageId,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('an expired question cannot be answered, and the sweep locks it', async () => {
    spyPorts();
    const { asha, priya } = await people('asha', 'priya');
    const sc = await scene(asha, { editors: [priya] });
    const { messageId } = await asAgent(sc.agent, 'questionAsk', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      title: 'Still relevant?',
      fields: [{ id: 'f', label: 'Pick', type: 'text' }],
      expiresAt: Date.now() + 60_000,
      clientId: 'q-exp',
    });
    // Move the expiry into the past, the way time does.
    const past = Date.now() - 1000;
    const card = (await msgOf(sc.boardId, sc.ticketId, messageId))!;
    await patchMessage(sc.boardId, sc.ticketId, messageId, {
      question: { ...card.question!, expiresAt: past },
    });

    await expect(
      call(priya, 'questionAnswer', {
        boardId: sc.boardId,
        ticketId: sc.ticketId,
        messageId,
        values: { f: 'yes' },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const expired = await expireQuestions(Date.now());
    expect(expired.some((e) => e.messageId === messageId)).toBe(true);
    expect((await messageOf(sc.boardId, sc.ticketId, messageId)).question?.status).toBe('expired');
    expect(await waitingOnOf(sc.boardId, sc.ticketId)).toBeNull();
  });

  it('a question with a #ref in its context still writes the backlink', async () => {
    spyPorts();
    const { asha } = await people('asha');
    const sc = await scene(asha);
    const other = await call(asha, 'ticketCreate', { boardId: sc.boardId, title: 'Other' });
    const { messageId } = await asAgent(sc.agent, 'questionAsk', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      title: 'Same as this one?',
      body: doc('see ', { ticketId: other.ticketId }),
      fields: [{ id: 'f', label: 'Pick', type: 'text' }],
      blocking: false,
      clientId: 'q-ref',
    });
    const m = await messageOf(sc.boardId, sc.ticketId, messageId);
    expect(m.question?.body?.refs).toEqual([other.ticketId]);
    // Not blocking → nothing waits.
    expect(await waitingOnOf(sc.boardId, sc.ticketId)).toBeNull();
    const target = await db().doc(paths.ticket(sc.boardId, other.ticketId)).get();
    expect((target.data() as { referencedBy: string[] }).referencedBy).toContain(sc.ticketId);
  });
});

describe('§L1 notifications', () => {
  it('a question reaches the people it names, whatever their board mode', async () => {
    // No spyPorts(): the real router runs, so the inbox row is the proof.
    // (createUser only makes the Auth account; the users/ doc normally comes
    // from the onUserCreated trigger, which emulators:exec does not run here.)
    const { asha, priya } = await people('asha', 'priya');
    await seedUser({ uid: priya.uid });
    const sc = await scene(asha, { editors: [priya] });
    // Priya has muted this board — a question still gets through (§L1: she is
    // named, and an agent is blocked until she answers).
    await call(priya, 'boardPrefSet', { boardId: sc.boardId, pref: { mode: 'muted' } });

    const { messageId } = await asAgent(sc.agent, 'questionAsk', {
      boardId: sc.boardId,
      ticketId: sc.ticketId,
      title: 'Which database?',
      fields: FIELDS,
      to: [priya.uid],
      clientId: 'q-notify',
    });

    const rows = await db().collection(paths.inbox(priya.uid)).get();
    const row = rows.docs
      .map((d) => d.data() as { event: string; summary: string; messageId?: string })
      .find((r) => r.event === 'question')!;
    expect(row.messageId).toBe(messageId);
    expect(row.summary).toContain('Which database');
  });
});
