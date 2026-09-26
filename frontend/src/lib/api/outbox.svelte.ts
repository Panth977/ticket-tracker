/**
 * The outbox (agents.html § K): every write goes in here, so no click waits
 * for the server.
 *
 *   outbox.queue('ticketUpdate', { boardId, ticketId, patch }, {
 *     label: 'change the stage of ENG-4',
 *     optimistic: { path: paths.ticket(boardId, ticketId), patch },
 *     openTo: routes.ticket('ENG-4'),
 *   });
 *
 * queue() applies the optimistic change at once and returns; the command runs
 * in the background. A transient failure (network, 5xx, 429) is retried up to
 * MAX_RETRIES times with backoff; offline, the entry waits and resumes on the
 * browser's 'online' event. Anything else fails for good: the entry stays,
 * still showing its optimistic change, and `onFailure` (the app: a sticky
 * toast) offers Open (go back and put the change back in the form) and Cancel
 * (discard + roll back).
 *
 * The entry id is the command's clientId, so a retry is ONE change on the
 * server (messagePost even uses it as the message id).
 *
 * Entries with a draft (messages, ticket creates) are persisted per user
 * (IndexedDB, localStorage fallback — see outboxStore.ts) and re-sent on the
 * next visit. Their optimistic look is rebuilt from the entry itself (the
 * thread draws message entries as bubbles; the board draws create entries as
 * pending cards), which is why they survive a reload while closures do not.
 */
import {
  isAppError,
  type AppError,
  type AppErrorCode,
  type CommandName,
  type CommandRes,
} from '@tm/shared';
import type { CommandInput, OptimisticSpec } from './command';

export type OutboxStatus =
  /** Waiting its turn / about to send. */
  | 'queued'
  | 'sending'
  /** Transient failure; sends again at `nextAt`. */
  | 'retrying'
  /** The browser is offline; resumes on 'online'. */
  | 'offline'
  /** Refused, or out of retries. Stays until Resend / Cancel / Open. */
  | 'failed'
  /** Done; lingers briefly so the UI can show ✓ until the live data catches up. */
  | 'sent';

export interface OutboxUpload {
  id: string;
  name: string;
  size: number;
  mime: string;
  path: string;
  /** 0..1 */
  progress: number;
  status: 'uploading' | 'done' | 'error';
  error?: string;
}

/** What the outbox keeps (JSON only: persisted entries go to IndexedDB). */
export interface OutboxEntry {
  id: string;
  uid: string;
  command: CommandName;
  input: Record<string, unknown>;
  /** Groups entries for the UI: 'message', 'ticketCreate', 'ticket', 'settings', 'view', … */
  kind: string;
  /** Verb phrase for toasts / the sync list: “create “Fix login copy””. */
  label: string;
  status: OutboxStatus;
  attempts: number;
  error?: string;
  errorCode?: AppErrorCode;
  createdAt: number;
  nextAt?: number;
  boardId?: string;
  ticketId?: string;
  /** Whatever the originating form needs to put the change back (Open). */
  draft?: unknown;
  /** Where Open goes. */
  openTo?: string;
  persist: boolean;
  result?: unknown;
  /** Attachments still uploading (messages). */
  uploads?: OutboxUpload[];
}

export interface QueueOptions<N extends CommandName> {
  /** Reuse an id (the clientId). */
  id?: string;
  kind?: string;
  label?: string;
  /** Applied right away, rolled back on Cancel (and settled shortly after success). */
  optimistic?: OptimisticSpec;
  /** Extra undo run on Cancel (after the optimistic rollback). */
  rollback?: () => void;
  draft?: unknown;
  openTo?: string;
  /** Default: true when there is a draft. */
  persist?: boolean;
  boardId?: string;
  ticketId?: string;
  uploads?: OutboxUpload[];
  /**
   * Runs before each send and may rewrite the input (e.g. wait for uploads).
   * Throwing an AppError fails the attempt like a server refusal would.
   */
  prepare?: (entry: OutboxEntry) => Promise<Record<string, unknown> | void>;
  onSuccess?: (res: CommandRes<N>, entry: OutboxEntry) => void;
  /** Return true when the error was handled here: the entry is dropped and rolled back, no toast. */
  onError?: (err: AppError, entry: OutboxEntry) => boolean;
  /** ms a sent entry stays (status 'sent') before it is removed. Default 0. */
  linger?: number;
}

