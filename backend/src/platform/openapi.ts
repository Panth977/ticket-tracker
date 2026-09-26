/**
 * OpenAPI 3.1 for /v1, GENERATED FROM THE SAME ZOD SCHEMAS the routes parse
 * with (shared/src/api/rest.ts) — the document cannot drift from the code.
 * Route list and scopes come from REST_ROUTES.
 */
import type { Context } from 'hono';
import type { z } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import {
  IDEMPOTENCY_HEADER,
  IntakeSchemaResSchema,
  IntakeSubmitReqSchema,
  IntakeSubmitResSchema,
  INTAKE_HEADERS,
  MAX_API_UPLOAD_BYTES,
  ProblemSchema,
  PublicAgentSchema,
  PublicAgentStatusSchema,
  PublicBoardSchema,
  PublicEventSchema,
  PublicFileSchema,
  PublicQuestionSchema,
  PublicTasklistSchema,
  PublicMessageSchema,
  PublicTicketSchema,
  REST_ROUTES,
  REST_UPLOAD_FIELD,
  RestAckBodySchema,
  RestAckResSchema,
  RestAgentStatusListResSchema,
  RestAskQuestionBodySchema,
  RestAssigneesBodySchema,
  RestBoardAgentBodySchema,
  RestBoardListResSchema,
  RestCreateAgentBodySchema,
  RestCreateBoardBodySchema,
  RestLiveResSchema,
  RestOkResSchema,
  RestBoardQuerySchema,
  RestBoardResSchema,
  RestCreateTicketBodySchema,
  RestDeletedResSchema,
  RestEventListResSchema,
  RestEventsQuerySchema,
  RestFileListResSchema,
  RestFileResSchema,
  RestGetFileQuerySchema,
  RestGetTicketQuerySchema,
  RestHeartbeatBodySchema,
  RestListTicketsQuerySchema,
  RestMeResSchema,
  RestMessageListResSchema,
  RestMessagesQuerySchema,
  RestMoveBodySchema,
  RestPatchTicketBodySchema,
  RestPostMessageBodySchema,
  RestSearchQuerySchema,
  RestSearchResSchema,
  RestSetTasklistBodySchema,
  RestStateBodySchema,
  RestTasklistListResSchema,
  RestUpdateTaskItemBodySchema,
  RestTicketDetailResSchema,
  RestTicketListResSchema,
  RestUploadJsonBodySchema,
  RestUploadResSchema,
  RestWebhookBodySchema,
  RestWebhookListResSchema,
  RestWebhookUpsertResSchema,
  RestWebhookSchema,
  SCOPES,
  SCOPE_LABELS,
  SSE_EVENT,
  SSE_PING,
} from '@tm/shared';
import { apiBaseUrl } from './auth.js';

type Json = Record<string, unknown>;

