import { describe, expect, it } from 'vitest';
import {
  envelopeSchemaFor,
  IntakeSubmitReqSchema,
  McpToolSchemas,
  MCP_TOOLS,
  mcpToolAllowed,
  mcpClientConfig,
  curlExamples,
  PublicEventSchema,
  PublicFileSchema,
  PublicMessageSchema,
  PUBLIC_EVENT_TYPES,
  REST_ROUTES,
  RestAckBodySchema,
  RestBoardAgentBodySchema,
  RestCreateAgentBodySchema,
  RestCreateBoardBodySchema,
  RestEventsQuerySchema,
  RestLiveResSchema,
  RestGetFileQuerySchema,
  RestMeResSchema,
  RestPatchTicketBodySchema,
  RestPostMessageBodySchema,
  RestUploadJsonBodySchema,
  restPatchScopes,
  parseSignatureHeader,
  formatSignatureHeader,
  PublicTicketSchema,
  RestCreateTicketBodySchema,
  RestListTicketsQuerySchema,
  toIso,
  WEBHOOK_EVENT_DATA,
} from './index.js';
import { NOTIFY_EVENTS, SCOPE_PRESETS, SCOPES, WEBHOOK_EVENTS } from '../types/index.js';
import { AGENT_EVENT_TYPES } from '../schema/agent.js';

const ticket = {
  id: 't1',
  key: 'ENG-1',
  url: 'https://taskmanager.app/t/ENG-1',
  title: 'Fix login',
  description_md: 'Ping [@Priya](mailto:priya@example.com) about #ENG-2',
  board: { id: 'b', key: 'ENG', name: 'Engineering' },
  stage: { id: 's', name: 'To do', category: 'todo' },
  priority: null,
  tags: ['bug'],
  assignees: [
    {
      id: 'u',
      kind: 'user',
      name: 'Priya',
      email: 'priya@example.com',
      avatar_url: null,
      icon: null,
    },
    {
      id: 'ag_Bu1lder000000001',
      kind: 'agent',
      name: 'Builder',
      email: '',
      avatar_url: null,
      icon: 'claude',
    },
  ],
  start_at: null,
  due_at: toIso(0),
  due_all_day: true,
  estimate: null,
  fields: { Client: 'Acme' },
  links: [{ type: 'blocks', key: 'ENG-2' }],
  referenced_by: [],
  state: 'active',
  cost: null,
  aggs: {},
  created_at: toIso(0),
  updated_at: toIso(0),
};

/** A turn receipt (§Y1), as the wire states it. */
const receipt = {
  n: 3,
  outcome: 'review',
  cost_usd: 1.24,
  session_usd: 21.1,
  duration_ms: 743000,
  api_turns: 46,
  model: 'claude-fable-5-1',
  usage: { input: 1000, output: 200, cache_read: 5000, cache_write: 100 },
};

