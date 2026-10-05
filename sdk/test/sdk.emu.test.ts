/**
 * The SDK against the REAL /v1, with a seeded agent token.
 *
 * The unit suite proves the SDK sends what it means to; this one proves the
 * server agrees — every field name, every query parameter and every status
 * code, through the same hono app the `api` function serves. The client's
 * injectable `fetch` is what makes that cheap: no ports, no server to start.
 *
 * Run it with the root `pnpm test:emu` (it holds the emulators lock).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SCOPE_PRESETS, type Scope } from '@tm/shared';
import { createApp } from '../../backend/src/http/app.js';
import { call, setupEmulators, type TestUser } from '../../backend/test/harness/index.js';
import {
  agentKeyFor,
  apiKeyFor,
  seedAgent,
  seedAgentEvent,
} from '../../backend/test/platform/helpers.js';
import { people, seedAttachMemory, seedBoard } from '../../backend/test/tickets/helpers.js';
import { createClient, type TmClient } from '../src/client.js';
import { mcpTools, registerTools } from '../src/mcp.js';
import { TmError } from '../src/errors.js';

setupEmulators();

/** The app answers in-process; the SDK never learns the difference. */
async function appFetch(): Promise<typeof fetch> {
  const app = await createApp();
  return ((url: string | URL, init?: RequestInit) =>
    app.request(String(url), init)) as typeof fetch;
}

interface Scene {
  owner: TestUser;
  priya: TestUser;
  agentId: string;
  boardKey: string;
  boardId: string;
  /** A client acting as the agent. */
  tm: TmClient;
  /** A client acting as the owner (everything scope) — the "other side". */
  human: TmClient;
  ticketKey: string;
}

let scene: Scene;
let attachMemoryId = '';

beforeAll(async () => {
  const f = await appFetch();
  const { owner, priya } = await people('owner', 'priya');
  const board = await seedBoard({ admin: owner, editors: [priya] });
  // memory.html §J: uploads go into the board's attachment memory.
  attachMemoryId = await seedAttachMemory(board.id, owner);
  const { id: agentId } = await seedAgent(owner, {
    name: `Builder ${Date.now()}`,
    boardId: board.id,
    role: 'editor',
  });
  const { key: agentKey } = await agentKeyFor(
    owner,
    agentId,
    [...SCOPE_PRESETS.worker, 'tickets:create'] as Scope[],
    board.id,
  );
  const { key: ownerKey } = await apiKeyFor(
    owner,
    [...SCOPE_PRESETS.everything] as Scope[],
    board.id,
  );

  const client = (token: string): TmClient =>
    createClient({ token, baseUrl: 'http://tm.local', fetch: f, retry: false });
  const tm = client(agentKey);
  const human = client(ownerKey);
  const ticket = await human.tickets.create({
    title: 'Add CSV export',
    description: 'The board wants a CSV button.',
  });

  scene = {
    owner,
    priya,
    agentId,
    boardKey: board.key,
    boardId: board.id,
    tm,
    human,
    ticketKey: ticket.key,
  };
}, 60_000);

describe('identity and board', () => {
  it('me answers with the agent, its owner and its system prompt', async () => {
    const me = await scene.tm.me();
    expect(me.principal.kind).toBe('agent');
    expect(me.principal.id).toBe(scene.agentId);
    expect(me.principal.system_prompt).toContain('Builder');
    expect(me.owner?.id).toBe(scene.owner.uid);
    expect(me.board?.key).toBe(scene.boardKey);
    expect(me.role).toBe('editor');
    expect(me.scopes).toContain('tasklists:write');
  });

  it('board answers with stages, fields and members', async () => {
    const board = await scene.tm.board();
    expect(board.key).toBe(scene.boardKey);
    expect(board.stages.map((s) => s.name)).toContain('Doing');
    expect(board.members?.some((m) => m.kind === 'agent')).toBe(true);
  });
});