function schema(s: z.ZodTypeAny): Json {
  const out = toJsonSchemaCompat(s as never, { target: 'draft-2020-12' }) as Json;
  delete out.$schema;
  return out;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const COMPONENTS: Record<string, z.ZodTypeAny> = {
  Problem: ProblemSchema,
  Me: RestMeResSchema,
  Board: RestBoardResSchema,
  BoardList: RestBoardListResSchema,
  // phase 17 (§Z2, §W)
  CreateBoard: RestCreateBoardBodySchema,
  CreatedBoard: PublicBoardSchema,
  Agent: PublicAgentSchema,
  CreateAgent: RestCreateAgentBodySchema,
  BoardAgent: RestBoardAgentBodySchema,
  Ok: RestOkResSchema,
  Live: RestLiveResSchema,
  Ticket: PublicTicketSchema,
  TicketDetail: RestTicketDetailResSchema,
  TicketList: RestTicketListResSchema,
  CreateTicket: RestCreateTicketBodySchema,
  PatchTicket: RestPatchTicketBodySchema,
  Move: RestMoveBodySchema,
  State: RestStateBodySchema,
  Assignees: RestAssigneesBodySchema,
  Message: PublicMessageSchema,
  MessageList: RestMessageListResSchema,
  PostMessage: RestPostMessageBodySchema,
  File: PublicFileSchema,
  FileList: RestFileListResSchema,
  FileWithContent: RestFileResSchema,
  UploadJson: RestUploadJsonBodySchema,
  Uploaded: RestUploadResSchema,
  Event: PublicEventSchema,
  // phase 3 (§L4)
  Question: PublicQuestionSchema,
  AskQuestion: RestAskQuestionBodySchema,
  Tasklist: PublicTasklistSchema,
  TasklistList: RestTasklistListResSchema,
  SetTasklist: RestSetTasklistBodySchema,
  UpdateTaskItem: RestUpdateTaskItemBodySchema,
  Deleted: RestDeletedResSchema,
  Heartbeat: RestHeartbeatBodySchema,
  AgentStatus: PublicAgentStatusSchema,
  AgentStatusList: RestAgentStatusListResSchema,
  EventList: RestEventListResSchema,
  Ack: RestAckBodySchema,
  Acked: RestAckResSchema,
  SearchResults: RestSearchResSchema,
  Webhook: RestWebhookSchema,
  WebhookList: RestWebhookListResSchema,
  WebhookBody: RestWebhookBodySchema,
  WebhookSaved: RestWebhookUpsertResSchema,
  IntakeSubmit: IntakeSubmitReqSchema,
  IntakeCreated: IntakeSubmitResSchema,
  IntakeSchema: IntakeSchemaResSchema,
};

interface RouteIO {
  query?: z.AnyZodObject;
  body?: string;
  /** Also accepts multipart/form-data with a file part (uploads). */
  multipart?: boolean;
  res: string;
  status?: number;
  /** A text/event-stream answer instead of JSON. */
  sse?: boolean;
  notes?: string;
}

/** What each route takes and answers (component names). */
const IO: Record<string, RouteIO> = {
  'GET /v1/me': { res: 'Me' },
  'GET /v1/board': {
    query: RestBoardQuerySchema,
    res: 'Board',
    notes: 'Members (people and agents) need members:read.',
  },
  'GET /v1/boards': {
    res: 'BoardList',
    notes: 'With an account token: every board you are on right now. Call this first.',
  },
  // phase 17 (§Z2): account-token routes — the REST face of boardCreate, agentCreate, boardAgentSet.
  'POST /v1/boards': {
    body: 'CreateBoard',
    res: 'CreatedBoard',
    status: 201,
    notes:
      "ACCOUNT tokens only (boards:create is an account scope). You become the board's admin. " +
      "template 'kanban' has the To do / In progress / Review / Done stages an orchestrator expects; default 'blank'. " +
      'A taken key is a 409. Answers the board with its members.',
  },
  'POST /v1/agents': {
    body: 'CreateAgent',
    res: 'Agent',
    status: 201,
    notes:
      'ACCOUNT tokens only (agents:write). Creates an agent profile you own; put it on a board with ' +
      'POST /v1/boards/{KEY}/agents. Minting a token for it stays with a person (Account › Tokens).',
  },
  'POST /v1/boards/{KEY}/agents': {
    body: 'BoardAgent',
    res: 'Ok',
    notes:
      'ACCOUNT tokens only. Adding needs a board admin who OWNS the agent; changing the role or ' +
      "removing (role: null) needs a board admin. Never 'admin'. stage_grant is for commenters only.",
  },
  // §R2 — the board in the path, for credentials that span boards.
  'GET /v1/boards/{KEY}': { res: 'Board', notes: 'The same as GET /v1/board?board={KEY}.' },
  'GET /v1/boards/{KEY}/tickets': {
    query: RestListTicketsQuerySchema,
    res: 'TicketList',
    notes: 'The same as GET /v1/tickets?board={KEY}.',
  },
  'POST /v1/boards/{KEY}/tickets': {
    body: 'CreateTicket',
    res: 'Ticket',
    status: 201,
    notes: 'The same as POST /v1/tickets with board={KEY} in the body.',
  },
  'GET /v1/tickets': {
    query: RestListTicketsQuerySchema,
    res: 'TicketList',
    notes: "assignee=me lists the token principal's tickets.",
  },
  'POST /v1/tickets': { body: 'CreateTicket', res: 'Ticket', status: 201 },
  'GET /v1/tickets/{KEY}': { query: RestGetTicketQuerySchema, res: 'TicketDetail' },
  'PATCH /v1/tickets/{KEY}': {
    body: 'PatchTicket',
    res: 'Ticket',
    notes:
      'Scopes: stage → tickets:move, assignees → tickets:assign, anything else → tickets:update (all that apply).',
  },
  'POST /v1/tickets/{KEY}/move': { body: 'Move', res: 'Ticket' },
  'POST /v1/tickets/{KEY}/state': { body: 'State', res: 'Ticket' },
  'POST /v1/tickets/{KEY}/assignees': { body: 'Assignees', res: 'Ticket' },
  'GET /v1/tickets/{KEY}/messages': { query: RestMessagesQuerySchema, res: 'MessageList' },
  'POST /v1/tickets/{KEY}/messages': {
    body: 'PostMessage',
    res: 'Message',
    status: 201,
    notes:
      'Mention people as @email, agents as @ag_…, tickets as #KEY. attachments = file ids from POST …/files. ' +
      'Orchestrators: `run` is the turn receipt for one finished run of the agent (cost_usd is THIS turn); it is ' +
      "added to the ticket's, the board's and the day's cost counters in the same write.",
  },
  'GET /v1/tickets/{KEY}/files': { res: 'FileList' },
  'POST /v1/tickets/{KEY}/files': {
    body: 'UploadJson',
    multipart: true,
    res: 'Uploaded',
    status: 201,
    notes: `JSON { name, mime?, text | content_base64 } or multipart/form-data with a "${REST_UPLOAD_FIELD}" part. At most ${MAX_API_UPLOAD_BYTES / 1024 / 1024} MB.`,
  },
  'GET /v1/files/{fileId}': {
    query: RestGetFileQuerySchema,
    res: 'FileWithContent',
    notes: '?content=1 returns the text of Markdown, HTML, text, CSV, JSON and code files.',
  },
  'GET /v1/events': { query: RestEventsQuerySchema, res: 'EventList' },
  'GET /v1/events/stream': {
    res: 'Event',
    sse: true,
    notes: `Server-Sent Events: "${SSE_EVENT}" (id = event id, data = Event JSON) and "${SSE_PING}" keep-alives. Resume with Last-Event-ID or ?cursor=.`,
  },
  'POST /v1/events/ack': { body: 'Ack', res: 'Acked' },
  'GET /v1/live': {
    res: 'Live',
    notes:
      'A short-lived Realtime Database credential (about an hour) for this token. Stream ' +
      '`{database_url}/{path}.json?auth={auth}` with Accept: text/event-stream for each of `paths` ' +
      '(rev/{boardId}: something on the board changed; agents/{agentId}/wake: something is in your inbox), then ' +
      "ask REST for the delta. Re-mint when expires_in runs out. The SDK's tm.watch() does this for you.",
  },
  // phase 3 (§L4): questions, task lists, heartbeat
  'POST /v1/tickets/{KEY}/questions': {
    body: 'AskQuestion',
    res: 'Question',
    status: 201,
    notes:
      'The question appears in the thread as a form card; a PERSON answers it in the app (there is no answer route ' +
      'on purpose) and the answer reaches the asker as the inbox event question_answered.',
  },
  'GET /v1/questions/{id}': {
    res: 'Question',
    notes: "The id is the one POST …/questions returned ('{ticketId}.{messageId}').",
  },
  'POST /v1/questions/{id}/cancel': {
    res: 'Question',
    notes: 'Only the asker (or a board admin), and only while it is open.',
  },
  'GET /v1/tickets/{KEY}/tasklists': { res: 'TasklistList' },
  'PUT /v1/tickets/{KEY}/tasklists/{listId}': {
    body: 'SetTasklist',
    res: 'Tasklist',
    notes:
      'Creates or REPLACES the whole list. Keep an item id to keep that item across a replace.',
  },
  'PATCH /v1/tickets/{KEY}/tasklists/{listId}/items/{itemId}': {
    body: 'UpdateTaskItem',
    res: 'Tasklist',
    notes:
      'The cheap hot path: no thread line, no activity row. Answers the whole list with its new progress.',
  },
  'DELETE /v1/tickets/{KEY}/tasklists/{listId}': { res: 'Deleted' },
  'POST /v1/heartbeat': {
    body: 'Heartbeat',
    res: 'AgentStatus',
    notes:
      "Send one a minute while you work and one when you stop ('done' or 'error'). Beats write only the agentStatus " +
      'document, never the ticket; a working status with no beat for 75 s reads as no signal.',
  },
  'GET /v1/agents/status': {
    res: 'AgentStatusList',
    notes: '?ticket=KEY limits it to one ticket. An agent token sees its own rows.',
  },
  'GET /v1/search': { query: RestSearchQuerySchema, res: 'SearchResults' },
  'GET /v1/webhooks': { res: 'WebhookList' },
  'POST /v1/webhooks': { body: 'WebhookBody', res: 'WebhookSaved', status: 201 },
  'PATCH /v1/webhooks/{id}': { body: 'WebhookBody', res: 'WebhookSaved' },
  'DELETE /v1/webhooks/{id}': { res: '', status: 204 },
};

function queryParams(q: z.AnyZodObject): Json[] {
  const js = schema(q) as { properties?: Record<string, Json>; required?: string[] };
  return Object.entries(js.properties ?? {}).map(([name, s]) => ({
    name,
    in: 'query',
    required: js.required?.includes(name) ?? false,
    schema: s,
  }));
}

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ref('Problem') } },
});

