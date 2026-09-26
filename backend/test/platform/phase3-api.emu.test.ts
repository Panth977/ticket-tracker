/**
 * Phase 3 through the doors (docs/plan/agents.html §L4): questions with
 * options, ticket task lists and the agent heartbeat over REST /v1 and MCP.
 *
 * The loop this file pins down is the one §L1 describes end to end:
 *   an agent token ASKS a question → a person ANSWERS it (the app's command)
 *   → the agent reads the answer from GET /v1/questions/{id} AND from its
 *   inbox feed, values and all, with no second call.
 *
 * Plus the two rules that make the rest work: a tool or route the token has
 * no scope for is hidden / refused, and a heartbeat writes ONE RTDB node
 * (docs/plan/agents.html §W) and nothing else — not the ticket, and since
 * phase 15 not Firestore at all.
 *
 * The COMMANDS behind these doors land in a parallel step (p3-backend), so
 * each group is skipped until its command file exists — exactly the pattern
 * agent-api.emu.test.ts uses for messagePost { fileIds }. Everything that can
 * be tested from seeded documents (the reads, the mappers, the scope gates)
 * runs either way.
 */
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import {
  agentStatusId,
  HEARTBEAT_STALE_MS,
  live as liveTree,
  paths,
  questionId,
  SCOPE_PRESETS,
  type LiveStatus,
  type Message,
  type Question,
  type Tasklist,
  type Ticket,
} from '@tm/shared';
import { createApp } from '../../src/http/app.js';
import { readStatus } from '../../src/platform/rtdbPaths.js';
import { db, rtdbAdmin } from '../../src/runtime/firebase.js';
import { call, setupEmulators } from '../harness/index.js';
import { people, seedBoard } from '../tickets/helpers.js';
import { listOf, msgOf, putTasklist } from '../tickets/store.js';
import { agentKeyFor, apiKeyFor, rest, seedAgent, seedAgentEvent } from './helpers.js';

setupEmulators();

/** A command that a parallel step owns: present = its door can be exercised. */
const landed = (name: string): boolean =>
  existsSync(new URL(`../../src/commands/${name}.ts`, import.meta.url));
const HAS_ASK = landed('questionAsk');
const HAS_ANSWER = landed('questionAnswer');
const HAS_CANCEL = landed('questionCancel');
const HAS_TASKLIST = landed('tasklistSet');
const HAS_ITEM = landed('tasklistItemUpdate');
const HAS_TASKLIST_DELETE = landed('tasklistDelete');
const HAS_HEARTBEAT = landed('agentHeartbeat');

/** owner (admin) + priya (editor), a board, an agent on it, and two tokens. */
async function stage(agentScopes = [...SCOPE_PRESETS.worker]) {
  const { owner, priya } = await people('owner', 'priya');
  const b = await seedBoard({ admin: owner, editors: [priya] });
  const { id: agentId } = await seedAgent(owner, {
    name: 'Builder',
    boardId: b.id,
    role: 'editor',
  });
  const { key: agentKey } = await agentKeyFor(owner, agentId, agentScopes, b.id);
  const { key: ownerKey } = await apiKeyFor(owner, [...SCOPE_PRESETS.everything], b.id);
  const t = (await rest(ownerKey, 'POST', '/v1/tickets', { title: 'Add CSV export' })).body as {
    key: string;
    id: string;
  };
  return { owner, priya, b, agentId, agentKey, ownerKey, t };
}

async function mcpClient(token: string): Promise<Client> {
  const app = await createApp();
  const client = new Client({ name: 'orchestrator', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: ((url: string | URL, init?: RequestInit) =>
      app.request(String(url), init)) as typeof fetch,
  });
  await client.connect(transport);
  return client;
}

const parsed = <T>(r: unknown): T =>
  JSON.parse((r as { content: { text: string }[] }).content[0]!.text) as T;

/** The two fields every question in this file asks for. */
const FIELDS = [
  {
    id: 'db',
    label: 'Which database should the report use?',
    type: 'single' as const,
    options: [
      { id: 'pg', label: 'Postgres' },
      { id: 'bq', label: 'BigQuery', description: 'costs per query' },
    ],
    required: true,
  },
  { id: 'why', label: 'Why?', type: 'text' as const },
];

// ─── scope gating (§L4): hidden, and refused if called anyway ────────────────

