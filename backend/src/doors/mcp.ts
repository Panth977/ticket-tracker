/**
 * MCP at /mcp — phase 2 (docs/plan/agents.html §G): Streamable HTTP,
 * STATELESS: every POST builds a fresh server + transport bound to the
 * caller's ctx, answers with JSON, and is gone. No session affinity needed on
 * Cloud Functions; GET (a standalone SSE stream) and DELETE are 405.
 *
 * THREE CREDENTIALS, ONE DOOR:
 *   - a BOARD TOKEN ('tm_live_…', Account › Tokens) as the Bearer — what an
 *     orchestrator hands its agent. It works on one board and acts as the
 *     person or as one of their agents (ctx.actor = the agent);
 *   - an ACCOUNT TOKEN (§R2) — "virtual me", what you give Claude. It acts as
 *     you on every board you are on, so the `board` argument stops being
 *     optional whenever a call does not name a ticket key, and list_boards is
 *     the natural first call. Board tokens behave exactly as before;
 *   - an OAuth 2.1 access token — interactive clients (Claude, Cursor …).
 *     A first call without a token gets 401 + WWW-Authenticate naming
 *     /.well-known/oauth-protected-resource/mcp: that is how a client
 *     discovers the OAuth flow (doors/oauth.ts).
 *
 * SCOPES SHAPE THE SERVER: a tool the credential's scopes do not allow is not
 * registered (hidden from tools/list, and "unknown tool" if called anyway),
 * and every handler re-checks (mcpToolAllowed) — belt and braces.
 *
 * EACH TOOL = zod input → the shared operations (platform/v1.ts, ops.ts) →
 * THE SAME COMMANDS the app uses → public shapes as JSON text. BOARD, STAGE,
 * FIELD AND PEOPLE NAMES, NOT IDS; when a name does not resolve, the error
 * lists the names that exist. There is deliberately no delete tool.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ReadResourceRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  errors,
  isAgentId,
  isAppError,
  MCP_RESOURCES,
  MCP_TOOLS,
  mcpToolAllowed,
  ArtifactDataQuerySchema,
  McpToolSchemas,
  McpToolShapes,
  parseOrderByParam,
  paths,
  restPatchScopes,
  type BoardWithId,
  type McpToolInput,
  type McpToolName,
  type PublicMessage,
  type PublicTicket,
  type Scope,
  type Ticket,
  type TicketWithId,
} from '@tm/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../http/env.js';
import { door } from '../http/mounts.js';
import { requireScope, requireScopes, tokenAuth } from '../platform/auth.js';
import { registerAppTools } from './mcpApp.js';
import { registerUiTools } from './mcpUi.js';
import {
  addLink,
  createTicket,
  searchTicketsIn,
  updateTicket,
  type TicketInput,
} from '../platform/ops.js';
import {
  askQuestion,
  cancelQuestion,
  deleteTasklist,
  getQuestion,
  heartbeat,
  setTasklist,
  updateTaskItem,
} from '../platform/phase3.js';
import { boardMembers, toPublicBoard, toPublicFile, toPublicTickets } from '../platform/public.js';
import {
  actorTz,
  boardByKey,
  parseWhen,
  personUid,
  readableBoards,
  requestBoard,
  stageId,
  ticketByKey,
} from '../platform/resolve.js';
import { storeTicketUpload, uploadBytes } from '../platform/uploads.js';
import {
  ackEvents,
  assignTicket,
  boardView,
  eventsPage,
  messagesPage,
  postMessage,
  readFile,
  signedUrl,
  ticketDetail,
  whoami,
} from '../platform/v1.js';
import { artifactDetail, artifactView, buildView, listArtifacts } from '../platform/artifacts.js';
import { dataBatch, dataGet, dataList, dataSet } from '../platform/artifactData.js';
import { invoke } from '../platform/ops.js';
import type { ServerCtx } from '../runtime/context.js';
import { db } from '../runtime/firebase.js';
import { toAppError } from '../runtime/runner.js';
import { withTicketId } from '../tickets/access.js';

const SERVER_INFO = { name: 'taskmanager', version: '2.0.0' };

/** What the model is told about this server, for the credential at hand. */
function instructions(ctx: ServerCtx): string {
  const who = isAgentId(ctx.actor)
    ? 'You act as an AGENT in TaskManager: every change you make is authored by that agent. ' +
      'Call whoami first — it returns your name, your board(s) and your system prompt (follow it). ' +
      // §AA2 / §AA3: the role is the permission — there is no checkbox list to consult.
      'What you may do is set where you work: your ROLE on each board, and on each artifact whether you may build it and read or write its data.'
    : 'You act as the person who connected you: every change you make is recorded as theirs, via this client.';
  /*
   * §R2 — SAY WHICH SHAPE THE WORLD HAS. boardIds === null means the
   * credential spans every board its actor is on (an account token, or an
   * OAuth grant that was not narrowed): the model must name a board on calls
   * that do not carry a ticket key. A board token implies its board, and is
   * told nothing new, so its behaviour is unchanged.
   *
   * §AA1: an agent token is the same shape for the agent — every board IT is
   * on. One converted from a board token still has a default board (§AA6).
   */
  const where =
    ctx.boardIds === null || ctx.boardIds === undefined
      ? `You reach EVERY board ${isAgentId(ctx.actor) ? 'this agent' : 'this account'} is on, as that stands right now. Call list_boards first and keep the keys: ` +
        "tools that work on a board take a `board` argument ('ENG'), which you must give unless the call already names a " +
        'ticket key like ENG-42 (a key names its own board). If you are on exactly one board, it is assumed. '
      : 'You work on ONE board; leave the `board` argument out. ';
  return (
    `${who} ${where}` +
    "Name things the way people do: ticket keys ('ENG-42'), stage and field NAMES, people by email, agents by name, " +
    "yourself as 'me'. Descriptions and messages are GitHub-flavoured Markdown; mention people as @email, agents as " +
    '@ag_… and tickets as #KEY. For plans, reports and documents: upload_file with `text` (a .md or .html name), ' +
    'then post_message with its fileId in attachments — the app opens Markdown and HTML natively. ' +
    'Work from your inbox: get_events (with the cursor you last saw), then ack_events.'
  );
}

