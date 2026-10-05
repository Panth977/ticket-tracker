/**
 * REST /v1 — phase 2 (docs/plan/agents.html §F): the API an orchestrator
 * (or the agent it runs) drives a board with, using a BOARD TOKEN that acts
 * as a person or as one of their agents. OAuth access tokens work too.
 *
 *   route → scope gate (REST_ROUTES) → zod parse → names to ids (resolve.ts)
 *         → THE SAME COMMAND the app calls (ops.invoke) → toPublic
 *
 * EVERY WRITE HERE IS A COMMAND THE APP ALSO USES; there is no API-only path
 * to drift (uploads store the blob the app would have uploaded itself, see
 * platform/uploads.ts). What a token may do is its scopes ∩ can() for the
 * principal it acts as — the scope gate here only answers early; the command
 * decides. Idempotency-Key on every POST; errors are RFC 9457 problem+json;
 * lists use an opaque cursor. OpenAPI 3.1 at /v1/openapi.json.
 *
 * Board resolution: a board token has exactly one board, so /v1/board and
 * /v1/tickets need no board parameter; credentials that span several boards
 * — OAuth grants and §R2 ACCOUNT TOKENS — name one, either as ?board= /
 * body.board or IN THE PATH (/v1/boards/ENG/tickets). Tickets addressed by
 * KEY carry their board either way. Board tokens are unchanged: naming their
 * own board is fine, naming another is a 404.
 *
 * Public (no bearer): /v1/openapi.json, and /v1/intake* which has its own
 * slug + secret middleware (platform/intake.ts).
 */
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { z } from 'zod';
import {
  errors,
  MAX_API_UPLOAD_BYTES,
  paths,
  ARTIFACT_SOURCE_MAX_BYTES,
  ARTIFACT_ZIP_MAX_BYTES,
  REST_BUILD_FIELD,
  REST_ROUTES,
  REST_SOURCE_FIELD,
  REST_UPLOAD_FIELD,
  ARTIFACT_UPLOAD_MAX_BYTES,
  ArtifactDataQuerySchema,
  parseOrderByParam,
  parseWhereParam,
  RestArtifactAccessBodySchema,
  RestArtifactDataBatchBodySchema,
  RestArtifactDataListQuerySchema,
  RestArtifactFilesQuerySchema,
  RestMemoryFileQuerySchema,
  RestMemoryListQuerySchema,
  RestMemoryTreeQuerySchema,
  RestArtifactSourceQuerySchema,
  RestCreateArtifactBodySchema,
  RestPatchArtifactBodySchema,
  RestPublishQuerySchema,
  restPatchScopes,
  RestAckBodySchema,
  RestAskQuestionBodySchema,
  RestAssigneesBodySchema,
  RestBoardAgentBodySchema,
  RestBoardQuerySchema,
  RestCreateAgentBodySchema,
  RestCreateBoardBodySchema,
  RestCreateTicketBodySchema,
  RestEventsQuerySchema,
  RestGetFileQuerySchema,
  RestGetTicketQuerySchema,
  RestHeartbeatBodySchema,
  RestListTicketsQuerySchema,
  RestMessagesQuerySchema,
  RestMoveBodySchema,
  RestPatchTicketBodySchema,
  RestPostMessageBodySchema,
  RestAggregatesQuerySchema,
  RestSearchQuerySchema,
  RestSetTasklistBodySchema,
  RestStateBodySchema,
  RestUpdateTaskItemBodySchema,
  RestUploadJsonBodySchema,
  RestWebhookBodySchema,
  SSE_EVENT,
  SSE_PING,
  SSE_PING_MS,
  type BoardWithId,
  type Webhook,
} from '@tm/shared';
import { can } from '@tm/shared/logic/index';
import type { AppEnv } from '../http/env.js';
import { door } from '../http/mounts.js';
import { requireScope, requireScopes, tokenAuth } from '../platform/auth.js';
import { registerIntakeRoutes } from '../platform/intake.js';
import { openApiDocument } from '../platform/openapi.js';
import {
  createTicket,
  idemKey,
  invoke,
  listTickets,
  searchTicketsIn,
  updateTicket,
  type TicketInput,
} from '../platform/ops.js';
import {
  agentStatuses,
  askQuestion,
  cancelQuestion,
  deleteTasklist,
  getQuestion,
  heartbeat,
  listTasklists,
  questionExpiry,
  setTasklist,
  updateTaskItem,
} from '../platform/phase3.js';
import { boardMembers, toPublicBoard, toPublicFile } from '../platform/public.js';
import { boardByKey, readableBoards, requestBoard, ticketByKey } from '../platform/resolve.js';
import { memoryRawPut } from '../memory/files.js';
import { storeTicketUpload, uploadBytes } from '../platform/uploads.js';
import {
  ackEvents,
  assignTicket,
  boardView,
  eventsPage,
  listTicketFiles,
  messagesPage,
  postMessage,
  aggregateBuckets,
  readFile,
  setTicketState,
  signedUrl,
  ticketDetail,
  whoami,
} from '../platform/v1.js';
import { registerFileAccessRoutes } from '../platform/fileAccess.js';
import { createAgent, createBoard, setBoardAgent } from '../platform/account.js';
import { artifactDetail, artifactView, listArtifacts, publishZip } from '../platform/artifacts.js';
import {
  dataAdd,
  dataBatch,
  dataDelete,
  dataGet,
  dataList,
  dataSet,
  dataUpdate,
  fileDelete,
  filesList,
  fileUpload,
  fileUrl,
  isDocumentPath,
  rtdbGet,
  rtdbPush,
  rtdbRemove,
  rtdbSet,
  rtdbUpdate,
} from '../platform/artifactData.js';
import { liveCredential } from '../platform/live.js';
import { toRestWebhook } from '../platform/webhooks.js';
import type { ServerCtx } from '../runtime/context.js';
import { db } from '../runtime/firebase.js';
import { invalidFromZod } from '../runtime/runner.js';
import '../platform/intakeUpsert.js';

