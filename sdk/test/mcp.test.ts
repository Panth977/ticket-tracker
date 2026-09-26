/**
 * mcpTools + registerTools.
 *
 * The first block is the one that matters most: the SDK's catalogue is
 * compared item by item with @tm/shared's MCP_TOOLS — the same list /mcp
 * publishes — so a tool added, renamed or re-scoped on the server cannot
 * quietly go missing from "bring your own MCP server".
 */
import { describe, expect, it } from 'vitest';
import { MCP_TOOLS, McpToolShapes, mcpToolAllowed, SCOPE_PRESETS, type Scope } from '@tm/shared';
import { MCP_TOOL_DEFS, MCP_TOOL_NAMES, mcpTools, registerTools, toCallResult, toolAllowed, type McpToolName } from '../src/mcp.js';
import { mockFetch, testClient } from './helpers.js';

describe('parity with the server /mcp catalogue', () => {
  it('lists exactly the tools @tm/shared does', () => {
    expect([...MCP_TOOL_NAMES].sort()).toEqual(Object.keys(MCP_TOOLS).sort());
  });

  it('uses the same description and scopes for each', () => {
    for (const name of MCP_TOOL_NAMES) {
      const theirs = MCP_TOOLS[name as keyof typeof MCP_TOOLS];
      const ours = MCP_TOOL_DEFS[name];
      expect({ name, description: ours.description, readOnly: ours.readOnly, scopes: [...ours.scopes] }).toEqual({
        name,
        description: theirs.description,
        readOnly: theirs.readOnly,
        scopes: [...theirs.scopes],
      });
    }
  });

  it('accepts the same arguments as the zod shapes', () => {
    for (const name of MCP_TOOL_NAMES) {
      const theirs = Object.keys(McpToolShapes[name as keyof typeof McpToolShapes]).sort();
      const ours = Object.keys(MCP_TOOL_DEFS[name].inputSchema.properties).sort();
      expect({ name, args: ours }).toEqual({ name, args: theirs });
    }
  });

  it('agrees with mcpToolAllowed about who may call what', () => {
    const cases: readonly Scope[][] = [[...SCOPE_PRESETS.readOnly], [...SCOPE_PRESETS.worker], [...SCOPE_PRESETS.everything], []];
    for (const scopes of cases)
      for (const name of MCP_TOOL_NAMES)
        expect({ name, allowed: toolAllowed(name, scopes) }).toEqual({ name, allowed: mcpToolAllowed(name as keyof typeof MCP_TOOLS, scopes) });
  });

  it('gives every tool a strict JSON Schema', () => {
    for (const name of MCP_TOOL_NAMES) {
      const s = MCP_TOOL_DEFS[name].inputSchema;
      expect(s.type).toBe('object');
      expect(s.additionalProperties).toBe(false);
      for (const r of s.required ?? []) expect(Object.keys(s.properties)).toContain(r);
    }
  });
});

const meWith = (scopes: string[]) => ({ body: { principal: { id: 'ag_1', kind: 'agent', name: 'Builder' }, scopes } });