const json = (v: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(v, null, 2) }],
});

function fail(e: unknown): CallToolResult {
  const err = toAppError(e);
  const opts = (err.details as { options?: string[] } | undefined)?.options;
  const text = `${err.code}: ${err.message}${opts?.length && !err.message.includes('Available') ? ` (available: ${opts.join(', ')})` : ''}`;
  return { isError: true, content: [{ type: 'text', text }] };
}

/** A ticket as a line in a list — enough to choose one, not the whole thing. */
const brief = (t: PublicTicket) => ({
  key: t.key,
  title: t.title,
  board: t.board.key,
  stage: t.stage.name,
  state: t.state,
  priority: t.priority?.name ?? null,
  assignees: t.assignees.map((a) => (a.kind === 'agent' ? `${a.name} (agent)` : a.email || a.name)),
  due_at: t.due_at,
  updated_at: t.updated_at,
  url: t.url,
});

async function briefs(boards: Map<string, BoardWithId>, ts: TicketWithId[]) {
  const byBoard = new Map<string, TicketWithId[]>();
  for (const t of ts) byBoard.set(t.boardId, [...(byBoard.get(t.boardId) ?? []), t]);
  const pub = new Map<string, PublicTicket>();
  for (const [b, list] of byBoard) {
    const board = boards.get(b);
    if (!board) continue;
    for (const p of await toPublicTickets(board, list)) pub.set(p.id, p);
  }
  return ts.flatMap((t) => {
    const p = pub.get(t.id);
    return p ? [brief(p)] : [];
  });
}

const byDue = (a: Ticket, b: Ticket) =>
  (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER) ||
  b.updatedAt - a.updatedAt;

