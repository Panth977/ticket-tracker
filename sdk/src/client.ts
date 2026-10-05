/**
 * createClient — every /v1 route as a typed function (docs/plan/agents.html §M).
 *
 *   const tm = createClient({ token: process.env.TM_TOKEN })
 *   const me = await tm.me()            // who the token is, and which boards it reaches
 *
 * Inputs are camelCase and forgiving (a task list takes plain strings, a
 * question's options take plain strings, a file takes text or bytes); answers
 * are the API's own snake_case shapes, unchanged, so what the docs and
 * openapi.json say is what you get.
 *
 * A BOARD token names exactly one board, so nothing here takes a board.
 * §R2: an ACCOUNT token reaches every board you are on — `tm.kind()` says
 * which you hold, `tm.boards.list()` says what it reaches, and
 * `tm.board('ENG')` gives you this very same API pinned to one board.
 * §AA1: an AGENT token (one per agent) works the same way for the agent's
 * boards — on several boards, name the board.
 */
import { createArtifactData, type ArtifactData, type ArtifactDataOptions } from './data.js';
import { TmError } from './errors.js';
import {
  Http,
  randomId,
  type FetchLike,
  type HttpOptions,
  type QueryValue,
  type RequestOptions,
} from './http.js';
import { readSse } from './sse.js';
import { createWatcher, type LiveCredential, type WatchOptions, type Watcher } from './watch.js';
import { fromBase64, isZip, readDirectory, realPathOrNull, zipFiles, zipPath, type ZipEntry } from './zip.js';
import { workLoop, type WorkHandler, type WorkOptions, type WorkSummary } from './work.js';
import type {
  Agent,
  AgentState,
  AgentStatus,
  Artifact,
  ArtifactAgentAccess,
  ArtifactBuild,
  ArtifactDetail,
  ArtifactShareResult,
  ArtifactSource,
  Board,
  BoardRole,
  EventPage,
  FileWithContent,
  LinkType,
  Me,
  Message,
  Page,
  Question,
  QuestionAnswer,
  QuestionFieldType,
  QuestionValue,
  RunOutcome,
  SearchHit,
  TaskItemStatus,
  Tasklist,
  Ticket,
  TicketDetail,
  TicketState,
  TmEvent,
  TokenKind,
  TmFile,
  UploadedFile,
  Webhook,
  WebhookEvent,
} from './types.js';

/** Stamped in by the build; `dev` when running from source. */
export const VERSION = '0.0.0-dev';

// ───────────────────────── inputs ─────────────────────────

/**
 * Everything `createClient` takes: the transport's options, plus the one
 * thing §W added — how (and whether) this client may hold a LIVE connection.
 */
export interface ClientOptions extends HttpOptions {
  /**
   * The Realtime Database credential `tm.watch()` streams with. Leave it out
   * and the client asks `GET /v1/live` once; `false` turns streaming off and
   * makes `watch()` poll on its backoff schedule.
   */
  live?: LiveCredential | false | undefined;
}

/** Name a principal by id, email, agent name, or the literal `'me'`. */
export type PrincipalRef = string;