describe('tickets', () => {
  it('lists, reads and updates a ticket', async () => {
    const page = await scene.tm.tickets.list({ state: 'active' });
    expect(page.data.some((t) => t.key === scene.ticketKey)).toBe(true);

    const t = await scene.tm.tickets.get(scene.ticketKey, { messages: 5 });
    expect(t.title).toBe('Add CSV export');
    expect(t.description_md).toContain('CSV button');
    expect(t.counts).toBeDefined();

    const moved = await scene.tm.tickets.move(scene.ticketKey, 'Doing');
    expect(moved.stage.name).toBe('Doing');

    const patched = await scene.tm.tickets.update(scene.ticketKey, {
      title: 'Add CSV export (v2)',
    });
    expect(patched.title).toBe('Add CSV export (v2)');
  });

  it('iterate pages through the board', async () => {
    const keys: string[] = [];
    for await (const t of scene.tm.tickets.iterate({ limit: 1 })) keys.push(t.key);
    expect(keys).toContain(scene.ticketKey);
  });

  it('refuses what the token has no scope for, as a typed error', async () => {
    // The worker preset has no tickets:state.
    const err = await scene.tm.tickets.state(scene.ticketKey, 'archived').catch((e: TmError) => e);
    expect(err).toBeInstanceOf(TmError);
    expect((err as TmError).code).toBe('forbidden');
    expect((err as TmError).status).toBe(403);
    expect((err as TmError).problem?.code).toBe('forbidden');
  });

  it('turns a bad field into a 400 with the problem body', async () => {
    const err = await scene.tm.tickets
      .move(scene.ticketKey, 'No Such Stage')
      .catch((e: TmError) => e);
    expect((err as TmError).code).toBe('invalid');
    expect((err as TmError).problem).not.toBeNull();
  });
});

describe('messages and files', () => {
  it('uploads a document and posts it as an attachment', async () => {
    const report = await scene.tm.files.upload(scene.ticketKey, {
      name: 'report.html',
      text: '<h1>CSV export</h1><p>Done.</p>',
    });
    expect(report.file_id).toBe(report.id);
    expect(report.kind).toBe('html');

    const message = await scene.tm.messages.post(scene.ticketKey, {
      markdown: 'Done — see the report.',
      attachments: [report.id],
    });
    expect(message.body_md).toContain('Done');
    expect(message.attachments.map((a) => a.id)).toEqual([report.id]);
    expect(message.author.kind).toBe('agent');

    const text = await scene.tm.files.read(report.id);
    expect(text).toContain('<h1>CSV export</h1>');

    const thread = await scene.tm.messages.list(scene.ticketKey);
    expect(thread.data.some((m) => m.id === message.id)).toBe(true);

    const files = await scene.tm.files.list(scene.ticketKey);
    expect(files.data.some((f) => f.id === report.id)).toBe(true);
  });

  it('uploads bytes as base64', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
    const file = await scene.tm.files.upload(scene.ticketKey, { name: 'x.pdf', bytes });
    expect(file.size).toBe(bytes.length);
  });

  it('uploads into a named memory at a path (1.5.0)', async () => {
    const file = await scene.tm.files.upload(scene.ticketKey, {
      name: 'notes.md',
      text: '# n',
      memoryId: attachMemoryId,
      path: 'sdk/<ticketId>/notes.md',
    });
    expect(file.source).toBe('upload');
    expect(file.memory?.memory_id).toBe(attachMemoryId);
  });

  it('is idempotent: the same key posts one message', async () => {
    const key = `emu-${Date.now()}`;
    const a = await scene.tm.messages.post(
      scene.ticketKey,
      { markdown: 'only once' },
      { idempotencyKey: key },
    );
    const b = await scene.tm.messages.post(
      scene.ticketKey,
      { markdown: 'only once' },
      { idempotencyKey: key },
    );
    expect(b.id).toBe(a.id);
  });
});

describe('task lists and heartbeat', () => {
  it('publishes a plan, ticks an item off and reads the progress', async () => {
    const list = await scene.tm.tasklists.set(scene.ticketKey, {
      title: 'Plan: add CSV export',
      items: ['Read the spec', 'Write it', 'Test it'],
    });
    expect(list.items.map((i) => i.title)).toEqual(['Read the spec', 'Write it', 'Test it']);
    expect(list.progress).toEqual({ done: 0, total: 3 });

    const doing = await scene.tm.tasklists.item(scene.ticketKey, list.id, list.items[0]!.id, {
      status: 'doing',
    });
    expect(doing.items[0]!.status).toBe('doing');

    const done = await scene.tm.tasklists.item(scene.ticketKey, list.id, list.items[0]!.id, {
      status: 'done',
    });
    expect(done.progress).toEqual({ done: 1, total: 3 });

    const lists = await scene.tm.tasklists.list(scene.ticketKey);
    expect(lists.data.some((l) => l.id === list.id)).toBe(true);

    expect(await scene.tm.tasklists.delete(scene.ticketKey, list.id)).toEqual({ deleted: true });
  });

  it('beats, and the board sees the agent working and then finished', async () => {
    const beat = scene.tm.heartbeat.start({
      ticket: scene.ticketKey,
      message: 'Running tests (3/12)',
      everyMs: 600_000,
    });
    const working = await beat.update({ progress: 0.25 });
    expect(working.state).toBe('working');
    expect(working.message).toBe('Running tests (3/12)');
    expect(working.ticket_key).toBe(scene.ticketKey);

    const statuses = await scene.human.agents.status({ ticket: scene.ticketKey });
    expect(statuses.data.some((s) => s.state === 'working')).toBe(true);

    const finished = await beat.done({ message: 'All green' });
    expect(finished.state).toBe('done');
    expect(finished.ended_at).not.toBeNull();
    expect(beat.running).toBe(false);
  });
});