/** Resource JSON bodies are small; uploads have their own limit. */
const MAX_BODY_BYTES = 1024 * 1024;
/** A JSON upload carries base64 (4/3 of the bytes) plus a little JSON. */
const MAX_UPLOAD_BODY_BYTES = Math.ceil((MAX_API_UPLOAD_BYTES * 4) / 3) + 64 * 1024;
/**
 * One SSE connection lives this long, then ends; EventSource (and any SSE
 * client) reconnects with Last-Event-ID. Kept under the api function's 60 s
 * timeout so a stream always ends cleanly rather than being cut.
 */
export const SSE_STREAM_MAX_MS = 50_000;
/** How often an open stream looks for new events. */
export const SSE_POLL_MS = 2_000;

const v1 = door('v1');

// The APP's bytes door (/api/files/url, /api/files/blob — platform/fileAccess.ts).
// It is registered from here because doors/ modules are what the runtime
// autoloads, and the /api door module itself belongs to another step.
registerFileAccessRoutes();

// ─── public routes (before the bearer middleware) ────────────────────────────

v1.get('/openapi.json', (c) => c.json(openApiDocument(c)));
registerIntakeRoutes(v1);

const PUBLIC = /^\/v1\/(openapi\.json|intake(\/.*)?)$/;
const bearerAuth = tokenAuth({
  oauthVia: 'integration',
  apiKeys: true,
  apiKeyVia: 'api',
  resourcePath: '/v1',
});
v1.use('*', async (c, next) => (PUBLIC.test(c.req.path) ? next() : bearerAuth(c, next)));

// ─── helpers ─────────────────────────────────────────────────────────────────

type C = Context<AppEnv>;

/** The route's scope gate from the shared REST_ROUTES table (any of its scopes). */
function gate(c: C, method: string, path: string): ServerCtx {
  const ctx = c.get('ctx');
  const r = REST_ROUTES.find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`rest: ${method} ${path} is not in REST_ROUTES`);
  requireScope(ctx, r.scopes);
  return ctx;
}

async function readText(c: C, limit: number): Promise<string> {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > limit) throw errors.too_large(`Body over ${Math.round(limit / 1024 / 1024)} MB`);
  const text = await c.req.text();
  if (Buffer.byteLength(text) > limit)
    throw errors.too_large(`Body over ${Math.round(limit / 1024 / 1024)} MB`);
  return text;
}

function parseJson<S extends z.ZodTypeAny>(text: string, schema: S): z.output<S> {
  let json: unknown = {};
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      throw errors.invalid('Body is not valid JSON');
    }
  }
  const r = schema.safeParse(json);
  if (!r.success) throw invalidFromZod(r.error, 'The request body is invalid');
  return r.data;
}

async function body<S extends z.ZodTypeAny>(c: C, schema: S): Promise<z.output<S>> {
  return parseJson(await readText(c, MAX_BODY_BYTES), schema);
}

function query<S extends z.ZodTypeAny>(c: C, schema: S): z.output<S> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw invalidFromZod(r.error, 'The query string is invalid');
  return r.data;
}

const idem = (c: C) => idemKey(c.req.header('idempotency-key'));

/** REST ticket body (snake_case, ISO) → the shared door input. */
function ticketInput(b: Partial<z.output<typeof RestPatchTicketBodySchema>>): TicketInput {
  const { due_at, links, ...rest } = b;
  const out: TicketInput = { ...rest };
  if (due_at !== undefined) out.due = due_at;
  if (links !== undefined) out.links = links.map((l) => ({ type: l.type, key: l.key }));
  return out;
}

// ─── me, board ───────────────────────────────────────────────────────────────

v1.get('/me', async (c) => c.json(await whoami(gate(c, 'GET', '/v1/me'))));

v1.get('/board', async (c) => {
  const ctx = gate(c, 'GET', '/v1/board');
  const q = query(c, RestBoardQuerySchema);
  return c.json(await boardView(ctx, await requestBoard(ctx, q.board)));
});

/**
 * §R2 — with an account token this is the FIRST call: every board you are on
 * right now. The set is read per request, so it is never stale.
 */
v1.get('/boards', async (c) => {
  const ctx = gate(c, 'GET', '/v1/boards');
  const boards = await readableBoards(ctx);
  return c.json({ data: boards.map((b) => toPublicBoard(b)), next_cursor: null });
});

/*
 * THE BOARD IN THE PATH (§R2). /v1/boards/{KEY}/… is the same handler as the
 * unnested route with ?board={KEY}: one implementation, two spellings, so an
 * account token can address a board the way a URL naturally reads. A board
 * token may use these too — requestBoard refuses a key that is not its own.
 */
/*
 * PHASE 17 (§Z2) — THE ACCOUNT-TOKEN ROUTES: what `ws new` calls to set a
 * workspace up. boardCreate, agentCreate and boardAgentSet, exactly as the app
 * calls them; their scopes are account scopes, so a board token is 403 here.
 */
v1.post('/boards', async (c) => {
  const ctx = gate(c, 'POST', '/v1/boards');
  const b = await body(c, RestCreateBoardBodySchema);
  const board = await createBoard(ctx, b, idem(c));
  c.header('location', `/v1/boards/${board.key}`);
  return c.json(board, 201);
});

v1.post('/agents', async (c) => {
  const ctx = gate(c, 'POST', '/v1/agents');
  const b = await body(c, RestCreateAgentBodySchema);
  return c.json(await createAgent(ctx, b, idem(c)), 201);
});

v1.post('/boards/:key/agents', async (c) => {
  const ctx = gate(c, 'POST', '/v1/boards/{KEY}/agents');
  const b = await body(c, RestBoardAgentBodySchema);
  const board = await requestBoard(ctx, c.req.param('key'));
  return c.json(await setBoardAgent(ctx, board, b, idem(c)));
});

v1.get('/boards/:key', async (c) => {
  const ctx = gate(c, 'GET', '/v1/boards/{KEY}');
  return c.json(await boardView(ctx, await requestBoard(ctx, c.req.param('key'))));
});

v1.get('/board/aggregates', async (c) => {
  const ctx = gate(c, 'GET', '/v1/board/aggregates');
  const q = query(c, RestAggregatesQuerySchema);
  return c.json(await aggregateBuckets(ctx, await requestBoard(ctx, q.board), q));
});

v1.get('/boards/:key/aggregates', async (c) => {
  const ctx = gate(c, 'GET', '/v1/boards/{KEY}/aggregates');
  const q = query(c, RestAggregatesQuerySchema);
  return c.json(await aggregateBuckets(ctx, await requestBoard(ctx, c.req.param('key')), q));
});

