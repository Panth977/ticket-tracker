/**
 * ADAPTER INTERFACES. Every external service sits behind one of these; the
 * backend supplies a dev fake (emulator-only, no credentials) and a real
 * client that switches on only when its env vars are set. Commands depend on
 * these interfaces, never on a provider SDK.
 */
import type { WebhookData } from '../api/webhook.js';
import type { CommandCtx } from '../commands/define.js';
import type { TicketDoc } from '../schema/realtime.js';
import type { TicketWithId } from '../schema/ticket.js';
import type { Envelope } from '../types/platform.js';
import type {
  BoardId,
  Channel,
  Millis,
  NotifyEvent,
  StageCategory,
  TicketId,
  TicketState,
  Uid,
  WebhookEvent,
} from '../types/index.js';

// ─── email (Resend) ──────────────────────────────────────────────────────────

export interface EmailMessage {
  to: string;
  /** Defaults to the app's sender; never a free-text address from a user. */
  from?: string;
  /** t.{replyToken}@in.taskmanager.app for threads that accept replies. */
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  /** Message-ID / In-Reply-To / References for threading, List-Unsubscribe … */
  headers?: Record<string, string>;
  /** Template name, for logs and the dev outbox ('invite', 'digest', 'notify' …). */
  tag?: string;
}
export interface EmailSender {
  send(msg: EmailMessage): Promise<{ providerId: string | null }>;
}

// ─── push (FCM) ──────────────────────────────────────────────────────────────

export interface PushMessage {
  title: string;
  body: string;
  /** Deep link opened on click, e.g. '/t/ENG-42'. */
  url?: string;
  /** Collapses notifications with the same tag on the device (groupKey). */
  tag?: string;
  data?: Record<string, string>;
}
export interface PushResult {
  token: string;
  ok: boolean;
  /** FCM said the token is gone — the caller deletes the device doc. */
  unregistered?: boolean;
  providerId?: string | null;
  error?: string;
}
export interface PushSender {
  send(tokens: string[], msg: PushMessage): Promise<PushResult[]>;
}

// ─── WhatsApp (Meta Cloud API) ───────────────────────────────────────────────

export interface WhatsappSender {
  /** Business-initiated: only approved templates (outside the 24h window). 'otp', 'notify' … */
  sendTemplate(
    toE164: string,
    template: string,
    params: string[],
    lang?: string,
  ): Promise<{ providerId: string | null }>;
  /** Free-form: only inside 24h of the person's last inbound message. */
  sendText(toE164: string, text: string): Promise<{ providerId: string | null }>;
}

// ─── search (Typesense) ──────────────────────────────────────────────────────

export interface SearchQuery {
  q: string;
  /** Always scoped: only boards the caller can read. */
  boardIds: BoardId[];
  stageCategory?: StageCategory[];
  assigneeUids?: Uid[];
  state?: TicketState[];
  limit?: number;
}
export interface SearchHit {
  id: TicketId;
  boardId: BoardId;
  key: string;
  title: string;
  /** Highlighted fragment, plain text with the match wrapped in <mark>. */
  snippet?: string;
  score?: number;
}
export interface SearchIndex {
  upsert(doc: TicketDoc): Promise<void>;
  delete(ticketId: TicketId): Promise<void>;
  /** A key the browser searches with directly; filter_by boardId:[…], expires. */
  scopedKey(boardIds: BoardId[], expiresAt: Millis): Promise<{ key: string; host: string }>;
  /** Server-side search (REST /v1/search, MCP search_tickets). */
  search(q: SearchQuery): Promise<{ hits: SearchHit[]; found: number }>;
}

// ─── task queues (Cloud Tasks via onTaskDispatched) ─────────────────────────