let cached: Json | undefined;

export function openApiDocument(c: Context): Json {
  const base = apiBaseUrl(c);
  cached ??= buildPaths();
  return {
    openapi: '3.1.0',
    info: {
      title: 'TaskManager API',
      version: '1',
      description:
        'The same commands the app uses, resource-shaped — for orchestrators and their agents. ' +
        "Authenticate with a token ('Authorization: Bearer tm_live_…', Account › Tokens). A BOARD token works on " +
        'ONE board and acts as you or as one of your agents; an ACCOUNT token acts as you on every board you are ' +
        'on, as that stands at each call, and names its board with ?board=ENG, a body field, or in the path ' +
        '(/v1/boards/ENG/tickets) — a ticket key already names its board. What a token may do is its scopes ∩ the ' +
        'role of the principal it acts as. GET /v1/me says which kind you hold. OAuth 2.1 access tokens work too. ' +
        'Every POST honours Idempotency-Key. Errors are RFC 9457 problem+json.',
    },
    servers: [{ url: base }],
    security: [{ bearer: [] }, { oauth: [] }],
    ...cached,
    components: {
      ...(cached.components as Json),
      securitySchemes: {
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description:
            "Board or account token 'tm_live_…' (Account › Tokens); GET /v1/me reports which kind",
        },
        oauth: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              authorizationUrl: `${base}/oauth/authorize`,
              tokenUrl: `${base}/oauth/token`,
              refreshUrl: `${base}/oauth/token`,
              scopes: Object.fromEntries(SCOPES.map((s) => [s, SCOPE_LABELS[s]])),
            },
          },
        },
        intake: { type: 'apiKey', in: 'header', name: INTAKE_HEADERS.secret },
      },
    },
  };
}