export interface TicketFilter extends RequestOptions {
  /** Stage id or name. */
  stage?: string | undefined;
  assignee?: PrincipalRef | undefined;
  /** Free text. */
  q?: string | undefined;
  /** ISO 8601. */
  updatedSince?: string | undefined;
  /** Default 'active'. */
  state?: TicketState | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** Everything a ticket write can set. Stage, priority and tags go by NAME or id. */
export interface TicketInput {
  title?: string;
  /** Markdown; mention people as @email, agents as @ag_…, tickets as #KEY. */
  description?: string | null;
  stage?: string;
  priority?: string | null;
  tags?: string[];
  /** id | email | agent name; replaces the list. */
  assignees?: PrincipalRef[];
  /** ISO 8601. */
  startAt?: string | null;
  dueAt?: string | null;
  dueAllDay?: boolean;
  estimate?: number | null;
  /** Custom fields by NAME. */
  fields?: Record<string, unknown>;
  links?: { type: LinkType; key: string }[];
}
export interface CreateTicketInput extends TicketInput {
  title: string;
}

/**
 * The turn receipt an ORCHESTRATOR attaches to the message it posts when one
 * run of the agent ends (§Y1). `costUsd` is this turn's cost — Claude Code
 * reports `total_cost_usd` cumulatively across a resumed session, so post the
 * difference and keep the reported total in `sessionUsd`. The server adds it
 * to the ticket's, the board's and the day's cost counters.
 */
export interface RunReceiptInput {
  /** Your run counter on this ticket, 1-based. */
  n: number;
  outcome: RunOutcome;
  costUsd: number;
  sessionUsd?: number | null;
  durationMs: number;
  apiTurns?: number | null;
  model?: string | null;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}

export interface PostMessageInput {
  /** GitHub-flavoured Markdown. May be empty when `attachments` are given. */
  markdown?: string;
  /** File ids from `files.upload`, already on this ticket. */
  attachments?: string[];
  /** A message id to quote. */
  replyTo?: string;
  /** Orchestrators: the receipt of one finished run. The body should say the same in words. */
  run?: RunReceiptInput | null;
}

/** `agents.create()` — an agent profile (account tokens). */
export interface CreateAgentInput {
  /** Optional client-chosen `ag_` + 16 id. */
  id?: string;
  name: string;
  description?: string | null;
  /** Markdown. */
  systemPrompt?: string;
  /** A Storage path already under your agent-avatar prefix (needs `id`). */
  avatar?: string | null;
  /** A prebuilt icon id ('claude', 'gemini', 'chatgpt', 'bot', 'terminal', …), shown when there is no picture. */
  icon?: string | null;
}

/** `boards.create()` (account tokens). */
export interface CreateBoardInput {
  name: string;
  /** 2–6 chars, A–Z then A–Z/0–9. */
  key: string;
  /** 'kanban' has the To do / In progress / Review / Done stages an orchestrator expects. */
  template?: 'blank' | 'kanban' | 'bugs' | 'support' | 'sprint';
  color?: string;
  icon?: string;
}

/** `boards.setAgent()` (account tokens): put an agent on a board, change its role, or remove it. */
export interface BoardAgentInput {
  /** `ag_…` from `agents.create()`. */
  agent: string;
  /**
   * null removes the agent from the board. §AA2: an agent may be 'admin' —
   * board settings, stages, fields, webhooks, restore. What an agent admin
   * still cannot do is what no agent can: manage the board's people and
   * agents, invite, create boards, mint tokens.
   */
  role: BoardRole | null;
  /** Commenters only: the stages it may move tickets between. null clears it. */
  stageGrant?: { stages: string[]; assignedOnly?: boolean } | null;
}

export interface UploadInput {
  /** With its extension — `plan.md`, `report.html`. The extension picks the mime. */
  name: string;
  mime?: string;
  /** Text content. Give exactly one of `text`, `base64` or `bytes`. */
  text?: string;
  base64?: string;
  bytes?: Uint8Array;
}

/** A question field, as you write it: `options` may be plain strings. */
export interface QuestionFieldInput {
  id: string;
  label: string;
  type: QuestionFieldType;
  /** single / multi: `'Postgres'` is shorthand for `{ id: 'Postgres', label: 'Postgres' }`. */
  options?: readonly (string | { id: string; label: string; description?: string })[];
  required?: boolean;
  default?: QuestionValue;
  placeholder?: string;
}

export interface AskInput<F extends readonly QuestionFieldInput[]> {
  title: string;
  /** Markdown context under the title. */
  body?: string | null;
  fields: F;
  /** Adds an "Anything else?" box. */
  allowComment?: boolean;
  /** Who should answer; omit to ask anyone on the board who may comment. */
  to?: PrincipalRef[] | null;
  /** Default true: the ticket shows "Waiting for your answer". */
  blocking?: boolean;
  /** ISO 8601; after this the card locks as Expired. */
  expiresAt?: string | null;
}

/** What one field's answer holds — `multi` is a list of option ids, `date` is millis. */
export type AnswerValue<T extends QuestionFieldType> = T extends 'multi'
  ? string[]
  : T extends 'number' | 'date'
    ? number
    : T extends 'boolean'
      ? boolean
      : string;

/** `answer.values.db` is typed from the fields you passed to `ask`. */
export type AnswerValues<F extends readonly QuestionFieldInput[]> = {
  [K in F[number] as K['id']]: AnswerValue<K['type']>;
};

/** What `waitForAnswer()` resolves with: the answer, plus the question it belongs to. */
export interface TypedAnswer<F extends readonly QuestionFieldInput[]> extends Omit<
  QuestionAnswer,
  'values'
> {
  values: AnswerValues<F> & Record<string, QuestionValue>;
  question: Question;
}

export interface TaskItemInput {
  /** Keep an id to keep that item's identity across a replace. */
  id?: string;
  title: string;
  status?: TaskItemStatus;
  note?: string;
}

export interface SetTasklistInput {
  title: string;
  /** Plain strings are turned into `{ title }` items. Replaces the whole list. */
  items: readonly (string | TaskItemInput)[];
  /** Omit to create a new list; give it to replace that one. */
  listId?: string;
  position?: number;
  /** true when the plan is finished — adds the "finished" line to the thread. */
  closed?: boolean;
}

export interface HeartbeatInput {
  /** A ticket KEY; omit for an agent-level beat. */
  ticket?: string;
  message?: string | null;
  /** 0–1. */
  progress?: number | null;
}

export interface EventQuery extends RequestOptions {
  cursor?: string | undefined;
  limit?: number | undefined;
  /** Skip events already acked. */
  unacked?: boolean | undefined;
}

export interface StreamOptions extends EventQuery {
  /** Acknowledge each event once your loop has taken it (default false). */
  ack?: boolean | undefined;
  /** Wait this long before reconnecting after a stream ends (default 1 s). */
  reconnectMs?: number | undefined;
  /** Stop after this many reconnect failures in a row (default: never stop). */
  maxReconnects?: number | undefined;
}

// ───────────────────────── artifacts: inputs ─────────────────────────

/**
 * `artifacts.create()` (`artifacts:write`). With an account token you become
 * the owner; with an agent token the agent's OWNER does, and the agent is on
 * it with { build: true, data: 'write' }.
 */
export interface CreateArtifactInput {
  /** ≤ 80 characters. */
  name: string;
  /** ≤ 500 characters. */
  description?: string | null;
  /** One emoji. */
  icon?: string | null;
}

/** `artifacts.update()` — owner only. Send only what changes. */
export interface UpdateArtifactInput {
  name?: string;
  description?: string | null;
  icon?: string | null;
  /** Viewers may read the artifact's data but not write it. */
  readOnly?: boolean;
  /** Archive (no data writes, off the sidebar) or restore. */
  archived?: boolean;
}

/** One file of a build given in memory. */
export interface ArtifactFile {
  /** Relative to the build root: 'index.html', 'assets/app.js'. */
  path: string;
  content: string | Uint8Array | ArrayBuffer | Blob;
  /** For a string `content`: 'utf8' (default) or 'base64' for images and other binaries. */
  encoding?: 'utf8' | 'base64';
}

/**
 * What `artifacts.publish()` takes as the BUILD — the folder with an
 * index.html at its root:
 *
 *   './dist'                      a directory (Node, Deno, Bun): walked and zipped for you
 *   Uint8Array | ArrayBuffer | Blob   bytes that are ALREADY a zip
 *   [{ path, content }]           files in memory, zipped for you (works in a browser)
 *   { 'index.html': '<!doctype…' }    the same, as a record of path → content
 */
export type ArtifactBuildInput =
  | string
  | Uint8Array
  | ArrayBuffer
  | Blob
  | readonly ArtifactFile[]
  | Readonly<Record<string, string | Uint8Array | ArrayBuffer | Blob>>;

export interface PublishArtifactOptions extends RequestOptions {
  /**
   * The SOURCE, kept beside the build and never served — what the next agent
   * downloads to carry on (`artifacts.source()`). A directory is zipped for
   * you, leaving out `ARTIFACT_SOURCE_SKIP_DIRS` (node_modules, .git, dist,
   * build …), `.env` files (a source zip is handed to other people) and any
   * file over 2 MB; zip bytes or a Blob are sent as they are.
   */
  source?: string | Uint8Array | ArrayBuffer | Blob | undefined;
  /** A line saying what changed (≤ 500 characters). */
  message?: string | undefined;
}

/**
 * `artifacts.share()`: exactly one of `email` (a person) or `agent` (one of
 * the owner's agents).
 *
 *   { email, role: 'editor' | 'viewer' | null }        a person; null removes
 *   { agent, access: { build, data } }                 §AA3 — an agent: build
 *                                                      and data, separately;
 *                                                      { build: false, data: 'none' } removes
 *   { agent, role: 'editor' | null }                   the old form, still
 *                                                      accepted: 'editor' is
 *                                                      { build: true, data: 'write' }
 */
export type ShareArtifactInput =
  | { email: string; agent?: undefined; role: 'editor' | 'viewer' | null; access?: undefined }
  | { agent: string; email?: undefined; access: ArtifactAgentAccess; role?: 'editor' | null | undefined }
  | { agent: string; email?: undefined; role: 'editor' | null; access?: undefined };

/**
 * The server's limits on one publish, repeated here so an oversized build is
 * refused BEFORE a 26 MB upload rather than after it. test/artifacts.test.ts
 * compares each with the constant the server enforces, so they cannot drift.
 */
export const ARTIFACT_LIMITS = {
  /** The build zip, compressed. */
  zipBytes: 26 * 1024 * 1024,
  /** The build, unpacked. */
  buildBytes: 25 * 1024 * 1024,
  buildFiles: 2000,
  /** The whole request: build zip + source zip ride together, and Cloud Functions stops at 32 MB. */
  requestBytes: 31 * 1024 * 1024,
} as const;

/** Directory names left out of a source zip made from a folder. */
export const ARTIFACT_SOURCE_SKIP_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.svelte-kit',
  '.next',
  '.nuxt',
  '.vite',
  '.cache',
  '.turbo',
  'coverage',
];
/** One source file over this is left out: it is a video or a database, not source. */
export const ARTIFACT_SOURCE_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** A publish uploads megabytes; the 30 s default would cut a slow link off mid-body. */
const PUBLISH_TIMEOUT_MS = 180_000;
/** Finder and Explorer litter: never part of a build or of its source. */
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db']);

// ───────────────────────── small helpers ─────────────────────────

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Bytes → base64, without Buffer or btoa, so it is the same everywhere. */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64_ALPHABET[(n >> 18) & 63]! + B64_ALPHABET[(n >> 12) & 63]!;
    out += b1 === undefined ? '=' : B64_ALPHABET[(n >> 6) & 63]!;
    out += b2 === undefined ? '=' : B64_ALPHABET[n & 63]!;
  }
  return out;
}

/** Drop undefined values so a PATCH only carries what the caller set. */
function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/** camelCase TicketInput → the REST body's snake_case. */
function ticketBody(t: TicketInput): Record<string, unknown> {
  return defined({
    title: t.title,
    description_md: t.description,
    stage: t.stage,
    priority: t.priority,
    tags: t.tags,
    assignees: t.assignees,
    start_at: t.startAt,
    due_at: t.dueAt,
    due_all_day: t.dueAllDay,
    estimate: t.estimate,
    fields: t.fields,
    links: t.links,
  });
}

/** camelCase RunReceiptInput → the wire receipt (absent optionals become null). */
export function runBody(r: RunReceiptInput): Record<string, unknown> {
  return {
    n: r.n,
    outcome: r.outcome,
    cost_usd: r.costUsd,
    session_usd: r.sessionUsd ?? null,
    duration_ms: r.durationMs,
    api_turns: r.apiTurns ?? null,
    model: r.model ?? null,
    usage: r.usage
      ? {
          input: r.usage.input,
          output: r.usage.output,
          cache_read: r.usage.cacheRead,
          cache_write: r.usage.cacheWrite,
        }
      : null,
  };
}