/** deliver/{uid}:{groupKey}:{minute} — a burst in a minute becomes ONE push and ONE email. */
export interface DeliverTask {
  uid: Uid;
  groupKey: string;
  inboxIds: string[];
  channels: Exclude<Channel, 'inApp'>[];
}
export interface WebhookTask {
  boardId: BoardId;
  event: WebhookEvent | 'ping';
  envelope: Envelope;
  /** Target a single webhook (the 'ping' on save); absent = fan out to all matching. */
  webhookId?: string;
}
/** Every queue and its payload. Extend here (contracts) when a new queue appears. */
export interface QueuePayloads {
  deliver: DeliverTask;
  webhooks: WebhookTask;
  /** boardArchive 'delete': recursive delete of tickets, threads, files. */
  boardDelete: { boardId: BoardId; actor: Uid };
  /**
   * artifactDelete / artifactDataClear (artifacts.html §G): the artifact's
   * Firestore subtree, RTDB nodes and Storage prefixes. `dataOnly` keeps the
   * builds, the people and the document (the owner's 'Delete all data').
   */
  artifactDelete: { artifactId: string; actor: Uid; dataOnly?: boolean };
  /** accountExport. */
  export: { jobId: string; uid: Uid };
  /** Generic e-mail outside notify (invites, export ready …). */
  email: { to: string; template: string; params: Record<string, unknown> };
}
export type QueueName = keyof QueuePayloads;
export interface EnqueueOptions {
  /** Task name — DEDUPLICATES: a second enqueue with the same name is dropped. */
  name?: string;
  delaySeconds?: number;
}
export interface TaskQueue {
  enqueue<Q extends QueueName>(
    queue: Q,
    payload: QueuePayloads[Q],
    opts?: EnqueueOptions,
  ): Promise<void>;
}

// ─── time and ids ────────────────────────────────────────────────────────────

export interface Clock {
  now(): Millis;
}
export interface IdGen {
  /** 20-char Firestore-style document id. */
  id(): string;
  /** 7-char base36 board-local id (stages, options). */
  shortId(): string;
  /** URL-safe random secret with `bytes` of entropy (invite tokens, API keys, webhook secrets). */
  token(bytes?: number): string;
}

// ─── Cloud Storage ───────────────────────────────────────────────────────────

export interface StoredObject {
  path: string;
  size: number;
  contentType: string;
  /** Storage custom metadata (e.g. width / height / thumbPath stamped by onAttachmentFinalized). */
  metadata?: Record<string, string>;
}
export interface StorageFiles {
  stat(path: string): Promise<StoredObject | null>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array, contentType: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  delete(path: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  list(prefix: string): Promise<StoredObject[]>;
  signedUploadUrl(path: string, contentType: string, expiresAt: Millis): Promise<string>;
  signedDownloadUrl(path: string, expiresAt: Millis): Promise<string>;
}

// ─── the two side-effect functions every command calls after commit ────────

export interface NotifyExtra {
  /** Required when `ticket` is null ('invited'). */
  boardId?: BoardId;
  inviteId?: string;
  messageId?: string;
  /** 'mentioned': exactly these people, unconditionally. */
  mentioned?: Uid[];
  /** Explicit recipients (e.g. new assignees for 'assigned', the invitee for 'invited'). */
  recipients?: Uid[];
  /** Never notify these (e.g. people already pinged as 'mentioned'). */
  exclude?: Uid[];
  /** diff(before, after) for 'updated' / 'stage' copy. */
  changes?: Record<string, { from: unknown; to: unknown }>;
  /** Override the inbox summary line. */
  summary?: string;
}

/**
 * notify(event, ticket, ctx, extra) — the ONE router for every event and
 * channel. Writes inbox rows and ENQUEUES deliveries; never sends inline.
 * The actor is never notified.
 */
export type NotifyFn = (
  event: NotifyEvent,
  ticket: TicketWithId | null,
  ctx: CommandCtx,
  extra?: NotifyExtra,
) => Promise<void>;

/**
 * emitWebhook(boardId, event, data, ctx) — builds the Envelope (id 'evt_…',
 * createdAt, actor from ctx) and enqueues it on the `webhooks` queue.
 */
export type EmitWebhookFn = <E extends WebhookEvent>(
  boardId: BoardId,
  event: E,
  data: WebhookData<E>,
  ctx: CommandCtx,
) => Promise<void>;

/** Everything a command may reach outside Firestore. */
export interface Ports {
  email: EmailSender;
  push: PushSender;
  whatsapp: WhatsappSender;
  search: SearchIndex;
  queue: TaskQueue;
  clock: Clock;
  ids: IdGen;
  files: StorageFiles;
  notify: NotifyFn;
  emitWebhook: EmitWebhookFn;
}