/** Markdown rendering of one ticket, thread included (the ticket:// resource). */
function ticketMarkdown(
  t: PublicTicket,
  messages: PublicMessage[],
  files: { id: string; name: string; kind: string }[],
): string {
  const lines = [
    `# ${t.key} · ${t.title}`,
    '',
    `- Board: ${t.board.name} (${t.board.key})`,
    `- Stage: ${t.stage.name}`,
    `- State: ${t.state}`,
    `- Priority: ${t.priority?.name ?? '—'}`,
    `- Assignees: ${t.assignees.map((a) => (a.kind === 'agent' ? `${a.name} (agent)` : a.name)).join(', ') || '—'}`,
    `- Due: ${t.due_at ?? '—'}`,
    ...(t.tags.length ? [`- Tags: ${t.tags.join(', ')}`] : []),
    ...Object.entries(t.fields).map(
      ([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
    ),
    ...(t.links.length ? [`- Links: ${t.links.map((l) => `${l.type} #${l.key}`).join(', ')}`] : []),
    ...(files.length
      ? [`- Files: ${files.map((f) => `${f.name} (${f.kind}, file://${f.id})`).join(', ')}`]
      : []),
    `- URL: ${t.url}`,
    '',
    t.description_md || '_No description._',
  ];
  if (messages.length) {
    lines.push('', '## Thread', '');
    for (const m of messages) {
      if (m.kind === 'system') {
        lines.push(`- _${m.body_md}_ (${m.created_at})`);
        continue;
      }
      const by = `${m.author.name}${m.author.kind === 'agent' ? ' (agent)' : ''}`;
      const via = m.via_token
        ? `, via token ${m.via_token}`
        : m.via !== 'app'
          ? `, via ${m.via}`
          : '';
      const att = m.attachments.length
        ? `\n\nAttachments: ${m.attachments.map((a) => `${a.name} (file://${a.id})`).join(', ')}`
        : '';
      lines.push(`**${by}** (${m.created_at}${via}) · message ${m.id}:\n\n${m.body_md}${att}\n`);
    }
  }
  return lines.join('\n');
}

/** Build a server whose tools act as `ctx` — only the tools its scopes allow. */
export function buildMcpServer(ctx: ServerCtx): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: instructions(ctx) });
  /** §R2: does this credential span boards (account token / un-narrowed OAuth grant)? */
  const manyBoards = ctx.boardIds === null || ctx.boardIds === undefined;

  /**
   * §R2 — TOOLS/LIST DESCRIBES THE DIFFERENCE. The static description says
   * what the tool does; this sentence says what THIS credential must pass,
   * so a model reading tools/list never has to guess whether `board` is
   * required. A board token sees the phase-2 descriptions untouched.
   */
  const describe = <N extends McpToolName>(name: N, description: string): string => {
    if (!manyBoards) return description;
    if (!Object.prototype.hasOwnProperty.call(McpToolShapes[name], 'board')) return description;
    return `${description} Your token reaches every board ${isAgentId(ctx.actor) ? 'this agent is' : 'you are'} on, so pass \`board\` (a key from list_boards) unless the call names a ticket key.`;
  };

  const tool = <N extends McpToolName>(
    name: N,
    run: (args: McpToolInput<N>) => Promise<CallToolResult>,
  ) => {
    // Hidden, not just refused: a model never sees a tool it cannot use.
    if (!mcpToolAllowed(name, ctx.scopes)) return;
    const meta = MCP_TOOLS[name];
    server.registerTool(
      name,
      {
        description: describe(name, meta.description),
        inputSchema: McpToolShapes[name] as z.ZodRawShape,
        annotations: {
          readOnlyHint: meta.readOnly,
          destructiveHint: false,
          idempotentHint: meta.readOnly,
          openWorldHint: false,
        },
      },
      (async (raw: unknown) => {
        try {
          if (!mcpToolAllowed(name, ctx.scopes))
            throw errors.forbidden(`This token cannot use ${name}`);
          const parsed = McpToolSchemas[name].safeParse(raw ?? {});
          if (!parsed.success)
            throw errors.invalid(
              parsed.error.issues
                .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
                .join('; '),
            );
          return await run(parsed.data);
        } catch (e) {
          return fail(e);
        }
      }) as never,
    );
  };

  // ─── who, where ────────────────────────────────────────────────────────────

  tool('whoami', async () => json(await whoami(ctx)));

  /*
   * §R2: with an account token this is the first call a model should make —
   * the board set is read HERE, per call, so a board you just lost access to
   * is simply not in the answer.
   */
  tool('list_boards', async () => json((await readableBoards(ctx)).map((b) => toPublicBoard(b))));

  tool('get_board', async (a) => json(await boardView(ctx, await requestBoard(ctx, a.board))));

  // ─── reading tickets ───────────────────────────────────────────────────────

  tool('list_my_tickets', async (a) => {
    const board = await requestBoard(ctx, a.board);
    let q = db()
      .collection(paths.tickets(board.id))
      .where('assigneeUids', 'array-contains', ctx.actor)
      .where('state', '==', a.state ?? 'active');
    if (a.stage) q = q.where('stageId', '==', stageId(board, a.stage));
    const tz = a.updated_since ? await actorTz(ctx) : 'UTC';
    const since = a.updated_since
      ? parseWhen(a.updated_since, ctx.now, tz, 'updated_since').at
      : null;
    const snap = await q.get();
    const ts = snap.docs
      .map((d) => withTicketId(board.id, d.id, d.data() as Ticket))
      .filter((t) => since === null || t.updatedAt >= since)
      .sort((x, y) => y.updatedAt - x.updatedAt);
    const page = ts.slice(0, a.limit ?? 50);
    return json({
      now: new Date(ctx.now).toISOString(),
      total: ts.length,
      overdue: ts.filter((t) => t.dueAt !== null && t.dueAt < ctx.now).map((t) => t.key),
      tickets: await briefs(new Map([[board.id, board]]), page),
    });
  });

  tool('search_tickets', async (a) => {
    const limit = a.limit ?? 20;
    const boards = a.board ? [await boardByKey(ctx, a.board)] : await readableBoards(ctx);
    const byId = new Map(boards.map((b) => [b.id, b]));
    const tz = a.due_before || a.updated_since ? await actorTz(ctx) : 'UTC';
    const dueLimit = a.due_before ? parseWhen(a.due_before, ctx.now, tz, 'due_before').at : null;
    const since = a.updated_since
      ? parseWhen(a.updated_since, ctx.now, tz, 'updated_since').at
      : null;
    const state = a.state ?? 'active';

    const assigneeFor = async (b: BoardWithId) => {
      if (!a.assignee) return undefined;
      try {
        return personUid(ctx, b, await boardMembers(b.id), a.assignee);
      } catch (e) {
        if (boards.length === 1) throw e;
        return null; // not on this board: nothing of theirs here
      }
    };
    let found: TicketWithId[] = [];
    if (a.query) {
      found = await searchTicketsIn(ctx, boards, a.query, { limit: limit * 3, state });
    } else {
      for (const b of boards) {
        const who = await assigneeFor(b);
        if (who === null) continue;
        let q = db().collection(paths.tickets(b.id)).where('state', '==', state);
        if (who) q = q.where('assigneeUids', 'array-contains', who);
        const snap = await q.get();
        found.push(...snap.docs.map((d) => withTicketId(b.id, d.id, d.data() as Ticket)));
      }
    }
    const filtered: TicketWithId[] = [];
    for (const t of found) {
      const b = byId.get(t.boardId);
      if (!b) continue;
      if (a.stage) {
        let sid: string;
        try {
          sid = stageId(b, a.stage);
        } catch (e) {
          if (boards.length === 1) throw e;
          continue;
        }
        if (t.stageId !== sid) continue;
      }
      if (a.query && a.assignee) {
        const who = await assigneeFor(b);
        if (!who || !t.assigneeUids.includes(who)) continue;
      }
      if (dueLimit !== null && (t.dueAt === null || t.dueAt >= dueLimit)) continue;
      if (since !== null && t.updatedAt < since) continue;
      filtered.push(t);
    }
    if (!a.query) filtered.sort(byDue);
    return json({ total: filtered.length, tickets: await briefs(byId, filtered.slice(0, limit)) });
  });

  tool('get_ticket', async (a) => {
    const { board, ticket } = await ticketByKey(ctx, a.key);
    return json(await ticketDetail(ctx, board, ticket, a.messages ?? 20));
  });

  tool('get_messages', async (a) => {
    const { board, ticket } = await ticketByKey(ctx, a.key);
    return json(await messagesPage(ctx, board, ticket, { cursor: a.cursor, limit: a.limit ?? 50 }));
  });

  // ─── changing tickets ──────────────────────────────────────────────────────

  tool('create_ticket', async (a) => {
    const board = await requestBoard(ctx, a.board);
    const input: TicketInput & { title: string } = { title: a.title };
    if (a.description !== undefined) input.description_md = a.description;
    if (a.assignees) input.assignees = a.assignees;
    if (a.due) input.due = a.due;
    if (a.priority) input.priority = a.priority;
    if (a.stage) input.stage = a.stage;
    if (a.tags) input.tags = a.tags;
    if (a.fields) input.fields = a.fields;
    return json(await createTicket(ctx, board, input));
  });

  tool('update_ticket', async (a) => {
    // Each kind of change needs its own scope (stage → move, assignees → assign, else update).
    requireScopes(ctx, restPatchScopes(a as Record<string, unknown>));
    const { board, ticket } = await ticketByKey(ctx, a.key);
    const input: TicketInput = {};
    if (a.title !== undefined) input.title = a.title;
    if (a.description !== undefined) input.description_md = a.description;
    if (a.stage !== undefined) input.stage = a.stage;
    if (a.assignees !== undefined) input.assignees = a.assignees;
    if (a.due !== undefined) input.due = a.due;
    if (a.priority !== undefined) input.priority = a.priority;
    if (a.tags !== undefined) input.tags = a.tags;
    if (a.fields !== undefined) input.fields = a.fields;
    return json(await updateTicket(ctx, board, ticket, input));
  });

  tool('move_ticket', async (a) => {
    const { board, ticket } = await ticketByKey(ctx, a.key);
    return json(await updateTicket(ctx, board, ticket, { stage: a.stage }));
  });

  tool('assign_ticket', async (a) => {
    const { board, ticket } = await ticketByKey(ctx, a.key);
    return json(await assignTicket(ctx, board, ticket, a.add, a.remove));
  });

  tool('link_tickets', async (a) => json(await addLink(ctx, a.from, a.to, a.type)));

  // ─── the thread and its files ──────────────────────────────────────────────

  tool('post_message', async (a) => {
    const { board, ticket } = await ticketByKey(ctx, a.key);
    return json(
      await postMessage(ctx, board, ticket, {
        markdown: a.markdown,
        fileIds: a.attachments,
        memoryFiles: a.memory_files,
        replyTo: a.reply_to,
        run: a.run,
      }),
    );
  });

  tool('upload_file', async (a) => {
    const { board, ticket } = await ticketByKey(ctx, a.key);
    const file = await storeTicketUpload(ctx, board, ticket, {
      name: a.name,
      mime: a.mime,
      bytes: uploadBytes(a),
    });
    const [members, signed] = await Promise.all([
      boardMembers(board.id),
      signedUrl(file.path, ctx.now),
    ]);
    return json({
      fileId: file.id,
      file_id: file.id,
      ...toPublicFile(ticket.key, file, members, signed),
    });
  });

  tool('read_file', async (a) => json(await readFile(ctx, a.fileId, 'auto')));

  // ─── the inbox ─────────────────────────────────────────────────────────────

  tool('get_events', async (a) => {
    const page = await eventsPage(ctx, { cursor: a.cursor, limit: a.limit ?? 50 });
    const { cursors: _cursors, ...out } = page;
    return json(out);
  });

  tool('ack_events', async (a) =>
    json(await ackEvents(ctx, a.ids ? { ids: a.ids } : { upTo: a.upTo })),
  );

  // ─── phase 3 (§L): questions, task lists, heartbeat ────────────────────────

  /*
   * These tools are registered exactly like the others, so a credential
   * without questions:write / tasklists:write / status:write never sees them
   * in tools/list (mcpToolAllowed, above). There is no answer_question tool
   * on purpose: a PERSON answers, in the app (§L1).
   */
  tool('ask_question', async (a) => {
    const { board, ticket } = await ticketByKey(ctx, a.key);
    // 'fri', '2026-09-24' or an ISO instant — the same date grammar as due dates.
    const expires = a.expires_at
      ? parseWhen(a.expires_at, ctx.now, await actorTz(ctx), 'expires_at').at
      : undefined;
    return json(
      await askQuestion(ctx, board, ticket, {
        title: a.title,
        body_markdown: a.body,
        fields: a.fields,
        allow_comment: a.allow_comment,
        to: a.to,
        blocking: a.blocking,
        expires_at: expires,
      }),
    );
  });

  tool('get_question', async (a) => json(await getQuestion(ctx, a.id)));

  tool('cancel_question', async (a) => json(await cancelQuestion(ctx, a.id)));

  tool('set_tasklist', async (a) => {
    const { board, ticket } = await ticketByKey(ctx, a.key);
    return json(
      await setTasklist(ctx, board, ticket, a.list_id, {
        title: a.title,
        items: a.items,
        ...(a.position !== undefined ? { position: a.position } : {}),
        ...(a.closed !== undefined ? { closed: a.closed } : {}),
      }),
    );
  });

  tool('update_task_item', async (a) => {
    const { board, ticket } = await ticketByKey(ctx, a.key);
    return json(
      await updateTaskItem(ctx, board, ticket, a.list_id, a.item_id, {
        status: a.status,
        note: a.note,
      }),
    );
  });

  tool('delete_tasklist', async (a) => {
    const { board, ticket } = await ticketByKey(ctx, a.key);
    return json(await deleteTasklist(ctx, board, ticket, a.list_id));
  });

  tool('heartbeat', async (a) => {
    const board = await requestBoard(ctx, a.board);
    return json(
      await heartbeat(ctx, board, {
        ticket: a.ticket,
        state: a.state,
        message: a.message,
        progress: a.progress,
      }),
    );
  });

  // ─── artifacts (docs/plan/artifacts.html §C2) ──────────────────────────────

  /*
   * Registered like every other tool: a credential without artifacts:read /
   * artifacts:write never sees them. They are the same commands the app and
   * REST use; what the credential REACHES is decided per call from each
   * artifact's own access map (an agent: only the artifacts it was added to).
   * artifact_publish takes FILES, not a zip (§C2) — a hand-written page
   * straight from a chat; a framework build goes through the SDK or REST.
   */
  tool('artifact_list', async () => json(await listArtifacts(ctx)));

  tool('artifact_get', async (a) => json(await artifactDetail(ctx, a.id)));

  tool('artifact_create', async (a) => {
    const res = await invoke(
      'artifactCreate',
      {
        name: a.name,
        ...(a.description !== undefined ? { description: a.description } : {}),
        ...(a.icon !== undefined ? { icon: a.icon } : {}),
      },
      ctx,
    );
    return json(await artifactView(ctx, res.artifactId));
  });

  tool('artifact_publish', async (a) => {
    const res = await invoke(
      'artifactPublish',
      {
        artifactId: a.id,
        files: a.files.map((f) => ({
          path: f.path,
          content: f.content,
          encoding: f.encoding ?? 'utf8',
        })),
        ...(a.message ? { message: a.message } : {}),
      },
      ctx,
    );
    return json({
      ...(await buildView(ctx, a.id, res.buildId)),
      url: (await artifactView(ctx, a.id)).url,
    });
  });

  tool('artifact_rollback', async (a) => {
    await invoke('artifactSetCurrent', { artifactId: a.id, buildId: a.build }, ctx);
    return json(await artifactView(ctx, a.id));
  });

  tool('artifact_share', async (a) =>
    json(
      await invoke(
        'artifactShare',
        {
          artifactId: a.id,
          ...(a.email !== undefined ? { email: a.email } : {}),
          ...(a.agent !== undefined ? { agentId: a.agent } : {}),
          ...(a.role !== undefined ? { role: a.role } : {}),
          // §AA3: what an agent may do on this artifact — { build, data }.
          ...(a.agent_access !== undefined ? { agentAccess: a.agent_access } : {}),
        },
        ctx,
      ),
    ),
  );

  tool('artifact_source', async (a) => {
    const res = await invoke(
      'artifactSourceUrl',
      {
        artifactId: a.id,
        ...(a.build ? { buildId: a.build } : {}),
      },
      ctx,
    );
    return json({
      url: res.url,
      build: res.buildId,
      expires_at: new Date(res.expiresAt).toISOString(),
    });
  });

  // ─── artifact data (docs/plan/agents.html §AA4) — Firestore only ───────────

  /*
   * The artifact's own database from outside the page: the same functions the
   * REST routes call (platform/artifactData.ts), so who may, where a path
   * lands and what a value means are decided once. An agent needs `data` on
   * the artifact (read for get / list, write for set / batch); RTDB and files
   * are REST and SDK only.
   */
  tool('artifact_data_get', async (a) => json(await dataGet(ctx, a.id, a.path)));

  tool('artifact_data_list', async (a) => {
    const orderBy = a.order_by === undefined ? undefined : parseOrderByParam(a.order_by);
    if (orderBy === null)
      throw errors.invalid('order_by is "field" or "field,desc"', { field: 'order_by' });
    const q = ArtifactDataQuerySchema.safeParse({
      ...(a.where?.length ? { where: a.where } : {}),
      ...(orderBy ? { orderBy } : {}),
      ...(a.limit !== undefined ? { limit: a.limit } : {}),
      ...(a.start_after !== undefined ? { startAfter: a.start_after } : {}),
    });
    if (!q.success)
      throw errors.invalid(
        q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    return json(await dataList(ctx, a.id, a.path, q.data));
  });

  tool('artifact_data_set', async (a) =>
    json(await dataSet(ctx, a.id, a.path, a.data, a.merge === true)),
  );

  tool('artifact_data_batch', async (a) => json(await dataBatch(ctx, a.id, a.writes)));

  // ─── resources ─────────────────────────────────────────────────────────────

  const resourceGuard = (scopes: readonly Scope[]) => requireScope(ctx, scopes);

  server.registerResource(
    'ticket',
    new ResourceTemplate(MCP_RESOURCES.ticket, { list: undefined }),
    {
      title: 'Ticket',
      description: 'A ticket with its thread, as Markdown',
      mimeType: 'text/markdown',
    },
    async (uri, vars) => {
      resourceGuard(['tickets:read']);
      const { board, ticket } = await ticketByKey(ctx, String(vars.key));
      const d = await ticketDetail(ctx, board, ticket, 50);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: ticketMarkdown(d, d.messages ?? [], d.files),
          },
        ],
      };
    },
  );

  const readFileResource = async (uri: string, fileId: string) => {
    resourceGuard(['files:read']);
    const f = await readFile(ctx, fileId, 'auto');
    if (f.content !== undefined) return { contents: [{ uri, mimeType: f.mime, text: f.content }] };
    const { content: _c, ...meta } = f;
    return {
      contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(meta, null, 2) }],
    };
  };
  server.registerResource(
    'file',
    new ResourceTemplate(MCP_RESOURCES.file, { list: undefined }),
    {
      title: 'File',
      description:
        'A file on a ticket: its text (Markdown, HTML, text, CSV, JSON, code) or a download link',
    },
    async (uri, vars) => readFileResource(uri.href, String(vars.fileId)),
  );

  const schemaOf = async (uri: URL, key?: string) => {
    resourceGuard(['board:read']);
    const board = key ? await boardByKey(ctx, key) : await requestBoard(ctx);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await boardView(ctx, board), null, 2),
        },
      ],
    };
  };
  server.registerResource(
    'board-schema',
    MCP_RESOURCES.boardSchema,
    {
      title: 'Board schema',
      description: "Your board's stages, priorities, tags, fields and members",
      mimeType: 'application/json',
    },
    async (uri) => schemaOf(uri),
  );
  server.registerResource(
    'board-schema-by-key',
    new ResourceTemplate(MCP_RESOURCES.boardSchemaByKey, {
      list: async () => {
        const boards = mcpToolAllowed('list_boards', ctx.scopes) ? await readableBoards(ctx) : [];
        return {
          resources: boards.map((b) => ({
            uri: `board://${b.key}/schema`,
            name: `${b.key} schema`,
            description: `Stages and fields of ${b.name}`,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'Board schema (by key)',
      description: "A board's stages, priorities, tags and fields",
      mimeType: 'application/json',
    },
    async (uri, vars) => schemaOf(uri, String(vars.key)),
  );

  /*
   * file://{fileId} READ FROM THE RAW STRING. The SDK matches resource URIs
   * after `new URL(uri)`, and 'file:' is a WHATWG special scheme: the host is
   * lower-cased and a '/' appended — 'file://AbC' arrives as 'file://abc/',
   * and file ids are case-sensitive. So resources/read answers file:// (and
   * the path form file:///{fileId}) from the uri as sent, and hands every
   * other uri to the SDK's own handler. (Reaches into the SDK's handler map;
   * pinned by the agent-api emu test.)
   */
  const handlers = (
    server.server as unknown as {
      _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    }
  )._requestHandlers;
  const sdkRead = handlers?.get('resources/read');
  if (sdkRead) {
    server.server.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
      const m = /^file:\/\/\/?([A-Za-z0-9_-]{1,128})\/?$/.exec(req.params.uri);
      if (m) return readFileResource(req.params.uri, m[1]!);
      return sdkRead(req, extra) as never;
    });
  }

  // ─── prompts ───────────────────────────────────────────────────────────────
  server.registerPrompt(
    'triage_board',
    {
      description: 'Triage the untriaged tickets on a board.',
      argsSchema: { board: z.string().optional().describe("Board key, e.g. 'ENG'") },
    },
    ({ board }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Triage board ${board ?? '(your board)'}. Read its schema with get_board, then search_tickets on it for tickets ` +
              'in its first stage, oldest first. For each: suggest a priority, an assignee (the members in get_board) and ' +
              'whether it duplicates another ticket (link_tickets duplicates). Ask me before changing anything.',
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    'standup_summary',
    {
      description: 'A standup summary of my work.',
      argsSchema: { board: z.string().optional().describe('Limit to one board key') },
    },
    ({ board }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Write my standup${board ? ` for board ${board}` : ''}. Use list_my_tickets for what is on my plate (call out ` +
              'anything overdue), and get_ticket on the ones that moved recently to say what changed. Three short sections: ' +
              'Done, Doing, Blocked.',
          },
        },
      ],
    }),
  );

  // Everything else the app can do: every command, and the app's own reads.
  registerAppTools(server, ctx);
  // The app's UI inside the chat (MCP Apps): board, ticket, my work.
  registerUiTools(server, ctx, briefs);

  return server;
}

// ─── the door ────────────────────────────────────────────────────────────────

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers':
    'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id',
  'access-control-max-age': '600',
};

const mcp = door('mcp');
mcp.options('*', (c) => c.body(null, 204, CORS));
mcp.use('*', tokenAuth({ oauthVia: 'mcp', apiKeys: true, apiKeyVia: 'mcp', resourcePath: '/mcp' }));

mcp.post('/', async (c) => {
  const server = buildMcpServer(c.get('ctx'));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(c.req.raw);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    const body = await res.text(); // JSON mode: the whole answer is ready; close before returning
    return new Response(body || null, { status: res.status, headers });
  } catch (e) {
    if (isAppError(e)) throw e;
    console.error('[mcp] transport error', e);
    throw e;
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

const notAllowed = (c: Context<AppEnv>) =>
  c.json(
    {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this server is stateless (POST only)' },
      id: null,
    },
    405,
    { ...CORS, allow: 'POST, OPTIONS' },
  );
mcp.get('/', notAllowed);
mcp.delete('/', notAllowed);