/** `'Postgres'` → `{ id: 'Postgres', label: 'Postgres' }`. */
function questionFields(fields: readonly QuestionFieldInput[]): unknown[] {
  return fields.map((f) =>
    defined({
      id: f.id,
      label: f.label,
      type: f.type,
      options: f.options?.map((o) => (typeof o === 'string' ? { id: o, label: o } : o)),
      required: f.required,
      default: f.default,
      placeholder: f.placeholder,
    }),
  );
}

/** `'Write it'` → `{ title: 'Write it' }`. */
function taskItems(items: readonly (string | TaskItemInput)[]): unknown[] {
  return items.map((i) =>
    typeof i === 'string'
      ? { title: i }
      : defined({ id: i.id, title: i.title, status: i.status, note: i.note }),
  );
}

const asBlob = (bytes: Uint8Array): Blob => new Blob([bytes as BlobPart], { type: 'application/zip' });

const tooLarge = (message: string): TmError =>
  new TmError({ code: 'too_large', status: 0, message: `artifacts.publish: ${message}` });

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function fileBytes(f: ArtifactFile): Promise<Uint8Array> {
  const c = f.content;
  if (typeof c === 'string')
    return f.encoding === 'base64' ? fromBase64(c) : new TextEncoder().encode(c);
  if (c instanceof Uint8Array) return c;
  if (c instanceof ArrayBuffer) return new Uint8Array(c);
  if (typeof Blob !== 'undefined' && c instanceof Blob) return new Uint8Array(await c.arrayBuffer());
  throw new TypeError(`artifacts.publish: '${f.path}' has no usable content`);
}

/**
 * The checks the server makes on an unpacked build, made first on a build WE
 * are about to zip — where the answer costs nothing, and can name the folder.
 * (Zip bytes handed to us go up unopened; the server is the judge of those.)
 */
function checkBuild(entries: readonly ZipEntry[], what: string): void {
  if (!entries.length) throw new TypeError(`artifacts.publish: ${what} has no files in it`);
  const paths = entries.map((e) => zipPath(e.path));
  // An index.html at the root — or in a single top folder, which the server strips.
  const tops = new Set(paths.map((p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '')));
  const only = tops.size === 1 ? [...tops][0]! : '';
  if (!paths.includes(only ? `${only}/index.html` : 'index.html'))
    throw new TypeError(
      `artifacts.publish: ${what} has no index.html at its root — publish the BUILD folder (Vite: dist/), not the project`,
    );
  if (entries.length > ARTIFACT_LIMITS.buildFiles)
    throw tooLarge(`${what} has ${entries.length} files; a build is at most ${ARTIFACT_LIMITS.buildFiles}`);
  const bytes = entries.reduce((n, e) => n + e.bytes.length, 0);
  if (bytes > ARTIFACT_LIMITS.buildBytes)
    throw tooLarge(`${what} is ${mb(bytes)} unpacked; a build is at most ${mb(ARTIFACT_LIMITS.buildBytes)}`);
}

/** Any `ArtifactBuildInput` → the bytes of one zip. */
async function buildZip(input: ArtifactBuildInput): Promise<Uint8Array> {
  if (typeof input === 'string') {
    const entries = await readDirectory(
      input,
      { skipDirs: ['__MACOSX'], skipFile: (name) => JUNK_FILES.has(name) },
      'artifacts.publish',
    );
    checkBuild(entries, `'${input}'`);
    return zipFiles(entries);
  }
  const given =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : typeof Blob !== 'undefined' && input instanceof Blob
          ? new Uint8Array(await input.arrayBuffer())
          : null;
  if (given) {
    if (!isZip(given))
      throw new TypeError(
        'artifacts.publish: those bytes are not a zip — pass a directory path or a list of { path, content } files to have them zipped',
      );
    return given;
  }
  if (typeof input !== 'object' || input === null)
    throw new TypeError('artifacts.publish: give a directory path, zip bytes, or files');
  const files: ArtifactFile[] = Array.isArray(input)
    ? [...(input as readonly ArtifactFile[])]
    : Object.entries(input as Record<string, ArtifactFile['content']>).map(([path, content]) => ({
        path,
        content,
      }));
  const entries: ZipEntry[] = [];
  for (const f of files) entries.push({ path: f.path, bytes: await fileBytes(f) });
  checkBuild(entries, 'the file list');
  return zipFiles(entries);
}

/** `source` → zip bytes. A directory loses what is not source; the build folder inside it goes too. */
async function sourceZip(
  source: NonNullable<PublishArtifactOptions['source']>,
  buildDir: string | undefined,
): Promise<Uint8Array> {
  if (typeof source !== 'string') {
    const bytes =
      source instanceof Uint8Array
        ? source
        : source instanceof ArrayBuffer
          ? new Uint8Array(source)
          : new Uint8Array(await source.arrayBuffer());
    if (!isZip(bytes))
      throw new TypeError('artifacts.publish: `source` must be a directory path or the bytes of a zip');
    return bytes;
  }
  // A build folder with an unusual name ('out', 'public') is not in the skip
  // list, so it is recognised by WHERE it is instead.
  const buildReal = buildDir === undefined ? null : await realPathOrNull(buildDir);
  const sourceReal = await realPathOrNull(source);
  const entries = await readDirectory(
    source,
    {
      skipDirs: ARTIFACT_SOURCE_SKIP_DIRS,
      // Publishing the project folder itself as the build: keep its files as source.
      skipRealPaths: buildReal && buildReal !== sourceReal ? [buildReal] : [],
      // .env and .env.local hold secrets, and a source zip is what the NEXT
      // person downloads. .env.example is documentation and stays.
      skipFile: (name) =>
        JUNK_FILES.has(name) || (/^\.env(\..+)?$/.test(name) && !/\.(example|sample|template)$/.test(name)),
      maxFileBytes: ARTIFACT_SOURCE_MAX_FILE_BYTES,
    },
    'artifacts.publish',
  );
  if (!entries.length)
    throw new TypeError(`artifacts.publish: the source folder '${source}' has no files to keep`);
  return zipFiles(entries);
}

/** A ticket key in a URL path. Keys are `ENG-42`, but never trust the caller. */
const seg = (v: string): string => encodeURIComponent(String(v));

const req = (o: RequestOptions | undefined): RequestOptions | undefined =>
  o
    ? defined({
        signal: o.signal,
        timeoutMs: o.timeoutMs,
        idempotencyKey: o.idempotencyKey,
        retry: o.retry,
        headers: o.headers,
      })
    : undefined;

// ───────────────────────── the client ─────────────────────────

/**
 * A question in flight. `await` it for the Question itself, or call
 * `.waitForAnswer()` to block until a person submits the form (§M).
 */
export class AskHandle<F extends readonly QuestionFieldInput[]> implements PromiseLike<Question> {
  constructor(
    private readonly asked: Promise<Question>,
    /** Just the one function it needs — naming the whole client here would make its type circular. */
    private readonly waiter: (q: Question, opts: WaitForAnswerOptions) => Promise<TypedAnswer<F>>,
  ) {}

  then<A = Question, B = never>(
    onOk?: ((q: Question) => A | PromiseLike<A>) | null,
    onErr?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.asked.then(onOk, onErr);
  }