describe('questions', () => {
  it('asks, waits, and gets the answer a person submitted', async () => {
    const asking = scene.tm.questions.ask(scene.ticketKey, {
      title: 'Which database should the report use?',
      blocking: true,
      fields: [
        {
          id: 'db',
          label: 'Database',
          type: 'single',
          options: ['Postgres', 'SQLite'],
          required: true,
        },
      ],
    });
    const question = await asking;
    expect(question.status).toBe('open');
    expect(question.fields[0]!.options?.map((o) => o.label)).toEqual(['Postgres', 'SQLite']);

    // A PERSON answers, in the app — there is no /v1 route for it on purpose.
    const waiting = scene.tm.questions.waitForAnswer(question, { pollMs: 500, timeoutMs: 20_000 });
    await call(scene.owner, 'questionAnswer', {
      boardId: scene.boardId,
      ticketId: (await scene.human.tickets.get(scene.ticketKey)).id,
      messageId: question.message_id,
      values: { db: 'Postgres' },
    });
    const answer = await waiting;
    expect(answer.values.db).toBe('Postgres');
    expect(answer.question.status).toBe('answered');
  });

  it('cancels a question it asked', async () => {
    const q = await scene.tm.questions.ask(scene.ticketKey, {
      title: 'Never mind',
      fields: [{ id: 'x', label: 'X', type: 'text' }],
    });
    const cancelled = await scene.tm.questions.cancel(q.id);
    expect(cancelled.status).toBe('cancelled');
  });
});

describe('the event inbox', () => {
  it('reads seeded events with a cursor and acks them', async () => {
    const ticket = await scene.human.tickets.get(scene.ticketKey);
    const ids = [
      await seedAgentEvent(scene.agentId, {
        boardId: scene.boardId,
        ticketId: ticket.id,
        ticketKey: scene.ticketKey,
        summary: 'one',
      }),
      await seedAgentEvent(scene.agentId, {
        boardId: scene.boardId,
        ticketId: ticket.id,
        ticketKey: scene.ticketKey,
        summary: 'two',
      }),
    ];
    const page = await scene.tm.events.list({ limit: 50 });
    const mine = page.data.filter((e) => ids.includes(e.id));
    expect(mine).toHaveLength(2);
    expect(mine[0]!.ticket_key).toBe(scene.ticketKey);

    const acked = await scene.tm.events.ack(ids);
    expect(acked.acked).toBe(2);
  });

  it('streams events over SSE and resumes from the cursor', async () => {
    const ticket = await scene.human.tickets.get(scene.ticketKey);
    const before = await scene.tm.events.list({ limit: 200 });
    const cursor = before.next_cursor ?? undefined;
    const id = await seedAgentEvent(scene.agentId, {
      boardId: scene.boardId,
      ticketId: ticket.id,
      ticketKey: scene.ticketKey,
      summary: 'streamed',
    });

    const stop = new AbortController();
    const seen: string[] = [];
    for await (const ev of scene.tm.events.stream({ cursor, signal: stop.signal })) {
      seen.push(ev.id);
      stop.abort();
      break;
    }
    expect(seen).toEqual([id]);
  }, 30_000);
});

describe('mcpTools against the real API', () => {
  it('lists the tools the token may actually call, and calls one', async () => {
    const tools = await mcpTools(scene.tm);
    const names = tools.map((t) => t.name);
    expect(names).toContain('post_message'); // worker has comments:write
    expect(names).toContain('heartbeat'); // status:write
    expect(names).toContain('create_ticket'); // this token was given tickets:create
    expect(names).not.toContain('assign_ticket'); // tickets:assign is not in the worker preset

    const get = tools.find((t) => t.name === 'get_ticket')!;
    const out = (await get.handler({ key: scene.ticketKey })) as { key: string };
    expect(out.key).toBe(scene.ticketKey);
  });

  it('serves tools/list and tools/call through a server', async () => {
    const server: {
      registerCapabilities: () => void;
      fallbackRequestHandler?: (
        req: { method: string; params?: Record<string, unknown> },
        extra: unknown,
      ) => Promise<unknown>;
    } = {
      registerCapabilities: () => void 0,
    };
    await registerTools(
      server,
      mcpTools(scene.tm, {
        only: ['post_message'],
        rename: { post_message: 'reply' },
        defaults: { ticket: scene.ticketKey },
      }),
    );
    const handle = server.fallbackRequestHandler!;

    const listed = (await handle({ method: 'tools/list' }, {})) as { tools: { name: string }[] };
    expect(listed.tools.map((t) => t.name)).toEqual(['reply']);

    const called = (await handle(
      { method: 'tools/call', params: { name: 'reply', arguments: { markdown: 'via MCP' } } },
      {},
    )) as {
      content: { text: string }[];
    };
    expect(JSON.parse(called.content[0]!.text)).toMatchObject({ body_md: 'via MCP' });
  });
});