describe('mcpTools', () => {
  it('drops the tools the token has no scope for', async () => {
    const f = mockFetch(meWith(['tickets:read', 'comments:read']));
    const tools = await mcpTools(testClient(f));
    const names = tools.map((t) => t.name);
    expect(names).toContain('get_ticket');
    expect(names).toContain('whoami'); // needs no scope
    expect(names).not.toContain('post_message'); // comments:write
    expect(names).not.toContain('heartbeat'); // status:write
    expect(f.calls.filter((c) => c.path === '/me')).toHaveLength(1);
  });

  it('takes the scopes rather than asking, when given them', async () => {
    const f = mockFetch({ body: {} });
    const tools = await mcpTools(testClient(f), { scopes: ['status:write'] });
    expect(tools.map((t) => t.name).sort()).toEqual(['heartbeat', 'whoami']);
    expect(f.calls).toHaveLength(0);
  });

  it('honours only and exclude', async () => {
    const tools = await mcpTools(testClient(mockFetch({ body: {} })), {
      scopes: [...SCOPE_PRESETS.everything],
      only: ['get_ticket', 'post_message', 'set_tasklist', 'delete_tasklist'],
      exclude: ['delete_tasklist'],
    });
    expect(tools.map((t) => t.name).sort()).toEqual(['get_ticket', 'post_message', 'set_tasklist']);
  });

  it('renames and re-describes', async () => {
    const tools = await mcpTools(testClient(mockFetch({ body: {} })), {
      scopes: [...SCOPE_PRESETS.everything],
      only: ['post_message'],
      rename: { post_message: 'reply' },
      describe: { reply: 'Reply to the ticket you are working on. Markdown.' },
    });
    expect(tools[0]).toMatchObject({ name: 'reply', originalName: 'post_message', description: 'Reply to the ticket you are working on. Markdown.' });
  });

  it('pins defaults out of the schema and back into the call', async () => {
    const f = mockFetch({ body: { id: 'm1' } });
    const tm = testClient(f);
    const tools = await mcpTools(tm, { scopes: [...SCOPE_PRESETS.everything], only: ['post_message', 'heartbeat'], defaults: { ticket: 'ENG-42' } });
    const post = tools.find((t) => t.name === 'post_message')!;
    const beat = tools.find((t) => t.name === 'heartbeat')!;

    // `ticket` reaches post_message's `key` too, and the model cannot see it.
    expect(Object.keys(post.inputSchema.properties)).not.toContain('key');
    expect(post.inputSchema.required).not.toContain('key');
    expect(Object.keys(beat.inputSchema.properties)).not.toContain('ticket');

    await post.handler({ markdown: 'hello' });
    expect(f.last()).toMatchObject({ method: 'POST', path: '/tickets/ENG-42/messages', body: { body_markdown: 'hello' } });

    f.queue({ body: {} });
    await beat.handler({ state: 'working' });
    expect(f.last().body).toMatchObject({ state: 'working', ticket: 'ENG-42' });
  });

  it('a default cannot be overridden by the model', async () => {
    const f = mockFetch({ body: {} });
    const [post] = await mcpTools(testClient(f), { scopes: [...SCOPE_PRESETS.everything], only: ['post_message'], defaults: { ticket: 'ENG-42' } });
    await post!.handler({ key: 'OPS-1', markdown: 'sneaky' });
    expect(f.last().path).toBe('/tickets/ENG-42/messages');
  });

  it('wraps a tool, keyed by the name the model sees', async () => {
    const f = mockFetch({ body: {} });
    const tools = await mcpTools(testClient(f), {
      scopes: [...SCOPE_PRESETS.everything],
      only: ['post_message'],
      rename: { post_message: 'reply' },
      wrap: { reply: (call) => (args) => call({ ...args, markdown: `[bot] ${String(args.markdown)}` }) },
    });
    await tools[0]!.handler({ key: 'ENG-1', markdown: 'hi' });
    expect(f.last().body).toMatchObject({ body_markdown: '[bot] hi' });
  });

  it('keeps everything when told to skip the filter', async () => {
    const tools = await mcpTools(testClient(mockFetch({ body: {} })), { skipScopeFilter: true });
    expect(tools).toHaveLength(MCP_TOOL_NAMES.length);
  });
});