v1.get('/boards/:key/tickets', async (c) => {
  const ctx = gate(c, 'GET', '/v1/boards/{KEY}/tickets');
  return c.json(await ticketsPage(ctx, await requestBoard(ctx, c.req.param('key')), c));
});

v1.post('/boards/:key/tickets', async (c) => {
  const ctx = gate(c, 'POST', '/v1/boards/{KEY}/tickets');
  const b = await body(c, RestCreateTicketBodySchema);
  const { board: boardParam, ...rest } = b;
  if (boardParam && boardParam.trim().toUpperCase() !== c.req.param('key').trim().toUpperCase())
    throw errors.invalid('The board in the path and in the body disagree', { field: 'board' });
  return newTicket(c, ctx, await requestBoard(ctx, c.req.param('key')), rest);
});

// ─── tickets ─────────────────────────────────────────────────────────────────

/** GET /v1/tickets and GET /v1/boards/{KEY}/tickets share this body. */
async function ticketsPage(ctx: ServerCtx, board: BoardWithId, c: C) {
  const q = query(c, RestListTicketsQuerySchema);
  const since = q.updated_since === undefined ? undefined : Date.parse(q.updated_since);
  return listTickets(ctx, board, {
    limit: q.limit,
    ...(q.stage ? { stage: q.stage } : {}),
    ...(q.assignee ? { assignee: q.assignee } : {}),
    ...(q.q ? { q: q.q } : {}),
    ...(since !== undefined ? { updatedSince: since } : {}),
    ...(q.state ? { state: q.state } : {}),
    ...(q.cursor ? { cursor: q.cursor } : {}),
  });
}

/** POST /v1/tickets and POST /v1/boards/{KEY}/tickets share this body. */
async function newTicket(
  c: C,
  ctx: ServerCtx,
  board: BoardWithId,
  rest: Omit<z.output<typeof RestCreateTicketBodySchema>, 'board'>,
) {
  const t = await createTicket(ctx, board, { ...ticketInput(rest), title: rest.title }, idem(c));
  c.header('location', `/v1/tickets/${t.key}`);
  return c.json(t, 201);
}

v1.get('/tickets', async (c) => {
  const ctx = gate(c, 'GET', '/v1/tickets');
  const q = query(c, RestListTicketsQuerySchema);
  return c.json(await ticketsPage(ctx, await requestBoard(ctx, q.board), c));
});

v1.post('/tickets', async (c) => {
  const ctx = gate(c, 'POST', '/v1/tickets');
  const b = await body(c, RestCreateTicketBodySchema);
  const { board: boardParam, ...rest } = b;
  const board = await requestBoard(ctx, boardParam ?? c.req.query('board'));
  return newTicket(c, ctx, board, rest);
});

v1.get('/tickets/:key', async (c) => {
  const ctx = gate(c, 'GET', '/v1/tickets/{KEY}');
  const q = query(c, RestGetTicketQuerySchema);
  const { board, ticket } = await ticketByKey(ctx, c.req.param('key'));
  return c.json(await ticketDetail(ctx, board, ticket, q.messages));
});

v1.patch('/tickets/:key', async (c) => {
  const ctx = gate(c, 'PATCH', '/v1/tickets/{KEY}');
  const b = await body(c, RestPatchTicketBodySchema);
  // Every kind of change needs its own scope: stage → move, assignees → assign, else update.
  requireScopes(ctx, restPatchScopes(b));
  const { board, ticket } = await ticketByKey(ctx, c.req.param('key'));
  return c.json(await updateTicket(ctx, board, ticket, ticketInput(b), idem(c)));
});

v1.post('/tickets/:key/move', async (c) => {
  const ctx = gate(c, 'POST', '/v1/tickets/{KEY}/move');
  const b = await body(c, RestMoveBodySchema);
  const { board, ticket } = await ticketByKey(ctx, c.req.param('key'));
  return c.json(await updateTicket(ctx, board, ticket, { stage: b.stage }, idem(c)));
});

v1.post('/tickets/:key/state', async (c) => {
  const ctx = gate(c, 'POST', '/v1/tickets/{KEY}/state');
  const b = await body(c, RestStateBodySchema);
  const { board, ticket } = await ticketByKey(ctx, c.req.param('key'));
  return c.json(await setTicketState(ctx, board, ticket, b.state, idem(c)));
});

v1.post('/tickets/:key/assignees', async (c) => {
  const ctx = gate(c, 'POST', '/v1/tickets/{KEY}/assignees');
  const b = await body(c, RestAssigneesBodySchema);
  const { board, ticket } = await ticketByKey(ctx, c.req.param('key'));
  return c.json(await assignTicket(ctx, board, ticket, b.add, b.remove, idem(c)));
});

// ─── messages ────────────────────────────────────────────────────────────────

v1.get('/tickets/:key/messages', async (c) => {
  const ctx = gate(c, 'GET', '/v1/tickets/{KEY}/messages');
  const q = query(c, RestMessagesQuerySchema);
  const { board, ticket } = await ticketByKey(ctx, c.req.param('key'));
  return c.json(await messagesPage(ctx, board, ticket, q));
});

v1.post('/tickets/:key/messages', async (c) => {
  const ctx = gate(c, 'POST', '/v1/tickets/{KEY}/messages');
  const b = await body(c, RestPostMessageBodySchema);
  const { board, ticket } = await ticketByKey(ctx, c.req.param('key'));
  const m = await postMessage(
    ctx,
    board,
    ticket,
    {
      markdown: b.body_markdown,
      fileIds: b.attachments,
      replyTo: b.reply_to,
      run: b.run,
      agg: b.agg,
      memoryFiles: b.memory_files,
    },
    idem(c),
  );
  return c.json(m, 201);
});

// ─── files ───────────────────────────────────────────────────────────────────

v1.get('/tickets/:key/files', async (c) => {
  const ctx = gate(c, 'GET', '/v1/tickets/{KEY}/files');
  const { board, ticket } = await ticketByKey(ctx, c.req.param('key'));
  return c.json({ data: await listTicketFiles(board, ticket) });
});