  catch<B = never>(onErr?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<Question | B> {
    return this.asked.catch(onErr);
  }

  finally(onDone?: (() => void) | null): Promise<Question> {
    return this.asked.finally(onDone);
  }

  /**
   * Poll until somebody answers. Resolves with the values keyed by field id
   * (typed from the fields you passed); throws `TmError` with code 'timeout'
   * if nobody answers in time, and 'gone' if it is cancelled or expires.
   */
  async waitForAnswer(opts: WaitForAnswerOptions = {}): Promise<TypedAnswer<F>> {
    return this.waiter(await this.asked, opts);
  }
}

export interface WaitForAnswerOptions {
  /** Give up after this long (default 30 minutes). */
  timeoutMs?: number;
  /** How often to look (default 5 s, floor 500 ms). */
  pollMs?: number;
  signal?: AbortSignal;
}

/** A running heartbeat: a beat now, one every `everyMs`, and a final one at the end. */
export interface Beat {
  /** Change what the next beats say, and send one right away. */
  update(patch: {
    message?: string | null;
    progress?: number | null;
    state?: 'working' | 'idle';
  }): Promise<AgentStatus>;
  /** Stop beating and mark the work finished. */
  done(patch?: { message?: string | null }): Promise<AgentStatus>;
  /** Stop beating and mark it failed. */
  error(message?: string): Promise<AgentStatus>;
  /** Stop beating and say nothing (the UI keeps the last state until it goes stale). */
  stop(): void;
  readonly running: boolean;
}

/** Everything a client does except `work()` — see `TmClient` below. */
export type TmClientBase = ReturnType<typeof createClientBase>;

/** Beats go out every minute; the UI calls an agent stale after 75 s of silence (§L3). */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Build a client for one token. Everything below is a thin, typed wrapper
 * over `Http`, which does the retrying, the idempotency keys and the errors.
 *
 * The methods are declared as local functions first and only then assembled
 * into the returned object: a method that calls a sibling (`tickets.iterate`
 * pages through `tickets.list`) would otherwise make the object's inferred
 * type refer to itself.
 */
function createClientBase(options: ClientOptions) {
  const http = new Http(options);

  const get = <T>(
    path: string,
    query?: Record<string, QueryValue>,
    o?: RequestOptions,
  ): Promise<T> => http.json<T>({ method: 'GET', path, query, options: req(o) });

  const write = <T>(method: string, path: string, body?: unknown, o?: RequestOptions): Promise<T> =>
    http.json<T>({ method, path, body, options: req(o) });

  // ── tickets ──────────────────────────────────────────────────────────────

  const listTickets = (f: TicketFilter = {}): Promise<Page<Ticket>> =>
    get<Page<Ticket>>(
      '/tickets',
      {
        stage: f.stage,
        assignee: f.assignee,
        q: f.q,
        updated_since: f.updatedSince,
        state: f.state,
        cursor: f.cursor,
        limit: f.limit,
      },
      f,
    );

  /** Every ticket the filter matches, following `next_cursor` to the end. */
  async function* iterateTickets(f: TicketFilter = {}): AsyncGenerator<Ticket> {
    let cursor = f.cursor;
    for (;;) {
      const page = await listTickets({ ...f, cursor });
      for (const t of page.data) yield t;
      if (!page.next_cursor || page.data.length === 0) return;
      cursor = page.next_cursor;
    }
  }

  /**
   * THE CHEAP BOARD READ (docs/plan/agents.html §W).
   *
   * `tickets.list()` with no `updated_since` is a FULL SCAN, and a loop that
   * runs it every 30 seconds was 4,400 full scans a day on a board nobody had
   * touched — half of everything this API served. `changes()` is the same
   * call with the delta asked for: it remembers the newest `updated_at` it
   * has handed you and sends it as `updated_since` next time, so an unchanged
   * board answers with an empty page and costs one read.
   *
   *   for await (const _ of tm.watch()) {
   *     for (const t of await tm.tickets.changes()) reconcile(t);
   *   }
   *
   * The first call has no watermark, so it returns the board — pass
   * `{ updatedSince }` to resume from a watermark you persisted yourself, or
   * `{ reset: true }` to ask for everything again.
   */
  let ticketWatermark: string | undefined;
  async function ticketChanges(f: TicketFilter & { reset?: boolean } = {}): Promise<Ticket[]> {
    if (f.reset) ticketWatermark = undefined;
    const since = f.updatedSince ?? ticketWatermark;
    const out: Ticket[] = [];
    let cursor = f.cursor;
    for (;;) {
      const page = await listTickets({ ...f, ...(since ? { updatedSince: since } : {}), cursor });
      out.push(...page.data);
      if (!page.next_cursor || page.data.length === 0) break;
      cursor = page.next_cursor;
    }
    for (const t of out)
      if (!ticketWatermark || t.updated_at > ticketWatermark) ticketWatermark = t.updated_at;
    return out;
  }

  // ── files ────────────────────────────────────────────────────────────────

  const getFile = (
    fileId: string,
    o: RequestOptions & { content?: boolean } = {},
  ): Promise<FileWithContent> =>
    get<FileWithContent>(`/files/${seg(fileId)}`, { content: o.content ? 1 : undefined }, o);

  // ── questions ────────────────────────────────────────────────────────────

  const getQuestion = (id: string, o?: RequestOptions): Promise<Question> =>
    get<Question>(`/questions/${seg(id)}`, undefined, o);

  /**
   * Poll a question until it leaves 'open'. Polling, not the event stream, so
   * `waitForAnswer()` works with a token that has no `events:read` and needs
   * no second connection.
   */
  async function waitForAnswer<F extends readonly QuestionFieldInput[]>(
    question: Question | string,
    opts: WaitForAnswerOptions = {},
  ): Promise<TypedAnswer<F>> {
    const id = typeof question === 'string' ? question : question.id;
    const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
    const pollMs = Math.max(500, opts.pollMs ?? 5_000);
    const deadline = http.now() + timeoutMs;
    let current: Question =
      typeof question === 'string' ? await getQuestion(id, { signal: opts.signal }) : question;
    for (;;) {
      if (current.status === 'answered' && current.answer)
        return {
          ...current.answer,
          values: current.answer.values as TypedAnswer<F>['values'],
          question: current,
        };
      if (current.status !== 'open')
        throw new TmError({
          code: 'gone',
          status: 0,
          message: `Question ${id} was ${current.status} before it was answered`,
          method: 'GET',
          url: `/questions/${id}`,
        });
      if (http.now() >= deadline)
        throw new TmError({
          code: 'timeout',
          status: 0,
          message: `Nobody answered question ${id} within ${timeoutMs} ms`,
          method: 'GET',
          url: `/questions/${id}`,
        });
      await http.sleep(Math.min(pollMs, Math.max(0, deadline - http.now())), opts.signal);
      current = await getQuestion(id, { signal: opts.signal });
    }
  }

  // ── heartbeat ────────────────────────────────────────────────────────────

  const sendBeat = (
    state: AgentState,
    input: HeartbeatInput = {},
    o?: RequestOptions,
  ): Promise<AgentStatus> =>
    write<AgentStatus>(
      'POST',
      '/heartbeat',
      defined({ state, ticket: input.ticket, message: input.message, progress: input.progress }),
      o,
    );

  /**
   * Beat now, then every `everyMs` (60 s by default — the UI calls an agent
   * stale after 75 s of silence). The timer is unref'd where the runtime
   * allows it, so a forgotten beat never keeps a process alive.
   */
  function startBeat(
    input: HeartbeatInput & { everyMs?: number; onError?: (e: unknown) => void } = {},
  ): Beat {
    let state: 'working' | 'idle' = 'working';
    let message = input.message ?? null;
    let progress = input.progress ?? null;
    let running = true;
    const onError = input.onError ?? ((): void => void 0);
    const beat = (): Promise<AgentStatus> =>
      sendBeat(state, { ticket: input.ticket, message, progress });
    // A missed beat is not worth crashing an orchestrator over: report and carry on.
    const tick = (): void => void beat().catch(onError);
    const timer = setInterval(tick, input.everyMs ?? HEARTBEAT_INTERVAL_MS) as ReturnType<
      typeof setInterval
    > & { unref?: () => void };
    timer.unref?.();
    const stop = (): void => {
      if (!running) return;
      running = false;
      clearInterval(timer);
    };
    tick();
    return {
      get running() {
        return running;
      },
      update: (patch) => {
        if (patch.message !== undefined) message = patch.message;
        if (patch.progress !== undefined) progress = patch.progress;
        if (patch.state !== undefined) state = patch.state;
        return beat();
      },
      done: (patch = {}) => {
        stop();
        return sendBeat('done', {
          ticket: input.ticket,
          message: patch.message ?? message,
          progress,
        });
      },
      error: (msg) => {
        stop();
        return sendBeat('error', { ticket: input.ticket, message: msg ?? message, progress });
      },
      stop,
    };
  }

  // ── events ───────────────────────────────────────────────────────────────

  const ackEvents = (
    what: string[] | { upTo: string },
    o?: RequestOptions,
  ): Promise<{ acked: number }> =>
    write<{ acked: number }>(
      'POST',
      '/events/ack',
      Array.isArray(what) ? { ids: what } : { upTo: what.upTo },
      o,
    );

  /** See `boards` below: callable AND an object with `.list()`, `.create()`, `.setAgent()`. */
  const listBoards = (o?: RequestOptions): Promise<Page<Board>> =>
    get<Page<Board>>('/boards', undefined, o);
  const boardsAccessor: BoardsAccessor = Object.assign(listBoards, {
    list: async (o?: RequestOptions): Promise<Board[]> => (await listBoards(o)).data,
    create: (input: CreateBoardInput, o?: RequestOptions): Promise<Board> =>
      write<Board>(
        'POST',
        '/boards',
        defined({
          name: input.name,
          key: input.key,
          template: input.template,
          color: input.color,
          icon: input.icon,
        }),
        o,
      ),
    setAgent: (key: string, input: BoardAgentInput, o?: RequestOptions): Promise<{ ok: true }> =>
      write<{ ok: true }>(
        'POST',
        `/boards/${seg(key)}/agents`,
        defined({
          agent: input.agent,
          role: input.role,
          stage_grant:
            input.stageGrant === undefined
              ? undefined
              : input.stageGrant === null
                ? null
                : defined({
                    stages: input.stageGrant.stages,
                    assigned_only: input.stageGrant.assignedOnly,
                  }),
        }),
        o,
      ),
  });

  // ── artifacts (docs/plan/artifacts.html §C) ──────────────────────────────

  /**
   * PUBLISH. One request: the build zip as the body, or — when a source comes
   * with it — multipart with the parts `build` and `source`. The zips are made
   * (and checked) before anything is sent, so the Idempotency-Key and every
   * retry carry the very same bytes.
   */
  async function publishArtifact(
    id: string,
    input: ArtifactBuildInput,
    o: PublishArtifactOptions = {},
  ): Promise<ArtifactBuild> {
    const build = await buildZip(input);
    if (build.length > ARTIFACT_LIMITS.zipBytes)
      throw tooLarge(`the build zip is ${mb(build.length)}; at most ${mb(ARTIFACT_LIMITS.zipBytes)}`);
    const source =
      o.source === undefined
        ? undefined
        : await sourceZip(o.source, typeof input === 'string' ? input : undefined);
    // 64 kB of headroom for the multipart framing.
    if (source && build.length + source.length > ARTIFACT_LIMITS.requestBytes - 65_536)
      throw tooLarge(
        `build (${mb(build.length)}) + source (${mb(source.length)}) is over the ${mb(ARTIFACT_LIMITS.requestBytes)} ` +
          'one request may carry — publish without `source`, or pass a smaller source zip',
      );

    let rawBody: Blob | FormData;
    let headers: Record<string, string> | undefined;
    if (source) {
      // No content-type header: fetch writes multipart/form-data WITH its boundary.
      const form = new FormData();
      form.append('build', asBlob(build), 'build.zip');
      form.append('source', asBlob(source), 'source.zip');
      rawBody = form;
    } else {
      rawBody = asBlob(build);
      headers = { 'content-type': 'application/zip' };
    }
    return http.json<ArtifactBuild>({
      method: 'POST',
      path: `/artifacts/${seg(id)}/builds`,
      query: { message: o.message, source: source ? 1 : undefined },
      rawBody,
      headers,
      options: { ...req(o), timeoutMs: o.timeoutMs ?? PUBLISH_TIMEOUT_MS },
    });
  }

  return {
    /** The build this client came from (stamped in at build time). */
    version: VERSION,
    /** The /v1 root it talks to. */
    baseUrl: http.baseUrl,
    /** The transport itself — for a route the SDK does not wrap yet. */
    http,

    /** Who this token is: principal, board, role, scopes — and an agent's system prompt. */
    me: (o?: RequestOptions): Promise<Me> => get<Me>('/me', undefined, o),

    /**
     * The board this client is on: stages, priorities, tags, fields, members.
     *
     * `createClient` replaces this with an overload that ALSO takes a board
     * key — `tm.board('ENG')` returns a client pinned to ENG (§R2). Calling it
     * with no arguments, or with request options, is unchanged.
     */
    board: (o?: RequestOptions): Promise<Board> => get<Board>('/board', undefined, o),

    /**
     * Every board this credential may act on — exactly one for a board token,
     * and for an ACCOUNT token every board you are on RIGHT NOW (§R2), read
     * at this call rather than remembered.
     *
     * Callable (`await tm.boards()` → a page, as in phase 2) and an object
     * (`await tm.boards.list()` → just the boards), so nothing that already
     * works stops working.
     */
    boards: boardsAccessor,

    /** Find tickets by text. */
    search: (
      q: string,
      o: RequestOptions & { limit?: number } = {},
    ): Promise<{ data: SearchHit[] }> =>
      get<{ data: SearchHit[] }>('/search', { q, limit: o.limit }, o),

    tickets: {
      /** A page of tickets; `next_cursor` goes back in as `cursor`. */
      list: listTickets,
      /** `for await (const t of tm.tickets.iterate({ assignee: 'me' }))` */
      iterate: iterateTickets,
      /**
       * Only what changed since the last call — the read §W is built around.
       * Pair it with `tm.watch()` and an idle board costs one empty page.
       */
      changes: ticketChanges,
      /** The `updated_at` `changes()` will ask from next — persist it to resume. */
      watermark: (): string | undefined => ticketWatermark,
      /** One ticket, with links, pinned messages, files and optionally its last messages. */
      get: (key: string, o: RequestOptions & { messages?: number } = {}): Promise<TicketDetail> =>
        get<TicketDetail>(`/tickets/${seg(key)}`, { messages: o.messages }, o),
      create: (input: CreateTicketInput, o?: RequestOptions): Promise<Ticket> =>
        write<Ticket>('POST', '/tickets', ticketBody(input), o),
      update: (key: string, patch: TicketInput, o?: RequestOptions): Promise<Ticket> =>
        write<Ticket>('PATCH', `/tickets/${seg(key)}`, ticketBody(patch), o),
      /** Move to a stage, by name or id. */
      move: (key: string, stage: string, o?: RequestOptions): Promise<Ticket> =>
        write<Ticket>('POST', `/tickets/${seg(key)}/move`, { stage }, o),
      /** Archive or restore. (There is no 'cancelled' state: deleting is deleting.) */
      state: (key: string, state: TicketState, o: RequestOptions = {}): Promise<Ticket> =>
        write<Ticket>('POST', `/tickets/${seg(key)}/state`, { state }, o),
      /** Add and / or remove assignees without replacing the list. */
      assign: (
        key: string,
        change: { add?: PrincipalRef[]; remove?: PrincipalRef[] },
        o?: RequestOptions,
      ): Promise<Ticket> =>
        write<Ticket>(
          'POST',
          `/tickets/${seg(key)}/assignees`,
          defined({ add: change.add, remove: change.remove }),
          o,
        ),
    },

    messages: {
      /** A page of the thread, oldest first by default. */
      list: (
        key: string,
        o: RequestOptions & { cursor?: string; limit?: number; order?: 'asc' | 'desc' } = {},
      ): Promise<Page<Message>> =>
        get<Page<Message>>(
          `/tickets/${seg(key)}/messages`,
          { cursor: o.cursor, limit: o.limit, order: o.order },
          o,
        ),
      /**
       * Post Markdown, optionally with files from `files.upload`. An
       * orchestrator attaches `run` — the turn receipt — when a run ends.
       */
      post: (key: string, input: PostMessageInput, o?: RequestOptions): Promise<Message> =>
        write<Message>(
          'POST',
          `/tickets/${seg(key)}/messages`,
          defined({
            body_markdown: input.markdown ?? '',
            attachments: input.attachments,
            reply_to: input.replyTo,
            run: input.run ? runBody(input.run) : undefined,
          }),
          o,
        ),
    },

    files: {
      /** Every file on the ticket. */
      list: (key: string, o?: RequestOptions): Promise<{ data: TmFile[] }> =>
        get<{ data: TmFile[] }>(`/tickets/${seg(key)}/files`, undefined, o),
      /**
       * Put a file on a ticket. `text` makes .md / .html documents trivial;
       * `bytes` (or `base64`) carries anything else, up to 25 MB.
       */
      upload: (key: string, input: UploadInput, o?: RequestOptions): Promise<UploadedFile> => {
        const given = [input.text, input.base64, input.bytes].filter((v) => v !== undefined).length;
        if (given !== 1)
          throw new TypeError('files.upload: give exactly one of text, base64 or bytes');
        return write<UploadedFile>(
          'POST',
          `/tickets/${seg(key)}/files`,
          defined({
            name: input.name,
            mime: input.mime,
            text: input.text,
            content_base64: input.base64 ?? (input.bytes ? toBase64(input.bytes) : undefined),
          }),
          o,
        );
      },
      /** A file's metadata and a signed download URL (valid 15 minutes). */
      get: getFile,
      /**
       * The file's text — Markdown, HTML, text, CSV, JSON and code. Anything
       * else answers 422; use `get()` and its signed `url` for those.
       */
      read: async (fileId: string, o?: RequestOptions): Promise<string> =>
        (await getFile(fileId, { ...o, content: true })).content ?? '',
    },

    questions: {
      /**
       * Ask the people on a ticket a question with options. `await` the handle
       * for the Question itself; `.waitForAnswer()` waits for a person to submit.
       */
      ask: <const F extends readonly QuestionFieldInput[]>(
        key: string,
        input: AskInput<F>,
        o?: RequestOptions,
      ): AskHandle<F> =>
        new AskHandle<F>(
          write<Question>(
            'POST',
            `/tickets/${seg(key)}/questions`,
            defined({
              title: input.title,
              body_markdown: input.body,
              fields: questionFields(input.fields),
              allow_comment: input.allowComment,
              to: input.to,
              blocking: input.blocking,
              expires_at: input.expiresAt,
            }),
            o,
          ),
          (q, opts) => waitForAnswer<F>(q, opts),
        ),
      /** A question's status and, once given, its answer. */
      get: getQuestion,
      /** Cancel a question you asked — the card locks and nobody is chased for it. */
      cancel: (id: string, o?: RequestOptions): Promise<Question> =>
        write<Question>('POST', `/questions/${seg(id)}/cancel`, undefined, o),
      /** Wait on a question you already have (a resumed run, say). */
      waitForAnswer,
    },

    tasklists: {
      /** The ticket's task lists. */
      list: (key: string, o?: RequestOptions): Promise<{ data: Tasklist[] }> =>
        get<{ data: Tasklist[] }>(`/tickets/${seg(key)}/tasklists`, undefined, o),
      /** Publish a plan: creates the list, or replaces `listId` outright. */
      set: (key: string, input: SetTasklistInput, o?: RequestOptions): Promise<Tasklist> =>
        write<Tasklist>(
          // PUT wants the id in the path, so a new list is named here rather
          // than by the server: the very first attempt is then idempotent too.
          'PUT',
          `/tickets/${seg(key)}/tasklists/${seg(input.listId ?? randomId())}`,
          defined({
            title: input.title,
            items: taskItems(input.items),
            position: input.position,
            closed: input.closed,
          }),
          o,
        ),
      /** Tick one item off, start it, or mark it failed with a note. */
      item: (
        key: string,
        listId: string,
        itemId: string,
        patch: { status?: TaskItemStatus; note?: string | null },
        o?: RequestOptions,
      ): Promise<Tasklist> =>
        write<Tasklist>(
          'PATCH',
          `/tickets/${seg(key)}/tasklists/${seg(listId)}/items/${seg(itemId)}`,
          defined({ status: patch.status, note: patch.note }),
          o,
        ),
      /** Remove a task list from the ticket. */
      delete: (key: string, listId: string, o?: RequestOptions): Promise<{ deleted: true }> =>
        write<{ deleted: true }>(
          'DELETE',
          `/tickets/${seg(key)}/tasklists/${seg(listId)}`,
          undefined,
          o,
        ),
    },

    heartbeat: {
      /** One beat, by hand. `start()` is what an orchestrator normally wants. */
      send: sendBeat,
      /** A beat now and every minute after, until `done()`, `error()` or `stop()`. */
      start: startBeat,
    },

    agents: {
      /** What every agent on the board is doing (needs `members:read`). */
      status: (o: RequestOptions & { ticket?: string } = {}): Promise<{ data: AgentStatus[] }> =>
        get<{ data: AgentStatus[] }>('/agents/status', { ticket: o.ticket }, o),
      /**
       * §Z2 — create an agent profile you own (ACCOUNT tokens, `agents:write`).
       * Put it on a board with `boards.setAgent()`; minting a token for it
       * stays with a person (Account › Tokens).
       */
      create: (input: CreateAgentInput, o?: RequestOptions): Promise<Agent> =>
        write<Agent>(
          'POST',
          '/agents',
          defined({
            id: input.id,
            name: input.name,
            description: input.description,
            system_prompt: input.systemPrompt,
            avatar: input.avatar,
            icon: input.icon,
          }),
          o,
        ),
    },

    events: {
      /** A page of the inbox, oldest first, from `cursor`. */
      list: (q: EventQuery = {}): Promise<EventPage> =>
        get<EventPage>(
          '/events',
          { cursor: q.cursor, limit: q.limit, unacked: q.unacked ? 1 : undefined },
          q,
        ),
      /** Acknowledge events by id, or everything up to a cursor. */
      ack: ackEvents,
      /**
       * The inbox as an async iterator over Server-Sent Events. Resumes from
       * its cursor and reconnects on its own — the server ends every stream at
       * ~50 s (it lives inside a 60 s function), which is normal, not an error.
       *
       *   for await (const ev of tm.events.stream({ ack: true })) …
       *
       * ⚠ THE EXPENSIVE ONE (§W). This holds a Cloud Run request open, and
       * Cloud Run bills CPU for a request's WHOLE LIFE — waiting on I/O
       * included. An always-connected agent on this stream is the single most
       * expensive thing this API offers: it is billed for every second it
       * waits, whether or not an event ever arrives. Prefer `tm.watch()` (or
       * `tm.work()`, which uses it), which waits on the Realtime Database —
       * held by Google's edge, billed by bandwidth — and touches the function
       * only when something actually changed. This stays for the cases that
       * genuinely want a push feed inside one short-lived process.
       */
      stream: (opts: StreamOptions = {}): AsyncGenerator<TmEvent> =>
        streamEvents(http, ackEvents, opts),
    },

    /**
     * §W — the credential `tm.watch()` opens its Realtime Database stream
     * with: `GET /v1/live` mints a short-lived one (about an hour) for this
     * token, with `paths` naming exactly the nodes it may stream. You rarely
     * call this yourself: `watch()` asks for it and re-mints as it expires.
     */
    live: (o?: RequestOptions): Promise<LiveCredential> =>
      get<LiveCredential>('/live', undefined, o),

    /**
     * §W — WAKE, DO NOT POLL. One streaming connection to the RTDB node the
     * command layer bumps; a signal out of it only when something actually
     * changed; and then ONE delta fetch. An idle orchestrator costs nothing.
     * Falls back to polling — on a backoff, seconds to a minute — wherever a
     * stream cannot be opened. See src/watch.ts for the full reasoning.
     *
     *   const w = tm.watch();
     *   for await (const _ of w) {
     *     const page = await tm.events.list({ cursor, unacked: true });
     *     …
     *     w.found(page.data.length);
     *   }
     */
    watch: (o: WatchOptions = {}): Watcher =>
      createWatcher(
        {
          now: http.now,
          sleep: http.sleep,
          // The RTDB takes `?auth=`, never an Authorization header, so this
          // is the caller's own fetch with none of the SDK's headers on it.
          fetch:
            options.fetch ??
            (((input, init) =>
              (globalThis as { fetch: FetchLike }).fetch(input, init)) as FetchLike),
          live: (opts) => get<LiveCredential>('/live', undefined, opts),
          me: (opts) => get<Me>('/me', undefined, opts),
        },
        { ...(options.live !== undefined ? { live: options.live } : {}), ...o },
      ),

    webhooks: {
      list: (o: RequestOptions & { board?: string } = {}): Promise<Page<Webhook>> =>
        get<Page<Webhook>>('/webhooks', { board: o.board }, o),
      create: (
        input: { board: string; url: string; events: WebhookEvent[]; active?: boolean },
        o?: RequestOptions,
      ): Promise<Webhook & { secret?: string }> =>
        write<Webhook & { secret?: string }>('POST', '/webhooks', input, o),
      update: (
        id: string,
        patch: Partial<{
          url: string;
          events: WebhookEvent[];
          active: boolean;
          rotate_secret: boolean;
        }>,
        o?: RequestOptions,
      ): Promise<Webhook & { secret?: string }> =>
        write<Webhook & { secret?: string }>('PATCH', `/webhooks/${seg(id)}`, patch, o),
      delete: (id: string, o?: RequestOptions): Promise<void> =>
        write<void>('DELETE', `/webhooks/${seg(id)}`, undefined, o),
    },

    /**
     * ARTIFACTS (docs/plan/artifacts.html) — small static websites kept and
     * served by TaskManager, each with its own people and its own data. They
     * are not on a board, so nothing here takes one: an ACCOUNT token reaches
     * every artifact you own or edit, an AGENT token only the artifacts that
     * agent is on — and there what it may do is its `agent_access`
     * { build, data } (§AA3): `build` to publish, roll back and read the
     * source; `data` to use `artifacts.data(id)`. An agent never owns, shares,
     * renames or deletes an artifact. Scopes: `artifacts:read` (list, get,
     * source, data reads) and `artifacts:write` (everything else).
     *
     *   const art = await tm.artifacts.create({ name: 'Sales dashboard' });
     *   const build = await tm.artifacts.publish(art.id, './dist', { source: './', message: 'first cut' });
     *   await tm.artifacts.share(art.id, { email: 'priya@example.com', role: 'viewer' });
     *   // people open it at art.url — {app}/x/{id}
     */
    artifacts: {
      /** Every artifact this credential can reach. */
      list: async (o?: RequestOptions): Promise<Artifact[]> =>
        (await get<Page<Artifact>>('/artifacts', undefined, o)).data,
      /** One artifact, with its kept builds (newest first) and who it is shared with. */
      get: (id: string, o?: RequestOptions): Promise<ArtifactDetail> =>
        get<ArtifactDetail>(`/artifacts/${seg(id)}`, undefined, o),
      /** Create an empty artifact; you become its owner (with an agent token: the agent's owner does, and the agent may build it and write its data). */
      create: (input: CreateArtifactInput, o?: RequestOptions): Promise<Artifact> =>
        write<Artifact>(
          'POST',
          '/artifacts',
          defined({ name: input.name, description: input.description, icon: input.icon }),
          o,
        ),
      /** Rename, describe, set read-only for viewers, archive or restore (owner). */
      update: (id: string, patch: UpdateArtifactInput, o?: RequestOptions): Promise<Artifact> =>
        write<Artifact>(
          'PATCH',
          `/artifacts/${seg(id)}`,
          defined({
            name: patch.name,
            description: patch.description,
            icon: patch.icon,
            read_only: patch.readOnly,
            archived: patch.archived,
          }),
          o,
        ),
      /** Delete the artifact with its builds, its files and ALL its data (owner). There is no undo. */
      delete: (id: string, o?: RequestOptions): Promise<void> =>
        write<void>('DELETE', `/artifacts/${seg(id)}`, undefined, o),
      /**
       * Publish a build; it becomes the current one at once and never touches
       * the artifact's data. `input` is the build FOLDER (the one with
       * index.html at its root): a directory path, the bytes of a zip, or
       * files in memory — see `ArtifactBuildInput`. `build.warnings` names
       * anything that will show a blank page (absolute `/assets/…` paths:
       * set Vite's `base: './'`).
       */
      publish: publishArtifact,
      /** Make a kept build the current one — back, or forward again. */
      rollback: (id: string, buildId: string, o?: RequestOptions): Promise<Artifact> =>
        write<Artifact>('POST', `/artifacts/${seg(id)}/builds/${seg(buildId)}/current`, undefined, o),
      /**
       * A short-lived URL for the source zip published beside a build — the
       * newest build that has one, unless `buildId` names another. GET it
       * with a plain fetch: it needs no Authorization header.
       */
      source: (id: string, buildId?: string, o?: RequestOptions): Promise<ArtifactSource> =>
        get<ArtifactSource>(`/artifacts/${seg(id)}/source`, { build: buildId }, o),
      /**
       * Share with a person (by email) or one of your agents, change what
       * they may do, or remove them. Owner only — never an agent. A person
       * takes a `role` (null removes; with no account yet they are invited:
       * `outcome: 'invited'`). An agent takes `access: { build, data }` (§AA3;
       * `{ build: false, data: 'none' }` removes it).
       */
      share: (id: string, input: ShareArtifactInput, o?: RequestOptions): Promise<ArtifactShareResult> => {
        if ((input.email === undefined) === (input.agent === undefined))
          throw new TypeError('artifacts.share: give exactly one of email or agent');
        if (input.email !== undefined && input.access !== undefined)
          throw new TypeError('artifacts.share: `access` is for an agent — a person takes a role');
        if (input.role === undefined && input.access === undefined)
          throw new TypeError('artifacts.share: give role — or, for an agent, access: { build, data }');
        return write<ArtifactShareResult>(
          'PUT',
          `/artifacts/${seg(id)}/access`,
          defined({
            email: input.email,
            agent: input.agent,
            role: input.role,
            agent_access: input.access
              ? { build: input.access.build, data: input.access.data }
              : undefined,
          }),
          o,
        );
      },
      /**
       * §AA4 — the artifact's own Firestore, Realtime Database and files,
       * from OUTSIDE the page: the same documents the page reads through its
       * driver. Needs `data` on the artifact (an agent: 'read' for the reads,
       * 'write' for the rest; a person: owner or editor). See src/data.ts.
       *
       *   const data = tm.artifacts.data(art.id);
       *   await data.firestore.batch(rows.map((r) => ({ op: 'set', path: `sales/${r.id}`, data: r })));
       *
       * `{ raw: true }` leaves timestamps as `{ "$date": ISO }` instead of `Date`.
       */
      data: (id: string, opts?: ArtifactDataOptions): ArtifactData =>
        createArtifactData(http, id, opts),
    },

    /** Any /v1 route the SDK does not wrap, with the same retries and errors. */
    request: <T>(
      method: string,
      path: string,
      init: { query?: Record<string, QueryValue>; body?: unknown } & RequestOptions = {},
    ): Promise<T> =>
      http.json<T>({ method, path, query: init.query, body: init.body, options: req(init) }),
  };
}

/**
 * The SSE loop behind `tm.events.stream()`. A generator of its own so it can
 * close its reader on abort, and so the client object's type stays flat.
 */
async function* streamEvents(
  http: Http,
  ack: (ids: string[], o?: RequestOptions) => Promise<{ acked: number }>,
  opts: StreamOptions,
): AsyncGenerator<TmEvent> {
  let cursor = opts.cursor;
  let failures = 0;
  const reconnectMs = opts.reconnectMs ?? 1_000;
  const giveUp = (): boolean => opts.maxReconnects !== undefined && ++failures > opts.maxReconnects;

  for (;;) {
    if (opts.signal?.aborted) return;
    let res: Response;
    try {
      res = await http.raw({
        method: 'GET',
        path: '/events/stream',
        query: { cursor, limit: opts.limit, unacked: opts.unacked ? 1 : undefined },
        headers: { accept: 'text/event-stream', ...(cursor ? { 'last-event-id': cursor } : {}) },
        // No per-attempt timeout: a stream is meant to stay open.
        options: { ...req(opts), timeoutMs: 0 },
        idempotent: false,
      });
    } catch (e) {
      if ((e as TmError)?.code === 'aborted' || opts.signal?.aborted) return;
      if (giveUp()) throw e;
      await sleepQuietly(http, reconnectMs * Math.min(8, failures), opts.signal);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new TmError({
        code:
          res.status === 401
            ? 'unauthenticated'
            : res.status === 403
              ? 'forbidden'
              : res.status >= 500
                ? 'internal'
                : 'invalid',
        status: res.status,
        message: `GET /events/stream — HTTP ${res.status} ${text.slice(0, 200)}`.trim(),
        method: 'GET',
        url: '/events/stream',
      });
      // A 401 or a 403 will not fix itself; a 429 or a 5xx might.
      if (res.status < 500 && res.status !== 429) throw err;
      if (giveUp()) throw err;
      await sleepQuietly(http, reconnectMs * Math.min(8, failures), opts.signal);
      continue;
    }

    failures = 0;
    if (!res.body) {
      await sleepQuietly(http, reconnectMs, opts.signal);
      continue;
    }
    try {
      for await (const frame of readSse(res.body, opts.signal)) {
        if (frame.event !== 'event' || !frame.data) continue; // 'ping' keep-alives
        let ev: TmEvent;
        try {
          ev = JSON.parse(frame.data) as TmEvent;
        } catch {
          continue; // one unreadable frame is not worth ending the loop
        }
        cursor = frame.id ?? ev.id;
        yield ev;
        // Acked only AFTER the consumer took it, so a crash mid-handler replays it.
        if (opts.ack) await ack([ev.id], { signal: opts.signal }).catch(() => void 0);
      }
    } catch (e) {
      if (opts.signal?.aborted) return;
      if (giveUp()) throw e;
    }
    if (opts.signal?.aborted) return;
    // The server ends every stream at ~50 s. Pick up where we got to.
    await sleepQuietly(http, reconnectMs, opts.signal);
  }
}

async function sleepQuietly(http: Http, ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await http.sleep(ms, signal);
  } catch {
    /* aborted — the loop checks signal.aborted next */
  }
}