describe('the handlers behind the tools', () => {
  const all = (f: ReturnType<typeof mockFetch>) => mcpTools(testClient(f), { scopes: [...SCOPE_PRESETS.everything] });
  const byName = async (f: ReturnType<typeof mockFetch>, name: McpToolName) => (await all(f)).find((t) => t.name === name)!;

  it('get_ticket asks for the last 20 messages by default', async () => {
    const f = mockFetch({ body: { key: 'ENG-1' } });
    await (await byName(f, 'get_ticket')).handler({ key: 'ENG-1' });
    expect(f.last().query).toEqual({ messages: '20' });
  });

  it('list_my_tickets pins assignee=me', async () => {
    const f = mockFetch({ body: { data: [], next_cursor: null } });
    await (await byName(f, 'list_my_tickets')).handler({ stage: 'QA' });
    expect(f.last().query).toMatchObject({ assignee: 'me', stage: 'QA' });
  });

  it('search_tickets narrows by due_before itself', async () => {
    const f = mockFetch({
      body: {
        data: [
          { key: 'ENG-1', due_at: '2026-01-01T00:00:00Z' },
          { key: 'ENG-2', due_at: '2027-01-01T00:00:00Z' },
          { key: 'ENG-3', due_at: null },
        ],
        next_cursor: null,
      },
    });
    const out = (await (await byName(f, 'search_tickets')).handler({ query: 'csv', due_before: '2026-06-01' })) as { data: { key: string }[] };
    expect(out.data.map((t) => t.key)).toEqual(['ENG-1']);
  });

  it('upload_file takes text or base64', async () => {
    const f = mockFetch({ status: 201, body: {} });
    const tool = await byName(f, 'upload_file');
    await tool.handler({ key: 'ENG-1', name: 'plan.md', text: '# Plan' });
    expect(f.last().body).toMatchObject({ name: 'plan.md', text: '# Plan' });
    f.queue({ status: 201, body: {} });
    await tool.handler({ key: 'ENG-1', name: 'x.bin', content_base64: 'AQID' });
    expect(f.last().body).toMatchObject({ content_base64: 'AQID' });
  });

  it('read_file falls back to metadata when the file is not textual', async () => {
    const f = mockFetch({ status: 422, body: { code: 'unprocessable', status: 422, type: 't', title: 'x' } }, { body: { id: 'f1', url: 'https://signed' } });
    const out = (await (await byName(f, 'read_file')).handler({ fileId: 'f1' })) as { url: string };
    expect(out.url).toBe('https://signed');
  });

  it('link_tickets reads the links and sends them back with one more', async () => {
    const f = mockFetch({ body: { key: 'ENG-1', links: [{ type: 'relates', key: 'ENG-9' }] } }, { body: { key: 'ENG-1' } });
    await (await byName(f, 'link_tickets')).handler({ from: 'ENG-1', to: 'ENG-2', type: 'blocks' });
    expect(f.calls[1]).toMatchObject({ method: 'PATCH', path: '/tickets/ENG-1' });
    expect((f.calls[1]!.body as { links: unknown[] }).links).toEqual([
      { type: 'relates', key: 'ENG-9' },
      { type: 'blocks', key: 'ENG-2' },
    ]);
  });

  it('ack_events takes ids or upTo', async () => {
    const f = mockFetch({ body: { acked: 1 } });
    const tool = await byName(f, 'ack_events');
    await tool.handler({ ids: ['ev1'] });
    expect(f.last().body).toEqual({ ids: ['ev1'] });
    f.queue({ body: { acked: 3 } });
    await tool.handler({ upTo: 'ev9' });
    expect(f.last().body).toEqual({ upTo: 'ev9' });
  });

  it('ask_question answers at once rather than waiting for a person', async () => {
    const f = mockFetch({ status: 201, body: { id: 'q1', status: 'open' } });
    const out = (await (await byName(f, 'ask_question')).handler({
      key: 'ENG-1',
      title: 'Which database?',
      fields: [{ id: 'db', label: 'Database', type: 'single', options: [{ id: 'pg', label: 'Postgres' }] }],
    })) as { id: string };
    expect(out.id).toBe('q1');
    expect(f.calls).toHaveLength(1);
  });

  it('set_tasklist and update_task_item', async () => {
    const f = mockFetch({ body: { id: 'l1' } });
    await (await byName(f, 'set_tasklist')).handler({ key: 'ENG-1', title: 'Plan', items: [{ title: 'Write it' }] });
    expect(f.last().method).toBe('PUT');
    f.queue({ body: {} });
    await (await byName(f, 'update_task_item')).handler({ key: 'ENG-1', list_id: 'l1', item_id: 'i1', status: 'done' });
    expect(f.last()).toMatchObject({ method: 'PATCH', path: '/tickets/ENG-1/tasklists/l1/items/i1' });
  });
});