/**
 * Upload: multipart/form-data with a "file" part (optional "name" / "mime"
 * fields), or JSON { name, mime?, text | content_base64 }. ≤ 25 MB.
 */
v1.post('/tickets/:key/files', async (c) => {
  const ctx = gate(c, 'POST', '/v1/tickets/{KEY}/files');
  const type = (c.req.header('content-type') ?? '').toLowerCase();
  let input: {
    name: string;
    mime?: string | undefined;
    bytes: Uint8Array;
    memoryId?: string | undefined;
    path?: string | undefined;
  };
  if (type.startsWith('multipart/form-data')) {
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > MAX_API_UPLOAD_BYTES + 64 * 1024)
      throw errors.too_large('Files are limited to 25 MB');
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      throw errors.invalid('Malformed multipart body');
    }
    const part = form.get(REST_UPLOAD_FIELD);
    if (!part || typeof part === 'string')
      throw errors.invalid(`Send the file as a multipart part named "${REST_UPLOAD_FIELD}"`, {
        field: REST_UPLOAD_FIELD,
      });
    const name = (form.get('name') as string | null)?.trim() || part.name || 'file';
    const mime = (form.get('mime') as string | null)?.trim() || part.type || undefined;
    // memory.html §J: optional memory_id / path fields, like the JSON body.
    const field = (k: string) => (form.get(k) as string | null)?.trim() || undefined;
    input = {
      name,
      mime,
      bytes: new Uint8Array(await part.arrayBuffer()),
      memoryId: field('memory_id'),
      path: field('path'),
    };
  } else {
    const b = parseJson(await readText(c, MAX_UPLOAD_BODY_BYTES), RestUploadJsonBodySchema);
    input = {
      name: b.name,
      mime: b.mime,
      bytes: uploadBytes(b),
      memoryId: b.memory_id,
      path: b.path,
    };
  }
  const { board, ticket } = await ticketByKey(ctx, c.req.param('key'));
  const file = await storeTicketUpload(ctx, board, ticket, input, idem(c));
  // The answer carries a signed URL like GET /v1/files/{id}.
  const [members, signed] = await Promise.all([
    boardMembers(board.id),
    signedUrl(file.objectPath, ctx.now),
  ]);
  return c.json({ ...toPublicFile(ticket.key, file, members, signed), file_id: file.id }, 201);
});

v1.get('/files/:fileId', async (c) => {
  const ctx = gate(c, 'GET', '/v1/files/{fileId}');
  const q = query(c, RestGetFileQuerySchema);
  return c.json(await readFile(ctx, c.req.param('fileId'), q.content === true));
});

// ─── phase 3 (§L4): questions, task lists, heartbeat ────────────────────────

/**
 * Ask a question that appears in the thread as a form card. ANSWERING has no
 * route on purpose (§L1): a person answers in the app, because a token that
 * could answer its own question would defeat the point.
 */
v1.post('/tickets/:key/questions', async (c) => {
  const ctx = gate(c, 'POST', '/v1/tickets/{KEY}/questions');
  const b = await body(c, RestAskQuestionBodySchema);
  const { board, ticket } = await ticketByKey(ctx, c.req.param('key'));
  const q = await askQuestion(
    ctx,
    board,
    ticket,
    {
      title: b.title,
      body_markdown: b.body_markdown,
      fields: b.fields,
      allow_comment: b.allow_comment,
      to: b.to,
      blocking: b.blocking,
      expires_at: questionExpiry(b.expires_at),
    },
    idem(c),
  );
  c.header('location', `/v1/questions/${q.id}`);
  return c.json(q, 201);
});

v1.get('/questions/:id', async (c) => {
  const ctx = gate(c, 'GET', '/v1/questions/{id}');
  return c.json(await getQuestion(ctx, c.req.param('id')));
});

v1.post('/questions/:id/cancel', async (c) => {
  const ctx = gate(c, 'POST', '/v1/questions/{id}/cancel');
  return c.json(await cancelQuestion(ctx, c.req.param('id'), idem(c)));
});

v1.get('/tickets/:key/tasklists', async (c) => {
  const ctx = gate(c, 'GET', '/v1/tickets/{KEY}/tasklists');
  const { board, ticket } = await ticketByKey(ctx, c.req.param('key'));
  return c.json({ data: await listTasklists(board, ticket) });
});

/** PUT = create or replace the whole list; the id in the path is the list's. */
v1.put('/tickets/:key/tasklists/:listId', async (c) => {
  const ctx = gate(c, 'PUT', '/v1/tickets/{KEY}/tasklists/{listId}');
  const b = await body(c, RestSetTasklistBodySchema);
  const { board, ticket } = await ticketByKey(ctx, c.req.param('key'));
  return c.json(await setTasklist(ctx, board, ticket, c.req.param('listId'), b, idem(c)));
});

v1.patch('/tickets/:key/tasklists/:listId/items/:itemId', async (c) => {
  const ctx = gate(c, 'PATCH', '/v1/tickets/{KEY}/tasklists/{listId}/items/{itemId}');
  const b = await body(c, RestUpdateTaskItemBodySchema);
  const { board, ticket } = await ticketByKey(ctx, c.req.param('key'));
  return c.json(
    await updateTaskItem(ctx, board, ticket, c.req.param('listId'), c.req.param('itemId'), b),
  );
});

v1.delete('/tickets/:key/tasklists/:listId', async (c) => {
  const ctx = gate(c, 'DELETE', '/v1/tickets/{KEY}/tasklists/{listId}');
  const { board, ticket } = await ticketByKey(ctx, c.req.param('key'));
  return c.json(await deleteTasklist(ctx, board, ticket, c.req.param('listId')));
});

/** A beat a minute while the agent works, and one more when the work ends. */
v1.post('/heartbeat', async (c) => {
  const ctx = gate(c, 'POST', '/v1/heartbeat');
  const b = await body(c, RestHeartbeatBodySchema);
  // §R2: ?board= works here too, so a board-pinned SDK client (which adds the
  // query parameter to every call) needs no special case.
  const board = await requestBoard(ctx, b.board ?? c.req.query('board'));
  return c.json(
    await heartbeat(ctx, board, {
      ticket: b.ticket,
      state: b.state,
      message: b.message,
      progress: b.progress,
    }),
  );
});