/**
 * The orchestrator loop from §M, bolted onto the client:
 *
 *   await tm.work(async ({ ticket, beat, tm }) => { … }, { concurrency: 2 })
 *
 * It lives here rather than inside `createClientBase` so that `WorkContext`
 * can hand the handler a whole client without the client's type referring to
 * itself.
 */
/**
 * `tm.boards` — §R2. Call it for the raw page, or use `.list()` for just the
 * boards. With an account token this is the first thing you call.
 */
export interface BoardsAccessor {
  (o?: RequestOptions): Promise<Page<Board>>;
  /** Every board you can reach right now. */
  list(o?: RequestOptions): Promise<Board[]>;
  /** §Z2 — create a board (ACCOUNT tokens, `boards:create`); you become its admin. */
  create(input: CreateBoardInput, o?: RequestOptions): Promise<Board>;
  /**
   * §Z2 — put an agent you own on a board with a role, change the role, or
   * remove it (`role: null`). ACCOUNT tokens; you must be a board admin.
   */
  setAgent(key: string, input: BoardAgentInput, o?: RequestOptions): Promise<{ ok: true }>;
}

/**
 * `tm.board` — §R2, two jobs behind one name:
 *   `await tm.board()`   the board this client is on (phase 2, unchanged)
 *   `tm.board('ENG')`    a client pinned to ENG: THE SAME API, every call
 *                        scoped to that board. Synchronous — it costs nothing
 *                        and makes no request.
 */