export interface OutboxStorage {
  load(uid: string): Promise<OutboxEntry[]>;
  save(entry: OutboxEntry): Promise<void>;
  remove(uid: string, id: string): Promise<void>;
}

export interface OutboxDeps {
  /** Sends one command, no toast, no optimistic handling; throws AppError. */
  send(command: CommandName, input: Record<string, unknown>, clientId: string): Promise<unknown>;
  isOnline(): boolean;
  storage: OutboxStorage;
  applyOptimistic(spec: OptimisticSpec | undefined): () => void;
  /** An entry failed for good (the app shows a sticky toast). */
  onFailure?(entry: OutboxEntry): void;
  /** An entry left the failed state (resent, cancelled, opened) — hide its toast. */
  onResolved?(entry: OutboxEntry): void;
  navigate?(to: string, entry: OutboxEntry): void;
  newId(): string;
  now?(): number;
  /** Backoff before retry n (1-based). */
  backoffMs?: (attempt: number) => number;
  /** How long a successful optimistic overlay outlives the response. */
  settleMs?: number;
}

export const MAX_RETRIES = 3;
/** 1 s, 3 s, 9 s (+ jitter). */
export const defaultBackoff = (n: number) => 1000 * 3 ** (n - 1) + Math.floor(Math.random() * 250);

/** Worth trying again: the server or the network, not the request. */
export function isTransient(code: AppErrorCode | undefined): boolean {
  return (
    code === 'unavailable' ||
    code === 'internal' ||
    code === 'rate_limited' ||
    code === 'unauthenticated'
  );
}