v1.get('/agents/status', async (c) => {
  const ctx = gate(c, 'GET', '/v1/agents/status');
  const board = await requestBoard(ctx, c.req.query('board'));
  const ticket = c.req.query('ticket');
  return c.json({ data: await agentStatuses(ctx, board, ticket) });
});

// ─── events: the inbox feed, its SSE stream, ack ────────────────────────────

v1.get('/events', async (c) => {
  const ctx = gate(c, 'GET', '/v1/events');
  const q = query(c, RestEventsQuerySchema);
  return c.json(await eventsPage(ctx, q));
});

/**
 * Server-Sent Events of the same feed: `event: event` (id = the event's
 * cursor, data = PublicEvent JSON) and `event: ping` keep-alives. Resume with
 * Last-Event-ID (sent automatically by EventSource) or ?cursor=.
 */
v1.get('/events/stream', async (c) => {
  const ctx = gate(c, 'GET', '/v1/events/stream');
  const q = query(c, RestEventsQuerySchema);
  let cursor: string | undefined = c.req.header('last-event-id')?.trim() || q.cursor;
  // The first page is read BEFORE the stream opens, so a bad cursor is a plain 400.
  let page = await eventsPage(ctx, { cursor, limit: q.limit, unacked: q.unacked });
  return streamSSE(c, async (stream) => {
    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
    });
    const started = Date.now();
    let lastPing = started;
    await stream.writeSSE({ event: SSE_PING, data: '', retry: 1000 });
    while (!aborted && Date.now() - started < SSE_STREAM_MAX_MS) {
      for (let i = 0; i < page.data.length; i++) {
        const e = page.data[i]!;
        await stream.writeSSE({
          event: SSE_EVENT,
          id: page.cursors[i] ?? e.id,
          data: JSON.stringify(e),
        });
      }
      cursor = page.next_cursor ?? cursor;
      if (!page.has_more) {
        if (Date.now() - lastPing >= SSE_PING_MS) {
          await stream.writeSSE({ event: SSE_PING, data: '' });
          lastPing = Date.now();
        }
        await stream.sleep(SSE_POLL_MS);
      }
      if (aborted) break;
      page = await eventsPage(ctx, { cursor, limit: q.limit, unacked: q.unacked });
    }
  });
});

v1.post('/events/ack', async (c) => {
  const ctx = gate(c, 'POST', '/v1/events/ack');
  const b = await body(c, RestAckBodySchema);
  return c.json(await ackEvents(ctx, 'ids' in b ? { ids: b.ids } : { upTo: b.upTo }));
});

/**
 * §W — THE CHEAP WAY TO WAIT. A short-lived Realtime Database credential for
 * this token; the SDK's tm.watch() streams rev/{board} and the agent's wake
 * node with it and calls REST only when something changed. Never cached:
 * an account token's boards are resolved at this call (§R2).
 */
v1.get('/live', async (c) => {
  const ctx = gate(c, 'GET', '/v1/live');
  c.header('cache-control', 'no-store');
  return c.json(await liveCredential(ctx));
});

// ─── artifacts (docs/plan/artifacts.html §C1) ───────────────────────────────

/*
 * An artifact is not on a board, so none of these resolve one. What the
 * credential reaches is decided per call from the artifact's own access map
 * (artifacts/shared.ts): an account token, what its person owns or edits; an
 * agent token, the artifacts that agent was added to.
 */

/**
 * THE REQUEST SIZE. Cloud Functions refuses a body over 32 MB before we see
 * it; a build zip may be 26 MB and a source zip rides in the same multipart
 * request, so together they must stay under that. Anything larger is a 413
 * here, from the Content-Length, before the body is read.
 */
const MAX_PUBLISH_BODY_BYTES = 31 * 1024 * 1024;

v1.get('/artifacts', async (c) => {
  const ctx = gate(c, 'GET', '/v1/artifacts');
  return c.json({ data: await listArtifacts(ctx), next_cursor: null });
});

v1.post('/artifacts', async (c) => {
  const ctx = gate(c, 'POST', '/v1/artifacts');
  const b = await body(c, RestCreateArtifactBodySchema);
  const res = await invoke(
    'artifactCreate',
    {
      name: b.name,
      ...(b.description !== undefined ? { description: b.description } : {}),
      ...(b.icon !== undefined ? { icon: b.icon } : {}),
      ...(b.indicator !== undefined ? { indicator: b.indicator } : {}),
    },
    ctx,
    idem(c) ?? null,
  );
  c.header('location', `/v1/artifacts/${res.artifactId}`);
  return c.json(await artifactView(ctx, res.artifactId), 201);
});

v1.get('/artifacts/:id', async (c) => {
  const ctx = gate(c, 'GET', '/v1/artifacts/{id}');
  return c.json(await artifactDetail(ctx, c.req.param('id')));
});

v1.patch('/artifacts/:id', async (c) => {
  const ctx = gate(c, 'PATCH', '/v1/artifacts/{id}');
  const b = await body(c, RestPatchArtifactBodySchema);
  const artifactId = c.req.param('id');
  await invoke(
    'artifactUpdate',
    {
      artifactId,
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.description !== undefined ? { description: b.description } : {}),
      ...(b.icon !== undefined ? { icon: b.icon } : {}),
      ...(b.indicator !== undefined ? { indicator: b.indicator } : {}),
      ...(b.read_only !== undefined ? { readOnly: b.read_only } : {}),
      ...(b.archived !== undefined ? { archived: b.archived } : {}),
    },
    ctx,
    null,
  );
  return c.json(await artifactView(ctx, artifactId));
});

v1.delete('/artifacts/:id', async (c) => {
  const ctx = gate(c, 'DELETE', '/v1/artifacts/{id}');
  await invoke('artifactDelete', { artifactId: c.req.param('id') }, ctx, null);
  return c.body(null, 204);
});

/**
 * Publish. The body IS the zip (Content-Type: application/zip — or anything
 * that is not multipart), or multipart/form-data with a "build" part and an
 * optional "source" part. ?message= says what changed.
 */