describe('tm.work against the real API', () => {
  it('handles a seeded event: heartbeat, message, done, ack', async () => {
    const ticket = await scene.human.tickets.get(scene.ticketKey);
    const before = await scene.tm.events.list({ limit: 200 });
    const cursor = before.next_cursor ?? undefined;
    await seedAgentEvent(scene.agentId, {
      boardId: scene.boardId,
      ticketId: ticket.id,
      ticketKey: scene.ticketKey,
      summary: 'do the work',
    });

    const summary = await scene.tm.work(
      async ({ ticket: key, beat, tm }) => {
        await beat!.update({ message: 'Working on it', progress: 0.5 });
        await tm.messages.post(key!, { markdown: 'Picked this up.' });
      },
      { cursor, max: 1, heartbeat: { everyMs: 600_000 } },
    );

    expect(summary).toMatchObject({ handled: 1, failed: 0 });

    const statuses = await scene.human.agents.status({ ticket: scene.ticketKey });
    expect(statuses.data.some((s) => s.state === 'done')).toBe(true);

    const thread = await scene.tm.messages.list(scene.ticketKey, { order: 'desc', limit: 5 });
    expect(thread.data.some((m) => m.body_md.includes('Picked this up.'))).toBe(true);
  }, 40_000);
});

/**
 * §R2 — AN ACCOUNT CLIENT, END TO END. The promise being tested is that the
 * board-scoped API you already know is exactly what `tm.board('ENG')` hands
 * back: the same calls, the same shapes, against a token that has no board of
 * its own.
 */
describe('account tokens (agents.html §R2)', () => {
  it('kind, boards.list(), and board(KEY) giving back the whole board API', async () => {
    const f = await appFetch();
    const second = await seedBoard({ admin: scene.owner });
    const { key } = await call(scene.owner, 'apiKeyCreate', {
      name: 'claude',
      kind: 'account' as const,
      scopes: [...SCOPE_PRESETS.fullAccount] as Scope[],
    });
    const tm = createClient({ token: key, baseUrl: 'http://tm.local', fetch: f, retry: false });

    // It knows what it is — and asking twice costs one request.
    expect(await tm.kind()).toBe('account');
    expect(await tm.kind()).toBe('account');

    const me = await tm.me();
    expect(me.kind).toBe('account');
    expect(me.board).toBe(null);
    expect(me.token?.kind).toBe('account');

    const boards = await tm.boards.list();
    const keys = boards.map((b) => b.key);
    expect(keys).toContain(scene.boardKey);
    expect(keys).toContain(second.key);
    // The callable form still works, page and all.
    expect((await tm.boards()).data.map((b) => b.key).sort()).toEqual([...keys].sort());

    // THE SAME API, pinned to one board — no request, no new token.
    const eng = tm.board(scene.boardKey);
    const created = await eng.tickets.create({ title: 'From an account token' });
    expect(created.board.key).toBe(scene.boardKey);

    const listed = await eng.tickets.list({ limit: 100 });
    expect(listed.data.map((t) => t.key)).toContain(created.key);

    // The board itself, and a ticket key that needs no board at all.
    expect((await eng.board()).key).toBe(scene.boardKey);
    expect((await tm.tickets.get(created.key)).board.key).toBe(scene.boardKey);

    // A different board, from the same token, with the same code.
    const other = tm.board(second.key);
    const there = await other.tickets.create({ title: 'On the other board' });
    expect(there.board.key).toBe(second.key);

    // Attribution is the person's, via the token's name.
    await eng.messages.post(created.key, { markdown: 'Working on it.' });
    const thread = await eng.messages.list(created.key, { order: 'desc', limit: 5 });
    const mine = thread.data.find((m) => m.body_md.includes('Working on it.'))!;
    expect(mine.author.id).toBe(scene.owner.uid);
    expect(mine.via_token).toBe('claude');
  }, 60_000);

  it('a board client is unchanged: kind "board", and one board in boards.list()', async () => {
    expect(await scene.tm.kind()).toBe('board');
    const boards = await scene.tm.boards.list();
    expect(boards.map((b) => b.key)).toEqual([scene.boardKey]);
  });
});