function buildPaths(): Json {
  const paths: Record<string, Record<string, Json>> = {};
  for (const r of REST_ROUTES) {
    const io = IO[`${r.method} ${r.path}`];
    if (!io) continue;
    const params: Json[] = [];
    for (const m of r.path.matchAll(/\{(\w+)\}/g)) {
      params.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
    }
    if (io.query) params.push(...queryParams(io.query));
    if (r.method === 'POST')
      params.push({
        name: IDEMPOTENCY_HEADER,
        in: 'header',
        required: false,
        schema: { type: 'string', maxLength: 255 },
        description: 'A retried request with the same key is one change.',
      });
    const status = String(io.status ?? 200);
    const op: Json = {
      operationId: `${r.method.toLowerCase()}${r.path
        .replace(/^\/v1/, '')
        .replace(/[{}]/g, '')
        .replace(/\/(\w)/g, (_, ch: string) => ch.toUpperCase())}`,
      summary: r.summary,
      ...(r.scopes.length || io.notes
        ? {
            description: [
              r.scopes.length
                ? `Scopes (any of): ${r.scopes.map((x) => `\`${x}\``).join(', ')}.`
                : '',
              io.notes ?? '',
            ]
              .filter(Boolean)
              .join(' '),
          }
        : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(io.body
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: ref(io.body) },
                ...(io.multipart
                  ? {
                      'multipart/form-data': {
                        schema: {
                          type: 'object',
                          required: [REST_UPLOAD_FIELD],
                          properties: {
                            [REST_UPLOAD_FIELD]: { type: 'string', format: 'binary' },
                            name: { type: 'string', description: 'Overrides the part filename' },
                            mime: { type: 'string' },
                          },
                        },
                      },
                    }
                  : {}),
              },
            },
          }
        : {}),
      responses: {
        [status]: io.sse
          ? {
              description: 'An event stream',
              content: { 'text/event-stream': { schema: ref(io.res) } },
            }
          : io.res
            ? { description: 'OK', content: { 'application/json': { schema: ref(io.res) } } }
            : { description: 'No content' },
        '400': problem('Invalid request'),
        '401': problem('Missing or invalid token'),
        '403': problem('Not allowed (role or scope)'),
        '404': problem('Not found — or not visible to you'),
        '409': problem('Conflict'),
        '429': problem('Rate limited — see Retry-After'),
      },
    };
    (paths[r.path] ??= {})[r.method.toLowerCase()] = op;
  }
  paths['/v1/intake'] = {
    post: {
      operationId: 'intakeSubmit',
      security: [{ intake: [] }],
      description: `A website feedback widget. Headers \`${INTAKE_HEADERS.slug}\` and \`${INTAKE_HEADERS.secret}\`.`,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: ref('IntakeSubmit') } },
      },
      responses: {
        '201': {
          description: 'Created',
          content: { 'application/json': { schema: ref('IntakeCreated') } },
        },
        '401': problem('Unknown slug or wrong secret'),
        '403': problem('Origin not allowed'),
        '429': problem('Rate limited'),
      },
    },
  };
  paths['/v1/intake/schema'] = {
    get: {
      operationId: 'intakeSchema',
      security: [{ intake: [] }],
      responses: {
        '200': {
          description: 'OK',
          content: { 'application/json': { schema: ref('IntakeSchema') } },
        },
      },
    },
  };
  return {
    paths,
    components: {
      schemas: Object.fromEntries(Object.entries(COMPONENTS).map(([k, v]) => [k, schema(v)])),
    },
  };
}