v1.post('/artifacts/:id/builds', async (c) => {
  const ctx = gate(c, 'POST', '/v1/artifacts/{id}/builds');
  const q = query(c, RestPublishQuerySchema);
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > MAX_PUBLISH_BODY_BYTES)
    throw errors.too_large(
      `A publish request is at most ${Math.floor(MAX_PUBLISH_BODY_BYTES / 1024 / 1024)} MB (build zip ≤ ${ARTIFACT_ZIP_MAX_BYTES / 1024 / 1024} MB)`,
    );
  const type = (c.req.header('content-type') ?? '').toLowerCase();
  let zip: Uint8Array;
  let source: Uint8Array | undefined;
  if (type.startsWith('multipart/form-data')) {
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      throw errors.invalid('Malformed multipart body');
    }
    const build = form.get(REST_BUILD_FIELD);
    if (!build || typeof build === 'string')
      throw errors.invalid(`Send the build zip as a multipart part named "${REST_BUILD_FIELD}"`, {
        field: REST_BUILD_FIELD,
      });
    zip = new Uint8Array(await build.arrayBuffer());
    const src = form.get(REST_SOURCE_FIELD);
    if (src && typeof src !== 'string') source = new Uint8Array(await src.arrayBuffer());
  } else {
    zip = new Uint8Array(await c.req.arrayBuffer());
  }
  if (zip.length > ARTIFACT_ZIP_MAX_BYTES)
    throw errors.too_large(`The build zip is over ${ARTIFACT_ZIP_MAX_BYTES / 1024 / 1024} MB`);
  if (source && source.length > ARTIFACT_SOURCE_MAX_BYTES)
    throw errors.too_large(`The source zip is over ${ARTIFACT_SOURCE_MAX_BYTES / 1024 / 1024} MB`);
  const artifactId = c.req.param('id');
  const b = await publishZip(ctx, artifactId, { zip, source, message: q.message }, idem(c));
  c.header('location', `/v1/artifacts/${artifactId}`);
  return c.json(b, 201);
});

v1.post('/artifacts/:id/builds/:build/current', async (c) => {
  const ctx = gate(c, 'POST', '/v1/artifacts/{id}/builds/{build}/current');
  const artifactId = c.req.param('id');
  await invoke(
    'artifactSetCurrent',
    { artifactId, buildId: c.req.param('build') },
    ctx,
    idem(c) ?? null,
  );
  return c.json(await artifactView(ctx, artifactId));
});

v1.get('/artifacts/:id/source', async (c) => {
  const ctx = gate(c, 'GET', '/v1/artifacts/{id}/source');
  const q = query(c, RestArtifactSourceQuerySchema);
  const res = await invoke(
    'artifactSourceUrl',
    { artifactId: c.req.param('id'), ...(q.build ? { buildId: q.build } : {}) },
    ctx,
    null,
  );
  c.header('cache-control', 'no-store');
  return c.json({
    url: res.url,
    build: res.buildId,
    expires_at: new Date(res.expiresAt).toISOString(),
  });
});

v1.put('/artifacts/:id/access', async (c) => {
  const ctx = gate(c, 'PUT', '/v1/artifacts/{id}/access');
  const b = await body(c, RestArtifactAccessBodySchema);
  return c.json(
    await invoke(
      'artifactShare',
      {
        artifactId: c.req.param('id'),
        ...(b.email !== undefined ? { email: b.email } : {}),
        ...(b.agent !== undefined ? { agentId: b.agent } : {}),
        ...(b.role !== undefined ? { role: b.role } : {}),
        // §AA3: what an agent may do here — { build, data }.
        ...(b.agent_access !== undefined ? { agentAccess: b.agent_access } : {}),
      },
      ctx,
      null,
    ),
  );
});

// ─── artifact data (docs/plan/agents.html §AA4) ─────────────────────────────

/*
 * The artifact's own Firestore, RTDB and files, reached with a token — the
 * same fence the page's driver goes through. The door does three things and
 * no more: the scope gate (REST_ROUTES), turning the rest of the URL and the
 * body into arguments, and the status code. WHO may, WHERE it lands and WHAT a
 * value means are all platform/artifactData.ts.
 *
 * `{path}` is everything after /data/firestore/ (or /rtdb/, /files/), in the
 * artifact's OWN view, percent-decoded as one string and then handed to the
 * fence — so an encoded '/' or '..' is judged as what it decodes to.
 */

/** A document body is ≤ 1 MiB in Firestore; JSON with escapes is a little larger than what is stored. */
const MAX_DATA_DOC_BYTES = 2 * 1024 * 1024;
/** A batch is up to 400 documents; Firestore's own commit ceiling is ~10 MiB. */
const MAX_DATA_BATCH_BYTES = 11 * 1024 * 1024;
/** Cloud Functions refuses a body over 32 MB before we see it; a file is ≤ 25 MB. */
const MAX_FILE_BODY_BYTES = ARTIFACT_UPLOAD_MAX_BYTES;

const DATA_PATH = /\/artifacts\/[^/]+\/data\/(?:firestore|rtdb|files)(?:\/(.*))?$/;
/** The `{path}` of a data route: '' for the root. */
function dataPath(c: C): string {
  const raw = DATA_PATH.exec(c.req.path)?.[1] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    throw errors.invalid('The path is not valid percent-encoding', { field: 'path' });
  }
}

/** The `{id}` of a data route (the routes are registered from a list, so the param is untyped). */
const aid = (c: C): string => c.req.param('id') ?? '';

/** Any JSON value (RTDB bodies may be a number, a string, null …). An empty body is a 400. */
async function jsonValue(c: C, limit: number): Promise<unknown> {
  const text = await readText(c, limit);
  if (!text.trim()) throw errors.invalid('The request has no JSON body');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw errors.invalid('Body is not valid JSON');
  }
}

/** ?where=field,op,value (repeatable) ?order_by=field[,desc] ?limit= ?start_after=docId */
function listQuery(c: C) {
  const q = query(c, RestArtifactDataListQuerySchema);
  const where = (c.req.queries('where') ?? []).map((w) => {
    const parsed = parseWhereParam(w);
    if (!parsed)
      throw errors.invalid(
        `where="${w}" is not field,op,value (op: < <= == != >= > array-contains in not-in array-contains-any)`,
        { field: 'where' },
      );
    return parsed;
  });
  const orderBy = q.order_by === undefined ? undefined : parseOrderByParam(q.order_by);
  if (orderBy === null)
    throw errors.invalid('order_by is "field" or "field,desc"', { field: 'order_by' });
  const r = ArtifactDataQuerySchema.safeParse({
    ...(where.length ? { where } : {}),
    ...(orderBy ? { orderBy } : {}),
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.start_after !== undefined ? { startAfter: q.start_after } : {}),
  });
  if (!r.success) throw invalidFromZod(r.error, 'The query string is invalid');
  return r.data;
}