describe('public api shapes', () => {
  it('PublicTicket and a typed envelope parse', () => {
    expect(PublicTicketSchema.safeParse(ticket).success).toBe(true);
    const env = {
      id: 'evt_1',
      type: 'ticket.created',
      createdAt: new Date(0).toISOString(),
      boardId: 'b',
      actor: { id: 'u', name: 'Asha', via: 'api' },
      data: ticket,
    };
    expect(envelopeSchemaFor('ticket.created').safeParse(env).success).toBe(true);
    expect(envelopeSchemaFor('ticket.deleted').safeParse(env).success).toBe(false);
    expect(Object.keys(WEBHOOK_EVENT_DATA).sort()).toEqual([...WEBHOOK_EVENTS].sort());
  });

  it('REST bodies and queries', () => {
    expect(
      RestCreateTicketBodySchema.safeParse({ title: 'x', assignees: ['a@b.com'] }).success,
    ).toBe(true);
    expect(RestCreateTicketBodySchema.safeParse({ assignees: [] }).success).toBe(false);
    expect(RestListTicketsQuerySchema.parse({ limit: '10' }).limit).toBe(10);
    expect(RestListTicketsQuerySchema.parse({}).limit).toBe(50);
  });

  it('MCP tools: every tool has a schema and metadata; no delete tool', () => {
    expect(Object.keys(McpToolSchemas).sort()).toEqual(Object.keys(MCP_TOOLS).sort());
    // No tool deletes a TICKET; phase 3's delete_tasklist only removes a checklist.
    expect(Object.keys(MCP_TOOLS).filter((n) => n.includes('delete'))).toEqual(['delete_tasklist']);
    expect(
      McpToolSchemas.link_tickets.safeParse({ from: 'ENG-1', to: 'ENG-2', type: 'blocks' }).success,
    ).toBe(true);
    expect(McpToolSchemas.get_ticket.safeParse({}).success).toBe(false);
  });

  it('MCP: every tool named in agents.html §G exists; scopes are real', () => {
    const G = [
      'whoami',
      'get_board',
      'list_my_tickets',
      'search_tickets',
      'get_ticket',
      'get_messages',
      'create_ticket',
      'update_ticket',
      'move_ticket',
      'assign_ticket',
      'post_message',
      'upload_file',
      'read_file',
      'link_tickets',
      'get_events',
      'ack_events',
    ];
    for (const n of G) expect(MCP_TOOLS).toHaveProperty(n);
    for (const t of Object.values(MCP_TOOLS))
      for (const sc of t.scopes) expect(SCOPES).toContain(sc);
  });

  it('MCP: cross-field rules', () => {
    const up = McpToolSchemas.upload_file;
    expect(up.safeParse({ key: 'ENG-1', name: 'plan.md', text: '# Plan' }).success).toBe(true);
    expect(up.safeParse({ key: 'ENG-1', name: 'x.png', content_base64: 'AAAA' }).success).toBe(
      true,
    );
    expect(up.safeParse({ key: 'ENG-1', name: 'plan.md' }).success).toBe(false);
    expect(
      up.safeParse({ key: 'ENG-1', name: 'plan.md', text: 'a', content_base64: 'AA' }).success,
    ).toBe(false);
    expect(McpToolSchemas.ack_events.safeParse({ upTo: 'c' }).success).toBe(true);
    expect(McpToolSchemas.ack_events.safeParse({}).success).toBe(false);
    expect(McpToolSchemas.assign_ticket.safeParse({ key: 'ENG-1', add: ['Builder'] }).success).toBe(
      true,
    );
    expect(McpToolSchemas.assign_ticket.safeParse({ key: 'ENG-1' }).success).toBe(false);
    expect(
      McpToolSchemas.post_message.safeParse({ key: 'ENG-1', markdown: '', attachments: ['f1'] })
        .success,
    ).toBe(true);
    expect(McpToolSchemas.post_message.safeParse({ key: 'ENG-1', markdown: '  ' }).success).toBe(
      false,
    );
    expect(McpToolSchemas.whoami.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('MCP: tools hidden by scopes', () => {
    expect(mcpToolAllowed('whoami', [])).toBe(true);
    expect(mcpToolAllowed('move_ticket', ['tickets:read'])).toBe(false);
    expect(mcpToolAllowed('move_ticket', ['tickets:move'])).toBe(true);
    expect(mcpToolAllowed('move_ticket', undefined)).toBe(true);
    const worker = (Object.keys(MCP_TOOLS) as (keyof typeof MCP_TOOLS)[]).filter((n) =>
      mcpToolAllowed(n, SCOPE_PRESETS.worker),
    );
    expect(worker).toContain('post_message');
    expect(worker).toContain('upload_file');
    expect(worker).not.toContain('assign_ticket');
    expect(worker).not.toContain('create_ticket');
  });

  it('REST v1 (§F): routes, bodies, queries', () => {
    const paths = REST_ROUTES.map((r) => `${r.method} ${r.path}`);
    for (const p of [
      'GET /v1/me',
      'GET /v1/board',
      'GET /v1/tickets',
      'POST /v1/tickets',
      'GET /v1/tickets/{KEY}',
      'PATCH /v1/tickets/{KEY}',
      'POST /v1/tickets/{KEY}/move',
      'POST /v1/tickets/{KEY}/state',
      'GET /v1/tickets/{KEY}/messages',
      'POST /v1/tickets/{KEY}/messages',
      'POST /v1/tickets/{KEY}/files',
      'GET /v1/files/{fileId}',
      'GET /v1/events',
      'GET /v1/events/stream',
      'POST /v1/events/ack',
    ])
      expect(paths).toContain(p);
    expect(new Set(paths).size).toBe(paths.length);
    for (const r of REST_ROUTES) for (const sc of r.scopes) expect(SCOPES).toContain(sc);

    expect(RestPostMessageBodySchema.safeParse({ body_markdown: '# Done' }).success).toBe(true);
    expect(RestPostMessageBodySchema.safeParse({ attachments: ['f1'] }).success).toBe(true);
    expect(RestPostMessageBodySchema.safeParse({}).success).toBe(false);
    expect(RestUploadJsonBodySchema.safeParse({ name: 'r.html', text: '<h1>x</h1>' }).success).toBe(
      true,
    );
    expect(RestUploadJsonBodySchema.safeParse({ name: 'r.html' }).success).toBe(false);
    expect(RestAckBodySchema.safeParse({ ids: ['a'] }).success).toBe(true);
    expect(RestAckBodySchema.safeParse({ upTo: 'a' }).success).toBe(true);
    expect(RestAckBodySchema.safeParse({ ids: ['a'], upTo: 'b' }).success).toBe(false);
    expect(RestGetFileQuerySchema.parse({ content: '1' }).content).toBe(true);
    expect(RestEventsQuerySchema.parse({}).limit).toBe(50);
    expect(restPatchScopes({ stage: 's', assignees: [], title: 'x' }).sort()).toEqual([
      'tickets:assign',
      'tickets:move',
      'tickets:update',
    ]);
    expect(
      RestPatchTicketBodySchema.safeParse({
        assignees: ['Builder', 'a@b.com', 'ag_Bu1lder000000001'],
      }).success,
    ).toBe(true);
  });

  it('REST /v1/me for an agent token carries the system prompt', () => {
    const me = {
      principal: {
        kind: 'agent',
        id: 'ag_Bu1lder000000001',
        name: 'Builder',
        email: null,
        avatar_url: null,
        icon: 'claude',
        description: 'Builds',
        system_prompt: '# You build',
      },
      owner: { id: 'u', name: 'Asha', email: 'asha@example.com' },
      kind: 'board',
      board: { id: 'b', key: 'ENG', name: 'Engineering' },
      role: 'commenter',
      scopes: SCOPE_PRESETS.worker,
      via: 'api',
      token: {
        id: 'k1',
        name: 'orch-eng-builder',
        prefix: 'tm_live_3fa9',
        expires_at: null,
        kind: 'board',
      },
    };
    expect(RestMeResSchema.safeParse(me).success).toBe(true);
  });

  /**
   * §R2 — an ACCOUNT token answers /v1/me with kind 'account', no single
   * board, and the boards it reaches right now. That is how a client (the
   * SDK) tells the two kinds apart without guessing.
   */
  it("REST /v1/me for an account token: kind 'account', no board, the boards reachable now", () => {
    const me = {
      principal: {
        kind: 'user',
        id: 'u',
        name: 'Asha',
        email: 'asha@example.com',
        avatar_url: null,
        icon: null,
      },
      owner: null,
      kind: 'account',
      board: null,
      boards: [
        { id: 'b1', key: 'ENG', name: 'Engineering' },
        { id: 'b2', key: 'OPS', name: 'Operations' },
      ],
      role: null,
      scopes: SCOPE_PRESETS.fullAccount,
      via: 'api',
      token: {
        id: 'k2',
        name: 'claude',
        prefix: 'tm_live_9c1a',
        expires_at: '2026-12-24T00:00:00.000Z',
        kind: 'account',
      },
    };
    const parsed = RestMeResSchema.safeParse(me);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.kind).toBe('account');
    expect(parsed.success && parsed.data.board).toBe(null);
    expect(parsed.success && parsed.data.boards?.map((b) => b.key)).toEqual(['ENG', 'OPS']);
    // An account token never acts as an agent (§R1).
    expect(parsed.success && parsed.data.principal.kind).toBe('user');
    // The kind is not optional: a client must always be told.
    const { kind: _k, ...noKind } = me;
    expect(RestMeResSchema.safeParse(noKind).success).toBe(false);
  });

  it('§R2: board-scoped routes are reachable with the board in the path', () => {
    const paths = REST_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('GET /v1/boards/{KEY}');
    expect(paths).toContain('GET /v1/boards/{KEY}/tickets');
    expect(paths).toContain('POST /v1/boards/{KEY}/tickets');
    // …and the unnested ones still exist, unchanged, for board tokens.
    expect(paths).toContain('GET /v1/board');
    expect(paths).toContain('GET /v1/tickets');
    expect(paths).toContain('POST /v1/tickets');
  });

  it('public file, message and event shapes', () => {
    const file = {
      id: 'f1',
      ticket_key: 'ENG-1',
      name: 'plan.md',
      mime: 'text/markdown',
      size: 10,
      kind: 'markdown',
      language: 'markdown',
      textual: true,
      message_id: null,
      source: 'upload',
      uploaded_by: { id: 'ag_Bu1lder000000001', kind: 'agent', name: 'Builder' },
      created_at: toIso(0),
    };
    expect(PublicFileSchema.safeParse(file).success).toBe(true);
    expect(
      PublicMessageSchema.safeParse({
        id: 'm',
        ticket_key: 'ENG-1',
        kind: 'comment',
        body_md: 'hi',
        author: { id: 'ag_Bu1lder000000001', kind: 'agent', name: 'Builder' },
        via: 'mcp',
        via_token: 'orch-eng-builder',
        reply_to: null,
        attachments: [
          { id: 'f1', name: 'plan.md', mime: 'text/markdown', size: 10, kind: 'markdown' },
        ],
        reactions: {},
        pinned: false,
        run: null,
        agg: null,
        created_at: toIso(0),
        edited_at: null,
        deleted: false,
      }).success,
    ).toBe(true);
    expect(
      PublicEventSchema.safeParse({
        id: '00000000a_x',
        type: 'assigned',
        board: { id: 'b', key: 'ENG', name: 'Eng' },
        ticket_id: 't',
        ticket_key: 'ENG-1',
        message_id: null,
        actor: { id: 'u', kind: 'user', name: 'Asha' },
        summary: 'Asha assigned you ENG-1',
        created_at: toIso(0),
        acked_at: null,
      }).success,
    ).toBe(true);
    for (const t of [...AGENT_EVENT_TYPES, ...NOTIFY_EVENTS])
      expect(PUBLIC_EVENT_TYPES).toContain(t);
  });

  /**
   * Phase 17 (§Y1): the turn receipt rides on POST …/messages (REST), on
   * post_message (MCP) and comes back on every PublicMessage as `run`.
   */
  it('§Y1: the turn receipt on the way in and on the way out', () => {
    expect(
      RestPostMessageBodySchema.safeParse({ body_markdown: 'Turn 3', run: receipt }).success,
    ).toBe(true);
    expect(
      RestPostMessageBodySchema.safeParse({ body_markdown: 'Turn 3', run: null }).success,
    ).toBe(true);
    // usage may be null, session_usd / api_turns / model may be null — but not absent.
    expect(
      RestPostMessageBodySchema.safeParse({
        body_markdown: 'x',
        run: { ...receipt, usage: null, session_usd: null, api_turns: null, model: null },
      }).success,
    ).toBe(true);
    const { usage: _u, ...noUsage } = receipt;
    expect(RestPostMessageBodySchema.safeParse({ body_markdown: 'x', run: noUsage }).success).toBe(
      false,
    );
    expect(
      RestPostMessageBodySchema.safeParse({
        body_markdown: 'x',
        run: { ...receipt, outcome: 'won' },
      }).success,
    ).toBe(false);
    expect(
      RestPostMessageBodySchema.safeParse({ body_markdown: 'x', run: { ...receipt, cost_usd: -1 } })
        .success,
    ).toBe(false);
    expect(
      McpToolSchemas.post_message.safeParse({ key: 'ENG-1', markdown: 'Turn 3', run: receipt })
        .success,
    ).toBe(true);
    expect(
      McpToolSchemas.post_message.safeParse({ key: 'ENG-1', markdown: 'Turn 3', run: { n: 1 } })
        .success,
    ).toBe(false);
    const msg = {
      id: 'm',
      ticket_key: 'ENG-1',
      kind: 'comment',
      body_md: 'Turn 3 · review · $1.24 · 12 min',
      author: { id: 'ag_Bu1lder000000001', kind: 'agent', name: 'Builder' },
      via: 'api',
      via_token: 'orch-eng-builder',
      reply_to: null,
      attachments: [],
      reactions: {},
      pinned: false,
      run: receipt,
      agg: { entries: [{ field_id: 'cost', value: 1.24 }] },
      created_at: toIso(0),
      edited_at: null,
      deleted: false,
    };
    expect(PublicMessageSchema.safeParse(msg).success).toBe(true);
    // `run` is always stated on a message, so a reader never has to guess.
    const { run: _r, ...noRun } = msg;
    expect(PublicMessageSchema.safeParse(noRun).success).toBe(false);
    // …and `cost` on a ticket, null until the first receipt.
    expect(
      PublicTicketSchema.safeParse({ ...ticket, cost: { usd: 402.27, runs: 9 } }).success,
    ).toBe(true);
    const { cost: _c, ...noCost } = ticket;
    expect(PublicTicketSchema.safeParse(noCost).success).toBe(false);
  });

  it('aggregates.html: agg entries on the way in (by id or label) and out', () => {
    expect(
      RestPostMessageBodySchema.safeParse({ agg: { entries: [{ field: 'Time', value: -0.5 }] } })
        .success,
    ).toBe(true);
    expect(
      RestPostMessageBodySchema.safeParse({
        agg: { entries: [{ field_id: 'a_abc123', field: 'Time', value: 1 }] },
      }).success,
    ).toBe(false);
    expect(RestPostMessageBodySchema.safeParse({ agg: { entries: [] } }).success).toBe(false);
    expect(
      McpToolSchemas.post_message.safeParse({
        key: 'ENG-1',
        markdown: '',
        agg: { entries: [{ field_id: 'cost', value: 2 }] },
      }).success,
    ).toBe(true);
    expect(
      McpToolSchemas.get_aggregates.safeParse({ field: 'Time', from: '2026-W30' }).success,
    ).toBe(true);
    expect(McpToolSchemas.get_aggregates.safeParse({ from: '30 days' }).success).toBe(false);
    const { aggs: _a, ...noAggs } = ticket;
    expect(PublicTicketSchema.safeParse(noAggs).success).toBe(false);
    expect(
      PublicTicketSchema.safeParse({ ...ticket, aggs: { cost: { total: 1.5, count: 2 } } }).success,
    ).toBe(true);
  });

  /**
   * Phase 17 (§Z2): the three account-token routes and the live credential
   * (§W). Their scopes are account scopes, so a board token cannot pass the
   * route gate — which is the whole point.
   */
  it('§Z2 / §W: account-token routes and GET /v1/live are in the table with account scopes', () => {
    const byPath = new Map(REST_ROUTES.map((r) => [`${r.method} ${r.path}`, r]));
    expect(byPath.get('POST /v1/boards')?.scopes).toEqual(['boards:create']);
    expect(byPath.get('POST /v1/agents')?.scopes).toEqual(['agents:write']);
    expect([...(byPath.get('POST /v1/boards/{KEY}/agents')?.scopes ?? [])].sort()).toEqual([
      'agents:write',
      'boards:admin',
    ]);
    expect(byPath.get('GET /v1/live')?.scopes).toEqual(['events:read']);
    // A board token's presets never carry an account scope.
    for (const p of ['POST /v1/boards', 'POST /v1/agents', 'POST /v1/boards/{KEY}/agents']) {
      const need = byPath.get(p)!.scopes;
      expect(need.some((sc) => (SCOPE_PRESETS.everything as readonly string[]).includes(sc))).toBe(
        false,
      );
      expect(need.some((sc) => (SCOPE_PRESETS.fullAccount as readonly string[]).includes(sc))).toBe(
        true,
      );
    }
    expect(
      RestCreateBoardBodySchema.safeParse({ name: 'Eng', key: 'ENG', template: 'kanban' }).success,
    ).toBe(true);
    expect(RestCreateBoardBodySchema.safeParse({ name: 'Eng', key: 'eng' }).success).toBe(false);
    expect(
      RestCreateAgentBodySchema.safeParse({ name: 'Builder', system_prompt: '# Hi' }).success,
    ).toBe(true);
    expect(RestCreateAgentBodySchema.safeParse({ name: '' }).success).toBe(false);
    expect(
      RestBoardAgentBodySchema.safeParse({
        agent: 'ag_Bu1lder000000001',
        role: 'commenter',
        stage_grant: { stages: ['s1'], assigned_only: true },
      }).success,
    ).toBe(true);
    expect(
      RestBoardAgentBodySchema.safeParse({ agent: 'ag_Bu1lder000000001', role: null }).success,
    ).toBe(true);
    // §AA2 changed this: an agent may be a board admin now.
    expect(
      RestBoardAgentBodySchema.safeParse({ agent: 'ag_Bu1lder000000001', role: 'admin' }).success,
    ).toBe(true);
    expect(
      RestBoardAgentBodySchema.safeParse({ agent: 'ag_Bu1lder000000001', role: 'owner' }).success,
    ).toBe(false);
    expect(RestBoardAgentBodySchema.safeParse({ agent: 'nope', role: 'editor' }).success).toBe(
      false,
    );
    expect(
      RestLiveResSchema.safeParse({
        database_url: 'https://x.asia-southeast1.firebasedatabase.app',
        auth: 'eyJ…',
        expires_in: 3600,
        paths: ['agents/ag_Bu1lder000000001/wake', 'rev/b1'],
      }).success,
    ).toBe(true);
  });

  it('token snippets', () => {
    const cfg = mcpClientConfig({ key: 'tm_live_x', apiBase: 'https://api.example.com/' });
    expect(cfg.mcpServers.taskmanager!.url).toBe('https://api.example.com/mcp');
    expect(cfg.mcpServers.taskmanager!.headers.Authorization).toBe('Bearer tm_live_x');
    expect(curlExamples({ key: 'tm_live_x', apiBase: 'https://api.example.com' })[0]).toContain(
      'https://api.example.com/v1/me',
    );
  });

  it('intake and signatures', () => {
    expect(
      IntakeSubmitReqSchema.safeParse({ title: 'Broken', reporter: { email: 'x@y.com' } }).success,
    ).toBe(true);
    expect(IntakeSubmitReqSchema.safeParse({ title: '' }).success).toBe(false);
    expect(parseSignatureHeader(formatSignatureHeader(1700000000, 'abc123'))).toEqual({
      t: 1700000000,
      v1: 'abc123',
    });
    expect(parseSignatureHeader('garbage')).toBeNull();
  });
});