describe('phase-3 scopes shape both doors', () => {
  it('REST refuses every §L4 write without its scope, and MCP hides the tool', async () => {
    const { t, b, owner, agentId } = await stage();
    const { key: ro } = await agentKeyFor(owner, agentId, [...SCOPE_PRESETS.readOnly], b.id, 'ro');

    // questions:write / tasklists:write / status:write are all missing here.
    expect(
      (
        await rest(ro, 'POST', `/v1/tickets/${t.key}/questions`, {
          title: 'Which db?',
          fields: FIELDS,
        })
      ).status,
    ).toBe(403);
    expect(
      (await rest(ro, 'PUT', `/v1/tickets/${t.key}/tasklists/l1`, { title: 'Plan', items: [] }))
        .status,
    ).toBe(403);
    expect(
      (await rest(ro, 'PATCH', `/v1/tickets/${t.key}/tasklists/l1/items/i1`, { status: 'done' }))
        .status,
    ).toBe(403);
    expect((await rest(ro, 'DELETE', `/v1/tickets/${t.key}/tasklists/l1`)).status).toBe(403);
    expect((await rest(ro, 'POST', '/v1/heartbeat', { state: 'working' })).status).toBe(403);
    // Reading a question only needs comments:read, which a read-only token has.
    expect((await rest(ro, 'GET', `/v1/questions/${questionId('nosuch', 'nope')}`)).status).toBe(
      404,
    );

    const roClient = await mcpClient(ro);
    const roNames = (await roClient.listTools()).tools.map((x) => x.name);
    expect(roNames).toContain('get_question');
    for (const hidden of [
      'ask_question',
      'cancel_question',
      'set_tasklist',
      'update_task_item',
      'delete_tasklist',
      'heartbeat',
    ])
      expect(roNames).not.toContain(hidden);
    const refused = await roClient
      .callTool({ name: 'heartbeat', arguments: { state: 'working' } })
      .catch((e: Error) => ({ isError: true, e }));
    expect((refused as { isError?: boolean }).isError).toBe(true);
    await roClient.close();

    // A Worker token sees all seven (§L4).
    const { key: worker } = await agentKeyFor(
      owner,
      agentId,
      [...SCOPE_PRESETS.worker],
      b.id,
      'worker',
    );
    const wc = await mcpClient(worker);
    expect((await wc.listTools()).tools.map((x) => x.name)).toEqual(
      expect.arrayContaining([
        'ask_question',
        'get_question',
        'cancel_question',
        'set_tasklist',
        'update_task_item',
        'delete_tasklist',
        'heartbeat',
      ]),
    );
    await wc.close();
  });
});

// ─── questions (§L1) ─────────────────────────────────────────────────────────