interface Runtime {
  undo: () => void;
  prepare?: QueueOptions<CommandName>['prepare'];
  onSuccess?: (res: unknown, entry: OutboxEntry) => void;
  onError?: QueueOptions<CommandName>['onError'];
  linger: number;
  resolve: (res: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface Queued<N extends CommandName> {
  id: string;
  /** The command's result; null when the entry was cancelled / handled. Never rejects. */
  done: Promise<CommandRes<N> | null>;
}

export class Outbox {
  entries = $state<OutboxEntry[]>([]);
  /** Set by open(): the destination consumes it (take()) to restore the form. */
  opening = $state<OutboxEntry | null>(null);
  uid = $state<string | null>(null);

  // Closures only, never rendered: a plain Map on purpose.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  private rt = new Map<string, Runtime>();
  private deps: OutboxDeps;

  constructor(deps: OutboxDeps) {
    this.deps = deps;
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  // ——— reading
  get(id: string): OutboxEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }
  /** Still on its way (not failed, not sent). */
  get pending(): OutboxEntry[] {
    return this.entries.filter((e) => e.status !== 'failed' && e.status !== 'sent');
  }
  get failed(): OutboxEntry[] {
    return this.entries.filter((e) => e.status === 'failed');
  }
  ofKind(kind: string): OutboxEntry[] {
    return this.entries.filter((e) => e.kind === kind);
  }
  /** Message entries of one ticket (the thread draws them as bubbles). */
  messages(ticketId: string): OutboxEntry[] {
    return this.entries.filter((e) => e.kind === 'message' && e.ticketId === ticketId);
  }
  /** Tickets with a message that has not gone out yet (⚠ on cards, My work, the thread header). */
  get unsentTickets(): Set<string> {
    // A fresh set per read (derived from the reactive entries).
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const s = new Set<string>();
    for (const e of this.entries)
      if (e.kind === 'message' && e.ticketId && e.status !== 'sent') s.add(e.ticketId);
    return s;
  }
  hasUnsent(ticketId: string | null | undefined): boolean {
    return (
      !!ticketId &&
      this.entries.some(
        (e) => e.kind === 'message' && e.ticketId === ticketId && e.status !== 'sent',
      )
    );
  }

  // ——— writing
  private patch(id: string, p: Partial<OutboxEntry>) {
    let next: OutboxEntry | undefined;
    this.entries = this.entries.map((e) => (e.id === id ? (next = { ...e, ...p }) : e));
    if (next?.persist) void this.deps.storage.save(snapshot(next)).catch(() => {});
    return next;
  }

  queue<N extends CommandName>(
    command: N,
    input: CommandInput<N>,
    opts: QueueOptions<N> = {},
  ): Queued<N> {
    const id = opts.id ?? this.deps.newId();
    const persist = opts.persist ?? opts.draft !== undefined;
    const entry: OutboxEntry = {
      id,
      uid: this.uid ?? '',
      command,
      input: { ...(input as Record<string, unknown>) },
      kind: opts.kind ?? command,
      label: opts.label ?? 'save a change',
      status: 'queued',
      attempts: 0,
      createdAt: this.now(),
      persist,
      ...((opts.boardId ?? (input as { boardId?: string }).boardId)
        ? { boardId: opts.boardId ?? (input as { boardId?: string }).boardId }
        : {}),
      ...((opts.ticketId ?? (input as { ticketId?: string }).ticketId)
        ? { ticketId: opts.ticketId ?? (input as { ticketId?: string }).ticketId }
        : {}),
      ...(opts.draft !== undefined ? { draft: plain(opts.draft) } : {}),
      ...(opts.openTo ? { openTo: opts.openTo } : {}),
      ...(opts.uploads ? { uploads: opts.uploads } : {}),
    };
    let undo = this.deps.applyOptimistic(opts.optimistic);
    if (opts.rollback) {
      const first = undo;
      const extra = opts.rollback;
      undo = () => {
        first();
        extra();
      };
    }
    let resolve!: (r: unknown) => void;
    const done = new Promise<CommandRes<N> | null>((r) => (resolve = r as (x: unknown) => void));
    this.rt.set(id, {
      undo,
      prepare: opts.prepare as Runtime['prepare'],
      onSuccess: opts.onSuccess as Runtime['onSuccess'],
      onError: opts.onError as Runtime['onError'],
      linger: opts.linger ?? 0,
      resolve,
    });
    this.entries = [...this.entries.filter((e) => e.id !== id), entry];
    if (persist) void this.deps.storage.save(snapshot(entry)).catch(() => {});
    void this.run(id);
    return { id, done };
  }

  private runtime(id: string): Runtime {
    let r = this.rt.get(id);
    if (!r) {
      // A persisted entry from an earlier visit: no closures, nothing to undo.
      r = { undo: () => {}, linger: 0, resolve: () => {} };
      this.rt.set(id, r);
    }
    return r;
  }

  private async run(id: string): Promise<void> {
    const e = this.get(id);
    if (!e || e.status === 'sending' || e.status === 'sent') return;
    const r = this.runtime(id);
    clearTimeout(r.timer);
    if (!this.deps.isOnline()) {
      this.patch(id, { status: 'offline' });
      return;
    }
    this.patch(id, {
      status: 'sending',
      attempts: e.attempts + 1,
      error: undefined,
      errorCode: undefined,
      nextAt: undefined,
    });
    try {
      let input = e.input;
      if (r.prepare) {
        const next = await r.prepare(this.get(id)!);
        if (next) {
          input = next;
          this.patch(id, { input: next });
        }
      }
      if (!this.get(id)) return; // cancelled while preparing
      const res = await this.deps.send(e.command, input, id);
      this.succeed(id, res);
    } catch (err) {
      this.fail(id, err);
    }
  }

  private succeed(id: string, res: unknown) {
    const r = this.runtime(id);
    const e = this.patch(id, { status: 'sent', result: res as never, error: undefined });
    if (!e) return;
    if (e.persist) void this.deps.storage.remove(e.uid, id).catch(() => {});
    this.deps.onResolved?.(e);
    try {
      r.onSuccess?.(res, e);
    } catch (x) {
      console.error('[outbox] onSuccess', x);
    }
    r.resolve(res);
    // Keep the optimistic overlay until the listener has delivered the committed doc.
    setTimeout(r.undo, this.deps.settleMs ?? 1500);
    const drop = () => {
      this.entries = this.entries.filter((x) => x.id !== id);
      this.rt.delete(id);
    };
    if (r.linger > 0) setTimeout(drop, r.linger);
    else drop();
  }

  private fail(id: string, err: unknown) {
    const e = this.get(id);
    if (!e) return;
    const r = this.runtime(id);
    const code: AppErrorCode = isAppError(err) ? err.code : 'internal';
    const message = isAppError(err)
      ? err.message
      : err instanceof Error
        ? err.message
        : 'Something went wrong';
    if (isAppError(err) && r.onError?.(err, e)) {
      this.drop(id);
      return;
    }
    // Lost the connection mid-send: wait for 'online' (does not use up a retry).
    if (code === 'unavailable' && !this.deps.isOnline()) {
      this.patch(id, { status: 'offline', attempts: Math.max(0, e.attempts - 1) });
      return;
    }
    if (isTransient(code) && e.attempts <= MAX_RETRIES) {
      const wait = (this.deps.backoffMs ?? defaultBackoff)(e.attempts);
      this.patch(id, {
        status: 'retrying',
        error: message,
        errorCode: code,
        nextAt: this.now() + wait,
      });
      r.timer = setTimeout(() => void this.run(id), wait);
      return;
    }
    const failed = this.patch(id, {
      status: 'failed',
      error: message,
      errorCode: code,
      nextAt: undefined,
    });
    if (failed) this.deps.onFailure?.(failed);
  }

  /** Remove an entry and undo what it showed. */
  private drop(id: string) {
    const e = this.get(id);
    const r = this.rt.get(id);
    if (r) {
      clearTimeout(r.timer);
      r.undo();
      r.resolve(null);
    }
    this.rt.delete(id);
    this.entries = this.entries.filter((x) => x.id !== id);
    if (e) {
      if (e.persist) void this.deps.storage.remove(e.uid, id).catch(() => {});
      this.deps.onResolved?.(e);
    }
  }

  /** Cancel: drop the change and roll back what the UI showed. A send in flight cannot be recalled. */
  cancel(id: string): boolean {
    const e = this.get(id);
    if (!e || e.status === 'sending' || e.status === 'sent') return false;
    if (this.opening?.id === id) this.opening = null;
    this.drop(id);
    return true;
  }

  /** Resend a failed (or waiting) entry now, with a fresh set of retries. */
  retry(id: string) {
    const e = this.get(id);
    if (!e || e.status === 'sending' || e.status === 'sent') return;
    this.deps.onResolved?.(e);
    this.patch(id, { status: 'queued', attempts: 0 });
    void this.run(id);
  }

  /** Update an entry's upload progress (messages with attachments). */
  setUploads(id: string, uploads: OutboxUpload[]) {
    if (this.get(id)) this.patch(id, { uploads });
  }
  /** Replace an entry's draft (kept in step with what will be sent). */
  setDraft(id: string, draft: unknown) {
    if (this.get(id)) this.patch(id, { draft: plain(draft) });
  }

  /**
   * Open: go where the change was made; the destination take()s the entry and
   * puts it back in its form (or highlights it, for a message).
   */
  open(id: string) {
    const e = this.get(id);
    if (!e) return;
    this.opening = e;
    if (e.openTo) this.deps.navigate?.(e.openTo, e);
  }
  /** The entry being opened, when it is of this kind (and matches); clears the request. */
  take(kind: string, match: (e: OutboxEntry) => boolean = () => true): OutboxEntry | null {
    const e = this.opening;
    if (!e || e.kind !== kind || !match(e)) return null;
    this.opening = null;
    return e;
  }

  /** Browser came back online / a retry timer is due: send what waits. */
  resume() {
    for (const e of this.entries) {
      if (e.status === 'offline' || e.status === 'queued' || e.status === 'retrying')
        void this.run(e.id);
    }
  }

  /**
   * Switch user: forget the previous user's entries (their persisted copies
   * stay theirs) and load this user's from storage, resending them.
   */
  async setUser(uid: string | null) {
    if (uid === this.uid) return;
    for (const r of this.rt.values()) clearTimeout(r.timer);
    this.rt.clear();
    this.entries = [];
    this.opening = null;
    this.uid = uid;
    if (!uid) return;
    let saved: OutboxEntry[];
    try {
      saved = await this.deps.storage.load(uid);
    } catch {
      saved = [];
    }
    if (this.uid !== uid) return;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a throwaway lookup
    const known = new Set(this.entries.map((e) => e.id));
    const back = saved
      .filter((e) => !known.has(e.id) && e.status !== 'sent')
      // In-flight uploads did not survive the reload.
      .map((e) => ({
        ...e,
        status: 'queued' as const,
        attempts: 0,
        uploads: e.uploads?.filter((u) => u.status === 'done'),
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
    if (!back.length) return;
    this.entries = [...back, ...this.entries];
    for (const e of back) void this.run(e.id);
  }

  /** Test helper. */
  _reset() {
    for (const r of this.rt.values()) clearTimeout(r.timer);
    this.rt.clear();
    this.entries = [];
    this.opening = null;
  }
}

/** A JSON-clean copy ($state proxies and functions cannot go to IndexedDB). */
function plain<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
function snapshot(e: OutboxEntry): OutboxEntry {
  return plain(e);
}