const FS = '/v1/artifacts/{id}/data/firestore/{path}';
const RT = '/v1/artifacts/{id}/data/rtdb/{path}';
const FILES = '/v1/artifacts/{id}/data/files/{path}';

/** Hono matches '/x/*' for '/x' too, but say both: the root of rtdb is a real address. */
const both = (base: string) => [base, `${base}/*`] as const;

v1.post('/artifacts/:id/data/batch', async (c) => {
  const ctx = gate(c, 'POST', '/v1/artifacts/{id}/data/batch');
  const b = parseJson(await readText(c, MAX_DATA_BATCH_BYTES), RestArtifactDataBatchBodySchema);
  return c.json(await dataBatch(ctx, aid(c), b.writes));
});

for (const route of both('/artifacts/:id/data/firestore')) {
  /** A document (even number of segments) or a collection (odd) — the path says which. */
  v1.get(route, async (c) => {
    const ctx = gate(c, 'GET', FS);
    const path = dataPath(c);
    c.header('cache-control', 'no-store');
    return c.json(
      isDocumentPath(path)
        ? await dataGet(ctx, aid(c), path)
        : await dataList(ctx, aid(c), path, listQuery(c)),
    );
  });

  v1.put(route, async (c) => {
    const ctx = gate(c, 'PUT', FS);
    const q = query(c, RestArtifactDataListQuerySchema);
    const data = await jsonValue(c, MAX_DATA_DOC_BYTES);
    const merge = q.merge === '1' || q.merge === 'true';
    return c.json(await dataSet(ctx, aid(c), dataPath(c), data, merge));
  });

  v1.patch(route, async (c) => {
    const ctx = gate(c, 'PATCH', FS);
    const data = await jsonValue(c, MAX_DATA_DOC_BYTES);
    return c.json(await dataUpdate(ctx, aid(c), dataPath(c), data));
  });

  v1.delete(route, async (c) => {
    const ctx = gate(c, 'DELETE', FS);
    return c.json(await dataDelete(ctx, aid(c), dataPath(c)));
  });

  v1.post(route, async (c) => {
    const ctx = gate(c, 'POST', FS);
    const data = await jsonValue(c, MAX_DATA_DOC_BYTES);
    return c.json(await dataAdd(ctx, aid(c), dataPath(c), data, idem(c)), 201);
  });
}

for (const route of both('/artifacts/:id/data/rtdb')) {
  v1.get(route, async (c) => {
    const ctx = gate(c, 'GET', RT);
    c.header('cache-control', 'no-store');
    return c.json(await rtdbGet(ctx, aid(c), dataPath(c)));
  });

  v1.put(route, async (c) => {
    const ctx = gate(c, 'PUT', RT);
    const value = await jsonValue(c, MAX_DATA_BATCH_BYTES);
    return c.json(await rtdbSet(ctx, aid(c), dataPath(c), value));
  });

  v1.patch(route, async (c) => {
    const ctx = gate(c, 'PATCH', RT);
    const value = await jsonValue(c, MAX_DATA_BATCH_BYTES);
    return c.json(await rtdbUpdate(ctx, aid(c), dataPath(c), value));
  });

  v1.delete(route, async (c) => {
    const ctx = gate(c, 'DELETE', RT);
    return c.json(await rtdbRemove(ctx, aid(c), dataPath(c)));
  });

  v1.post(route, async (c) => {
    const ctx = gate(c, 'POST', RT);
    const value = await jsonValue(c, MAX_DATA_BATCH_BYTES);
    return c.json(await rtdbPush(ctx, aid(c), dataPath(c), value), 201);
  });
}

/** GET …/data/files?prefix= lists; GET …/data/files/{path} is one file's link. */
v1.get('/artifacts/:id/data/files', async (c) => {
  const ctx = gate(c, 'GET', '/v1/artifacts/{id}/data/files');
  const q = query(c, RestArtifactFilesQuerySchema);
  return c.json(await filesList(ctx, aid(c), q.prefix));
});

v1.get('/artifacts/:id/data/files/*', async (c) => {
  const ctx = gate(c, 'GET', FILES);
  c.header('cache-control', 'no-store');
  return c.json(await fileUrl(ctx, aid(c), dataPath(c)));
});

/** The raw body IS the file; Content-Type is kept as the file's type. */
v1.put('/artifacts/:id/data/files/*', async (c) => {
  const ctx = gate(c, 'PUT', FILES);
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > MAX_FILE_BODY_BYTES)
    throw errors.too_large(`A file is at most ${MAX_FILE_BODY_BYTES / 1024 / 1024} MB`);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const file = await fileUpload(ctx, aid(c), dataPath(c), bytes, c.req.header('content-type'));
  return c.json(file, 201);
});

v1.delete('/artifacts/:id/data/files/*', async (c) => {
  const ctx = gate(c, 'DELETE', FILES);
  return c.json(await fileDelete(ctx, aid(c), dataPath(c)));
});

// ─── memory (memory.html §G) ─────────────────────────────────────────────────

const MEM_FILES = '/v1/memories/{id}/files/{path}';
const MEM_PATH = /\/memories\/[^/]+\/files\/(.+)$/;
/** The `{path}` of a memory file route, decoded. */
function memoryFilePath(c: C): string {
  const raw = MEM_PATH.exec(c.req.path)?.[1] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    throw errors.invalid('The path is not valid percent-encoding', { field: 'path' });
  }
}

v1.get('/memories', async (c) => {
  const ctx = gate(c, 'GET', '/v1/memories');
  const q = query(c, RestMemoryListQuerySchema);
  const boardId = q.board ? (await requestBoard(ctx, q.board)).id : undefined;
  c.header('cache-control', 'no-store');
  return c.json(
    await invoke(
      'memoryList',
      { ...(boardId ? { boardId } : {}), ...(q.include_archived ? { includeArchived: true } : {}) },
      ctx,
    ),
  );
});