describe('registerTools', () => {
  /** The little bit of an MCP server registerTools uses. */
  class FakeServer {
    capabilities: Record<string, unknown> | null = null;
    fallbackRequestHandler: ((req: { method: string; params?: Record<string, unknown> }, extra: unknown) => Promise<unknown>) | undefined;
    registerCapabilities(c: Record<string, unknown>): void {
      this.capabilities = c;
    }
  }

  const call = (s: FakeServer, method: string, params?: Record<string, unknown>) => s.fallbackRequestHandler!({ method, params }, {});

  it('answers tools/list with JSON Schema definitions', async () => {
    const server = new FakeServer();
    await registerTools(server, mcpTools(testClient(mockFetch({ body: {} })), { scopes: [...SCOPE_PRESETS.everything], only: ['get_ticket'] }));
    expect(server.capabilities).toEqual({ tools: { listChanged: false } });
    const listed = (await call(server, 'tools/list')) as { tools: { name: string; inputSchema: { type: string } }[] };
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]).toMatchObject({ name: 'get_ticket', inputSchema: { type: 'object' } });
  });

  it('runs a tool and wraps the answer as MCP content', async () => {
    const f = mockFetch({ body: { key: 'ENG-1', title: 'Add CSV export' } });
    const server = new FakeServer();
    await registerTools(server, mcpTools(testClient(f), { scopes: [...SCOPE_PRESETS.everything], only: ['get_ticket'] }));
    const out = (await call(server, 'tools/call', { name: 'get_ticket', arguments: { key: 'ENG-1' } })) as { content: { text: string }[] };
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({ title: 'Add CSV export' });
  });

  it('turns a failed call into an isError answer the model can read', async () => {
    const f = mockFetch({ status: 403, body: { code: 'forbidden', status: 403, type: 't', title: 'Not allowed', detail: 'Only editors may move tickets' } });
    const server = new FakeServer();
    await registerTools(server, mcpTools(testClient(f), { scopes: [...SCOPE_PRESETS.everything], only: ['move_ticket'] }));
    const out = (await call(server, 'tools/call', { name: 'move_ticket', arguments: { key: 'ENG-1', stage: 'QA' } })) as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('Only editors may move tickets');
  });

  it('says so when the tool does not exist', async () => {
    const server = new FakeServer();
    await registerTools(server, mcpTools(testClient(mockFetch({ body: {} })), { scopes: [], only: ['whoami'] }));
    const out = (await call(server, 'tools/call', { name: 'nope' })) as { isError: boolean };
    expect(out.isError).toBe(true);
  });

  it('accepts an McpServer-shaped object and keeps the previous fallback', async () => {
    const inner = new FakeServer();
    inner.fallbackRequestHandler = async (req) => ({ handledElsewhere: req.method });
    await registerTools({ server: inner }, mcpTools(testClient(mockFetch({ body: {} })), { scopes: [], only: ['whoami'] }));
    expect(await call(inner, 'resources/list')).toEqual({ handledElsewhere: 'resources/list' });
    expect((await call(inner, 'tools/list')) as { tools: unknown[] }).toMatchObject({ tools: [{ name: 'whoami' }] });
  });

  it('toCallResult passes text through and JSON-encodes the rest', () => {
    expect(toCallResult('hello')).toEqual({ content: [{ type: 'text', text: 'hello' }] });
    expect(JSON.parse(toCallResult({ a: 1 }).content[0]!.text)).toEqual({ a: 1 });
  });
});