describe.skipIf(!HAS_ASK)('questions over REST and MCP', () => {
  it('an agent asks; the card is in the thread; GET /v1/questions/{id} reads it back', async () => {
    const { priya, agentId, agentKey, t, b } = await stage();
    const asked = await rest(agentKey, 'POST', `/v1/tickets/${t.key}/questions`, {
      title: 'Which database should the report use?',
      body_markdown: 'Both are wired up already.',
      fields: FIELDS,
      allow_comment: true,
      to: [priya.email],
      blocking: true,
    });
    expect(asked.status).toBe(201);
    const q = asked.body as {
      id: string;
      message_id: string;
      status: string;
      to: { id: string }[];
      asked_by: { id: string; kind: string };
    };
    expect(q).toMatchObject({
      id: questionId(t.id, (asked.body as { message_id: string }).message_id),
      ticket_key: t.key,
      status: 'open',
      blocking: true,
      allow_comment: true,
      answer: null,
      asked_by: { id: agentId, kind: 'agent' },
    });
    expect(q.to).toEqual([expect.objectContaining({ id: priya.uid })]);
    expect((asked.body as { fields: { id: string }[] }).fields.map((f) => f.id)).toEqual([
      'db',
      'why',
    ]);
    expect(asked.headers.get('location')).toBe(`/v1/questions/${q.id}`);

    // The message it hangs on IS the card: the thread carries it.
    const thread = (await rest(agentKey, 'GET', `/v1/tickets/${t.key}/messages`)).body as {
      data: { id: string; kind: string; question?: { id: string; title: string } }[];
    };
    const card = thread.data.find((m) => m.kind === 'question');
    expect(card?.question).toMatchObject({
      id: q.id,
      title: 'Which database should the report use?',
    });
    const stored = (await msgOf(b.id, t.id, q.message_id)) as Message;
    expect(stored.kind).toBe('question');
    expect((stored.question as Question).status).toBe('open');

    // Read it back by id, over both doors.
    expect((await rest(agentKey, 'GET', `/v1/questions/${q.id}`)).body).toMatchObject({
      id: q.id,
      status: 'open',
    });
    const client = await mcpClient(agentKey);
    expect(
      parsed<{ id: string; status: string }>(
        await client.callTool({ name: 'get_question', arguments: { id: q.id } }),
      ),
    ).toMatchObject({
      id: q.id,
      status: 'open',
    });
    await client.close();

    // Unknown ids and questions on other boards are indistinguishable 404s.
    expect((await rest(agentKey, 'GET', `/v1/questions/${questionId(t.id, 'nope')}`)).status).toBe(
      404,
    );
    expect((await rest(agentKey, 'GET', '/v1/questions/not-an-id')).status).toBe(404);
  });

  it('a bad form is a 400 before anything is written', async () => {
    const { agentKey, t } = await stage();
    // 'single' with no options, and a question with no fields at all.
    expect(
      (
        await rest(agentKey, 'POST', `/v1/tickets/${t.key}/questions`, {
          title: 'x',
          fields: [{ id: 'a', label: 'A', type: 'single' }],
        })
      ).status,
    ).toBe(400);
    expect(
      (await rest(agentKey, 'POST', `/v1/tickets/${t.key}/questions`, { title: 'x', fields: [] }))
        .status,
    ).toBe(400);
    expect(
      (
        await rest(agentKey, 'POST', `/v1/tickets/${t.key}/questions`, {
          title: '',
          fields: FIELDS,
        })
      ).status,
    ).toBe(400);
  });

  it.skipIf(!HAS_ANSWER)('a person answers and the agent reads the values back', async () => {
    const { priya, agentKey, t, b } = await stage();
    const q = (
      await rest(agentKey, 'POST', `/v1/tickets/${t.key}/questions`, {
        title: 'Which db?',
        fields: FIELDS,
        allow_comment: true,
        to: [priya.email],
      })
    ).body as { id: string; message_id: string };

    await call(priya, 'questionAnswer', {
      boardId: b.id,
      ticketId: t.id,
      messageId: q.message_id,
      values: { db: 'bq', why: 'the report scans everything' },
      comment: 'ping me if that is wrong',
    });

    const after = (await rest(agentKey, 'GET', `/v1/questions/${q.id}`)).body as {
      status: string;
      answer: { values: Record<string, unknown>; comment: string | null; by: { id: string } };
    };
    expect(after.status).toBe('answered');
    expect(after.answer.values).toEqual({ db: 'bq', why: 'the report scans everything' });
    expect(after.answer.comment).toBe('ping me if that is wrong');
    expect(after.answer.by.id).toBe(priya.uid);
  });

  it.skipIf(!HAS_CANCEL)('the asker cancels its own question; the card locks', async () => {
    const { agentKey, t } = await stage();
    const q = (
      await rest(agentKey, 'POST', `/v1/tickets/${t.key}/questions`, {
        title: 'Which db?',
        fields: FIELDS,
      })
    ).body as { id: string };
    const cancelled = await rest(agentKey, 'POST', `/v1/questions/${q.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ id: q.id, status: 'cancelled' });
    // Cancelling twice is a conflict, not a second cancellation.
    expect((await rest(agentKey, 'POST', `/v1/questions/${q.id}/cancel`)).status).toBe(409);
  });
});

// ─── the inbox feed carries the answer (§L1, §L4) ────────────────────────────

describe('events: question_answered / question_cancelled carry the answer', () => {
  it('the feed exposes the question payload with its values', async () => {
    const { owner, priya, b, agentId } = await stage();
    const { key } = await agentKeyFor(owner, agentId, ['events:read'], b.id, 'ev');
    const id = questionId('tkt1', 'msg1');
    await seedAgentEvent(
      agentId,
      {
        boardId: b.id,
        ticketId: 'tkt1',
        ticketKey: `${b.key}-1`,
        type: 'question_answered',
        messageId: 'msg1',
        actor: priya.uid,
        summary: 'Priya answered "Which database should the report use?"',
        question: {
          id,
          title: 'Which database should the report use?',
          status: 'answered',
          values: { db: 'bq' },
          comment: 'BigQuery',
          answeredBy: priya.uid,
        },
      },
      Date.now() - 5_000,
    );
    await seedAgentEvent(
      agentId,
      {
        boardId: b.id,
        ticketId: 'tkt1',
        ticketKey: `${b.key}-1`,
        type: 'question_cancelled',
        messageId: 'msg2',
        actor: null,
        summary: 'The question expired',
        question: { id: questionId('tkt1', 'msg2'), title: 'Stale one', status: 'expired' },
      },
      Date.now() - 4_000,
    );

    const feed = (await rest(key, 'GET', '/v1/events')).body as {
      data: {
        type: string;
        question?: {
          id: string;
          status: string;
          values?: Record<string, unknown>;
          comment?: string | null;
          answered_by?: { id: string };
        };
      }[];
    };
    const answered = feed.data.find((e) => e.type === 'question_answered');
    expect(answered?.question).toMatchObject({
      id,
      status: 'answered',
      values: { db: 'bq' },
      comment: 'BigQuery',
    });
    expect(answered?.question?.answered_by?.id).toBe(priya.uid);
    const cancelled = feed.data.find((e) => e.type === 'question_cancelled');
    expect(cancelled?.question).toMatchObject({ status: 'expired' });
    expect(cancelled?.question?.values).toBeUndefined();
  });

  it.skipIf(!HAS_ASK || !HAS_ANSWER)(
    'end to end: the agent asks, a person answers, the agent reads it from get_events',
    async () => {
      const { priya, agentKey, t, b } = await stage();
      const client = await mcpClient(agentKey);
      const asked = parsed<{ id: string; message_id: string }>(
        await client.callTool({
          name: 'ask_question',
          arguments: {
            key: t.key,
            title: 'Which database should the report use?',
            fields: FIELDS,
            to: [priya.email],
            blocking: true,
          },
        }),
      );

      await call(priya, 'questionAnswer', {
        boardId: b.id,
        ticketId: t.id,
        messageId: asked.message_id,
        values: { db: 'pg', why: 'it is already there' },
      });

      const feed = parsed<{
        data: { type: string; question?: { id: string; values?: Record<string, unknown> } }[];
      }>(await client.callTool({ name: 'get_events', arguments: {} }));
      const e = feed.data.find((x) => x.type === 'question_answered');
      expect(e?.question?.id).toBe(asked.id);
      expect(e?.question?.values).toEqual({ db: 'pg', why: 'it is already there' });
      await client.close();
    },
  );
});

// ─── task lists (§L2) ────────────────────────────────────────────────────────

describe('task lists', () => {
  it('GET …/tasklists reads the stored lists, in position order, with progress', async () => {
    const { agentKey, agentId, t, b } = await stage();
    const now = Date.now();
    const list: Tasklist = {
      title: 'Plan: add CSV export',
      owner: agentId,
      items: [
        { id: 'i1', title: 'Read the code', status: 'done', updatedAt: now },
        { id: 'i2', title: 'Write it', status: 'doing', updatedAt: now },
        {
          id: 'i3',
          title: 'Old approach',
          status: 'skipped',
          note: 'covered by ENG-9',
          updatedAt: now,
        },
        { id: 'i4', title: 'Tests', status: 'todo', updatedAt: now },
      ],
      position: 0,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    // §W: task lists are rows on the ticket document.
    await putTasklist(b.id, t.id, { ...list, id: 'l1' });
    await putTasklist(b.id, t.id, { ...list, id: 'l2', title: 'Second', items: [], position: 1 });

    const got = (await rest(agentKey, 'GET', `/v1/tickets/${t.key}/tasklists`)).body as {
      data: {
        id: string;
        title: string;
        progress: { done: number; total: number };
        owner: { id: string; kind: string };
        items: { id: string; note: string | null }[];
      }[];
    };
    expect(got.data.map((l) => l.id)).toEqual(['l1', 'l2']);
    // 'done' in the bar is done + skipped: 2 of 4.
    expect(got.data[0]!.progress).toEqual({ done: 2, total: 4 });
    expect(got.data[0]!.owner).toMatchObject({ id: agentId, kind: 'agent' });
    expect(got.data[0]!.items.find((i) => i.id === 'i3')!.note).toBe('covered by ENG-9');
    expect(got.data[0]!.items.find((i) => i.id === 'i1')!.note).toBeNull();
  });

  it.skipIf(!HAS_TASKLIST)(
    'PUT creates or replaces the whole list; MCP set_tasklist does the same',
    async () => {
      const { agentKey, agentId, t, b } = await stage();
      const put = await rest(agentKey, 'PUT', `/v1/tickets/${t.key}/tasklists/plan`, {
        title: 'Plan: add CSV export',
        items: [
          { id: 'read', title: 'Read the code' },
          { id: 'write', title: 'Write it', status: 'doing' },
          { title: 'Tests' },
        ],
      });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({
        id: 'plan',
        ticket_key: t.key,
        title: 'Plan: add CSV export',
        progress: { done: 0, total: 3 },
        owner: { id: agentId },
      });
      const stored = (await listOf(b.id, t.id, 'plan')) as Tasklist;
      expect(stored.items.map((i) => i.id)).toEqual(['read', 'write', expect.any(String)]);
      expect(stored.owner).toBe(agentId);

      // A replace keeps the ids it is given.
      const again = await rest(agentKey, 'PUT', `/v1/tickets/${t.key}/tasklists/plan`, {
        title: 'Plan: add CSV export',
        items: [
          { id: 'read', title: 'Read the code', status: 'done' },
          { id: 'write', title: 'Write it', status: 'doing' },
        ],
      });
      expect(
        (again.body as { items: { id: string; status: string }[] }).items.map((i) => [
          i.id,
          i.status,
        ]),
      ).toEqual([
        ['read', 'done'],
        ['write', 'doing'],
      ]);

      const client = await mcpClient(agentKey);
      const viaMcp = parsed<{ id: string; title: string; items: unknown[] }>(
        await client.callTool({
          name: 'set_tasklist',
          arguments: {
            key: t.key,
            list_id: 'plan2',
            title: 'Second plan',
            items: [{ title: 'One' }],
          },
        }),
      );
      expect(viaMcp).toMatchObject({ id: 'plan2', title: 'Second plan' });
      await client.close();
    },
  );

  it.skipIf(!HAS_TASKLIST || !HAS_ITEM)(
    'PATCH one item answers the whole list with its new progress',
    async () => {
      const { agentKey, t } = await stage();
      await rest(agentKey, 'PUT', `/v1/tickets/${t.key}/tasklists/plan`, {
        title: 'Plan',
        items: [
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B' },
        ],
      });
      const patched = await rest(agentKey, 'PATCH', `/v1/tickets/${t.key}/tasklists/plan/items/a`, {
        status: 'done',
      });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ id: 'plan', progress: { done: 1, total: 2 } });
      const failed = await rest(agentKey, 'PATCH', `/v1/tickets/${t.key}/tasklists/plan/items/b`, {
        status: 'failed',
        note: 'the export times out',
      });
      expect(
        (
          failed.body as { items: { id: string; status: string; note: string | null }[] }
        ).items.find((i) => i.id === 'b'),
      ).toMatchObject({
        status: 'failed',
        note: 'the export times out',
      });
      // An empty patch says so rather than writing nothing quietly.
      expect(
        (await rest(agentKey, 'PATCH', `/v1/tickets/${t.key}/tasklists/plan/items/a`, {})).status,
      ).toBe(400);
      expect(
        (
          await rest(agentKey, 'PATCH', `/v1/tickets/${t.key}/tasklists/plan/items/zz`, {
            status: 'done',
          })
        ).status,
      ).toBe(404);
    },
  );

  it.skipIf(!HAS_TASKLIST || !HAS_TASKLIST_DELETE)('DELETE removes the list', async () => {
    const { agentKey, t, b } = await stage();
    await rest(agentKey, 'PUT', `/v1/tickets/${t.key}/tasklists/plan`, {
      title: 'Plan',
      items: [{ title: 'A' }],
    });
    const del = await rest(agentKey, 'DELETE', `/v1/tickets/${t.key}/tasklists/plan`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true });
    expect(await listOf(b.id, t.id, 'plan')).toBeUndefined();
    expect(
      ((await rest(agentKey, 'GET', `/v1/tickets/${t.key}/tasklists`)).body as { data: unknown[] })
        .data,
    ).toEqual([]);
  });
});

// ─── heartbeat (§L3) ─────────────────────────────────────────────────────────

describe('heartbeat', () => {
  it('GET /v1/agents/status applies the 75-second rule and names the ticket', async () => {
    const { ownerKey, agentKey, agentId, t, b } = await stage();
    const now = Date.now();
    // Seeded straight into the live tree: a beat is an RTDB node now (§W).
    await rtdbAdmin()
      .ref(liveTree.status(b.id, agentId, t.id))
      .set({
        ticketId: t.id,
        message: 'Running tests (3/12)',
        progress: 0.25,
        state: 'working',
        at: now - 5_000,
        startedAt: now - 60_000,
      } satisfies LiveStatus);
    await rtdbAdmin()
      .ref(liveTree.status(b.id, agentId, null))
      .set({
        state: 'working',
        at: now - HEARTBEAT_STALE_MS - 5_000,
        startedAt: now - 600_000,
      } satisfies LiveStatus);

    const all = (await rest(ownerKey, 'GET', '/v1/agents/status')).body as {
      data: {
        agent: { id: string; kind: string };
        ticket_key: string | null;
        state: string;
        health: string;
        message: string | null;
      }[];
    };
    expect(all.data).toHaveLength(2);
    const live = all.data.find((s) => s.ticket_key === t.key)!;
    expect(live).toMatchObject({
      agent: { id: agentId, kind: 'agent' },
      state: 'working',
      health: 'working',
      message: 'Running tests (3/12)',
    });
    // A 'working' status with no beat for more than 75 s reads as stale (🔴 'No signal').
    expect(all.data.find((s) => s.ticket_key === null)).toMatchObject({
      state: 'working',
      health: 'stale',
    });

    // ?ticket= narrows it to one ticket.
    const one = (await rest(ownerKey, 'GET', `/v1/agents/status?ticket=${t.key}`)).body as {
      data: { ticket_key: string | null }[];
    };
    expect(one.data.map((s) => s.ticket_key)).toEqual([t.key]);
    // An agent token sees only its own rows (another agent's work is none of its business).
    expect(
      (
        (await rest(agentKey, 'GET', '/v1/agents/status')).body as {
          data: { agent: { id: string } }[];
        }
      ).data.every((s) => s.agent.id === agentId),
    ).toBe(true);
  });

  it.skipIf(!HAS_HEARTBEAT)('a beat writes one RTDB node and never the ticket', async () => {
    const { agentKey, agentId, t, b } = await stage();
    const before = (await db().doc(paths.ticket(b.id, t.id)).get()).data() as Ticket;

    const beat = await rest(agentKey, 'POST', '/v1/heartbeat', {
      ticket: t.key,
      state: 'working',
      message: 'Running tests (3/12)',
      progress: 0.25,
    });
    expect(beat.status).toBe(200);
    expect(beat.body).toMatchObject({
      agent: { id: agentId, kind: 'agent' },
      ticket_key: t.key,
      state: 'working',
      health: 'working',
      message: 'Running tests (3/12)',
      progress: 0.25,
      ended_at: null,
    });
    expect(await readStatus(b.id, agentId, t.id)).toMatchObject({
      agentId,
      ticketId: t.id,
      state: 'working',
    });
    // §W: nothing at all is written to Firestore any more.
    expect(
      (
        await db()
          .doc(paths.agentStatusDoc(b.id, agentStatusId(agentId, t.id)))
          .get()
      ).exists,
    ).toBe(false);
    // §L3: 'a beat every minute doesn't retrigger the ticket's search indexing'.
    const after = (await db().doc(paths.ticket(b.id, t.id)).get()).data() as Ticket;
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.lastActivityAt).toBe(before.lastActivityAt);

    // The final beat ends the run; an agent-level beat has no ticket at all.
    const done = await rest(agentKey, 'POST', '/v1/heartbeat', { ticket: t.key, state: 'done' });
    expect(done.body).toMatchObject({
      state: 'done',
      health: 'done',
      ended_at: expect.any(String),
    });
    const client = await mcpClient(agentKey);
    expect(
      parsed<{ ticket_key: string | null; state: string }>(
        await client.callTool({
          name: 'heartbeat',
          arguments: { state: 'idle', message: 'waiting for an answer' },
        }),
      ),
    ).toMatchObject({
      ticket_key: null,
      state: 'idle',
      health: 'idle',
    });
    await client.close();
    expect(await readStatus(b.id, agentId, null)).toMatchObject({ state: 'idle' });
  });
});