export interface BoardAccessor {
  (o?: RequestOptions): Promise<Board>;
  (key: string): TmClient;
}

export interface TmClient extends Omit<TmClientBase, 'board' | 'boards'> {
  board: BoardAccessor;
  boards: BoardsAccessor;
  /**
   * The whole orchestrator loop: WAIT to be woken (§W — `tm.watch()`, not the
   * billed-by-the-second SSE stream), fetch only what is new, run `handler`
   * for each event, keep a heartbeat alive while it runs, mark it done or
   * error, and ack it on success.
   */
  work(handler: WorkHandler, opts?: WorkOptions): Promise<WorkSummary>;
  /**
   * §R2 — WHICH KIND OF TOKEN IS THIS? 'board' (one board), 'account'
   * ("virtual me": every board you are on), 'agent' (§AA1: the agent's one
   * token — every board the AGENT is on) or 'oauth'. It asks GET /v1/me once
   * and remembers the answer, so calling it in a loop is free.
   *
   *   if ((await tm.kind()) === 'account') for (const b of await tm.boards.list()) …
   */
  kind(opts?: RequestOptions): Promise<TokenKind>;
}

/**
 * The SDK's entry point: a typed client for one token (docs/plan/agents.html §M).
 *
 *   const tm = createClient({ token: process.env.TM_TOKEN })
 *
 * A board token names one board and one identity, so nothing here takes a
 * board. An account token (§R2) reaches every board you are on: ask
 * `tm.kind()`, list them with `tm.boards.list()`, and work on one with
 * `tm.board('ENG')`, which returns this same API scoped to ENG.
 *
 * §AA1 — AN AGENT TOKEN is one per agent and says only WHO the agent is: it
 * reaches every board the agent is on, and what it may do there is the
 * agent's role on that board. So it is in the account token's position. On
 * exactly one board nothing needs naming; on several, every board-scoped
 * call must name the board — `createClient({ token, board: 'ENG' })` or
 * `tm.board('ENG')` — or it answers 400 `invalid` with the keys in
 * `problem.options`. (A token converted from an old board token falls back
 * to its old board, `me.default_board`. Do not build on that: name the board.)
 */