v1.get('/memories/:id/tree', async (c) => {
  const ctx = gate(c, 'GET', '/v1/memories/{id}/tree');
  const q = query(c, RestMemoryTreeQuerySchema);
  c.header('cache-control', 'no-store');
  return c.json(
    await invoke(
      'memoryTree',
      {
        memoryId: c.req.param('id'),
        ...(q.path ? { path: q.path } : {}),
        ...(q.shallow ? { shallow: true } : {}),
      },
      ctx,
    ),
  );
});

v1.get('/memories/:id/files/*', async (c) => {
  const ctx = gate(c, 'GET', MEM_FILES);
  const q = query(c, RestMemoryFileQuerySchema);
  c.header('cache-control', 'no-store');
  return c.json(
    await invoke(
      'memoryFileRead',
      {
        memoryId: c.req.param('id'),
        path: memoryFilePath(c),
        ...(q.text ? { asText: true } : {}),
      },
      ctx,
    ),
  );
});

/** The raw body IS the file; Content-Type is kept as its type. A new version replaces the old. */
v1.put('/memories/:id/files/*', async (c) => {
  const ctx = gate(c, 'PUT', MEM_FILES);
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > MAX_FILE_BODY_BYTES)
    throw errors.too_large(
      `A file is at most ${MAX_FILE_BODY_BYTES / 1024 / 1024} MB through the API`,
    );
  const memoryId = c.req.param('id');
  const path = memoryFilePath(c);
  return c.json(
    await memoryRawPut(
      ctx,
      memoryId,
      path,
      new Uint8Array(await c.req.arrayBuffer()),
      c.req.header('content-type'),
      MAX_FILE_BODY_BYTES,
    ),
    201,
  );
});

v1.delete('/memories/:id/files/*', async (c) => {
  const ctx = gate(c, 'DELETE', MEM_FILES);
  return c.json(
    await invoke(
      'memoryNodeDelete',
      { memoryId: c.req.param('id'), paths: [memoryFilePath(c)] },
      ctx,
    ),
  );
});

// ─── search ──────────────────────────────────────────────────────────────────

v1.get('/search', async (c) => {
  const ctx = gate(c, 'GET', '/v1/search');
  const q = query(c, RestSearchQuerySchema);
  const boards = q.board ? [await boardByKey(ctx, q.board)] : await readableBoards(ctx);
  const byId = new Map(boards.map((b) => [b.id, b]));
  const ts = await searchTicketsIn(ctx, boards, q.q, { limit: q.limit });
  return c.json({
    data: ts.map((t) => ({
      id: t.id,
      key: t.key,
      title: t.title,
      board_key: byId.get(t.boardId)?.key ?? '',
      state: t.state,
    })),
  });
});

// ─── webhooks ────────────────────────────────────────────────────────────────

/** Boards whose webhooks the caller may manage. */
async function adminBoards(ctx: ServerCtx, key?: string): Promise<BoardWithId[]> {
  const boards = key
    ? [await boardByKey(ctx, key)]
    : await readableBoards(ctx, { includeArchived: true });
  return boards.filter((b) => can(ctx, b, 'admin'));
}

async function findWebhook(ctx: ServerCtx, id: string) {
  if (!id || id.includes('/')) throw errors.not_found('Webhook not found');
  const boards = await adminBoards(ctx);
  if (!boards.length) throw errors.not_found('Webhook not found');
  const snaps = await db().getAll(...boards.map((b) => db().doc(paths.webhook(b.id, id))));
  const i = snaps.findIndex((s) => s.exists);
  if (i < 0) throw errors.not_found('Webhook not found');
  return { board: boards[i]!, hook: snaps[i]!.data() as Webhook };
}

v1.get('/webhooks', async (c) => {
  const ctx = gate(c, 'GET', '/v1/webhooks');
  const boards = await adminBoards(ctx, c.req.query('board'));
  const rows = await Promise.all(
    boards.map(async (b) => {
      const s = await db().collection(paths.webhooks(b.id)).get();
      return s.docs.map((d) => toRestWebhook(b.key, d.id, d.data() as Webhook));
    }),
  );
  return c.json({ data: rows.flat(), next_cursor: null });
});

v1.post('/webhooks', async (c) => {
  const ctx = gate(c, 'POST', '/v1/webhooks');
  const b = await body(c, RestWebhookBodySchema);
  const board = await boardByKey(ctx, b.board);
  const res = await invoke(
    'webhookUpsert',
    {
      boardId: board.id,
      url: b.url,
      events: b.events,
      ...(b.active !== undefined ? { active: b.active } : {}),
    },
    ctx,
    idem(c) ?? null,
  );
  const hook = (await db().doc(paths.webhook(board.id, res.webhookId)).get()).data() as Webhook;
  return c.json(
    { ...toRestWebhook(board.key, res.webhookId, hook), secret: res.secret, ping: res.ping },
    201,
  );
});

v1.patch('/webhooks/:id', async (c) => {
  const ctx = gate(c, 'PATCH', '/v1/webhooks/{id}');
  const b = await body(c, RestWebhookBodySchema.partial());
  const { board, hook } = await findWebhook(ctx, c.req.param('id'));
  if (b.board && (await boardByKey(ctx, b.board)).id !== board.id)
    throw errors.invalid('A webhook cannot move to another board', { field: 'board' });
  const res = await invoke(
    'webhookUpsert',
    {
      boardId: board.id,
      webhookId: c.req.param('id'),
      url: b.url ?? hook.url,
      events: b.events ?? hook.events,
      ...(b.active !== undefined ? { active: b.active } : {}),
      ...(b.rotate_secret ? { rotateSecret: true as const } : {}),
    },
    ctx,
    null,
  );
  const fresh = (await db().doc(paths.webhook(board.id, res.webhookId)).get()).data() as Webhook;
  return c.json({
    ...toRestWebhook(board.key, res.webhookId, fresh),
    secret: res.secret,
    ping: res.ping,
  });
});

v1.delete('/webhooks/:id', async (c) => {
  const ctx = gate(c, 'DELETE', '/v1/webhooks/{id}');
  const { board } = await findWebhook(ctx, c.req.param('id'));
  await invoke('webhookDelete', { boardId: board.id, webhookId: c.req.param('id') }, ctx, null);
  return c.body(null, 204);
});