export function createClient(options: ClientOptions): TmClient {
  const base = createClientBase(options);

  /*
   * §R2, §AA1 — ONE API, WHATEVER THE TOKEN. `tm.board('ENG')` builds a SECOND
   * client over the same options with the board pinned (Http adds board=ENG
   * to every call), so everything a board token can do, an account token can
   * (or an agent token) can do on any of its boards, with the identical code:
   *
   *   const eng = tm.board('ENG');
   *   await eng.tickets.list();          // exactly as with a board token
   *
   * A board token may do this too — with its own board's key, which is what
   * makes code written for one kind of token run unchanged on the other.
   */
  const board = ((arg?: string | RequestOptions) =>
    typeof arg === 'string'
      ? createClient({ ...options, board: arg })
      : base.board(arg)) as BoardAccessor;

  // Asked once, then remembered: the kind of a token cannot change.
  let kindOnce: Promise<TokenKind> | undefined;

  const client: TmClient = {
    ...base,
    board,
    work: (handler, opts) =>
      workLoop(
        {
          stream: base.events.stream,
          watch: base.watch,
          list: base.events.list,
          ack: base.events.ack,
          startBeat: base.heartbeat.start,
        },
        client,
        handler,
        opts,
      ),
    kind: (opts?: RequestOptions) => {
      kindOnce ??= base.me(opts).then(
        (me) => me.kind,
        (e: unknown) => {
          kindOnce = undefined; // a failed lookup must not be remembered
          throw e;
        },
      );
      return kindOnce;
    },
  };
  return client;
}
