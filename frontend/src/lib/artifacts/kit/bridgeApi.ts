/**
 * KIT ARTIFACTS' HOST API — what `host.*` is inside an artifact built with the
 * Sandbox Environment kit (@panth977/sandbox; docs/plan/artifacts.html §L).
 *
 * The kit runs the artifact in its own sandboxed frame and carries calls over a
 * private MessagePort. Every call still goes through THE BROKER (../broker):
 * this file plays a frame window to it — it posts the same `req` / `unsub`
 * messages a BackendDriver iframe would, and turns the broker's `res` / `event`
 * / `signal` answers back into promises and streams. So everything the broker
 * promises holds unchanged for kit artifacts: the artifact-id fence on every
 * path, read-only viewers refused before any call, the board grants of §K, the
 * bucket grants, the listener cap, revocation.
 *
 * Nothing here is a new permission: the API is a friendlier shape of the same
 * DriverOps table.
 */
import {
  DRIVER_PROTOCOL_VERSION,
  DRIVER_SUB_OPS,
  DRIVER_TAG,
  SERVER_TIME,
  type DriverArgs,
  type DriverArtifact,
  type DriverMe,
  type DriverOp,
  type DriverResult,
} from '@tm/shared';
import type { Broker } from '../broker';

/** The kit's error shape: `code` survives the bridge. */
export class KitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KitError';
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  /** For subscription ops: where the events of the `sub` this request gets go. */
  stream?: Stream;
}

/** A live subscription as an async iterable; closing it unsubscribes at the broker. */
class Stream {
  sub: string | null = null;
  private queue: unknown[] = [];
  private waiters: {
    resolve: (r: IteratorResult<unknown>) => void;
    reject: (e: unknown) => void;
  }[] = [];
  private done = false;
  private error: unknown = null;
  constructor(private readonly onClose: (s: Stream) => void) {}

  push(v: unknown) {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w.resolve({ value: v, done: false });
    else {
      this.queue.push(v);
      // Snapshots supersede each other: never hold more than a few.
      if (this.queue.length > 8) this.queue.shift();
    }
  }
  fail(e: unknown) {
    if (this.done) return;
    this.done = true;
    this.error = e;
    for (const w of this.waiters.splice(0)) w.reject(e);
  }
  end() {
    if (this.done) return;
    this.done = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }
  close() {
    if (this.done) return;
    this.end();
    this.onClose(this);
  }
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift(), done: false });
        if (this.done)
          return this.error
            ? Promise.reject(this.error)
            : Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export interface BrokerLink {
  /** Give this to createBroker as `frame: () => link.frame`. */
  readonly frame: { postMessage(message: unknown, targetOrigin: string): void };
  /** Wire the broker in (after createBroker) and say hello. */
  connect(broker: Broker): void;
  call<O extends DriverOp>(op: O, args: DriverArgs<O>): Promise<DriverResult<O>>;
  watch(op: DriverOp, args: Record<string, unknown>): AsyncIterable<unknown>;
  me(): Promise<DriverMe>;
  artifact(): Promise<DriverArtifact>;
  /** Broker signals: readonly · revoked · build. */
  signals(): AsyncIterable<{ name: string; value: unknown }>;
  close(): void;
}

/** A pretend frame window between the kit bridge and the broker. */
export function createBrokerLink(): BrokerLink {
  let broker: Broker | null = null;
  let seq = 0;
  const pending = new Map<string, Pending>();
  const streams = new Map<string, Stream>();
  const signalStreams = new Set<Stream>();
  let hello: { me: DriverMe; artifact: DriverArtifact } | null = null;
  const helloWaiters: ((h: { me: DriverMe; artifact: DriverArtifact }) => void)[] = [];

  const send = (msg: Record<string, unknown>) =>
    broker?.handle({
      source: frame,
      data: { tag: DRIVER_TAG, v: DRIVER_PROTOCOL_VERSION, ...msg },
    });

  const frame = {
    // The broker answers synchronously inside handle() for some paths, and a
    // subscription's first snapshot may follow its { sub } in the same tick:
    // everything is routed here, at once, never through a later microtask.
    postMessage(message: unknown) {
      const m = message as {
        type?: string;
        id?: string;
        ok?: boolean;
        value?: unknown;
        error?: { code: string; message: string };
        sub?: string;
        name?: string;
        me?: DriverMe;
        artifact?: DriverArtifact;
      };
      switch (m.type) {
        case 'hello': {
          if (m.me) {
            if (hello) hello.me = m.me;
            hello = { me: m.me, artifact: m.artifact! };
            for (const w of helloWaiters.splice(0)) w(hello);
          }
          return;
        }
        case 'res': {
          const p = m.id ? pending.get(m.id) : undefined;
          if (!p) return;
          pending.delete(m.id!);
          if (!m.ok) {
            const err = new KitError(m.error?.code ?? 'unavailable', m.error?.message ?? 'Failed');
            p.stream?.fail(err);
            return p.reject(err);
          }
          if (p.stream) {
            const sub = (m.value as { sub?: string } | null)?.sub;
            if (typeof sub === 'string') {
              p.stream.sub = sub;
              streams.set(sub, p.stream);
            }
            return p.resolve(p.stream);
          }
          return p.resolve(m.value);
        }
        case 'event': {
          const s = m.sub ? streams.get(m.sub) : undefined;
          if (!s) return;
          if (m.ok) s.push(m.value);
          else {
            streams.delete(m.sub!);
            s.fail(new KitError(m.error?.code ?? 'unavailable', m.error?.message ?? 'Failed'));
          }
          return;
        }
        case 'signal': {
          if (m.name === 'readonly' && hello) hello.me = { ...hello.me, readOnly: !!m.value };
          for (const s of signalStreams) s.push({ name: m.name, value: m.value });
          if (m.name === 'revoked') {
            const err = new KitError(
              'permission-denied',
              'You no longer have access to this artifact',
            );
            for (const s of streams.values()) s.fail(err);
            streams.clear();
          }
          return;
        }
      }
    },
  };

  function request(op: DriverOp, args: Record<string, unknown>, stream?: Stream): Promise<unknown> {
    if (!broker) return Promise.reject(new KitError('unavailable', 'Not connected'));
    const id = `k${++seq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, stream });
      send({ type: 'req', id, op, args });
    });
  }

  const unsubscribe = (s: Stream) => {
    if (!s.sub) return;
    streams.delete(s.sub);
    send({ type: 'unsub', sub: s.sub });
  };

  return {
    frame,
    connect(b) {
      broker = b;
      // The kit's frame is a fresh document: the broker drops whatever was open and says hello.
      send({ type: 'ready' });
    },
    call(op, args) {
      if (DRIVER_SUB_OPS.has(op))
        return Promise.reject(new KitError('invalid-argument', `${op} is a stream; use watch`));
      return request(op, args as Record<string, unknown>) as Promise<DriverResult<typeof op>>;
    },
    watch(op, args) {
      const stream = new Stream(unsubscribe);
      // Start on the first next(): an artifact that never iterates holds no listener.
      let started: Promise<unknown> | null = null;
      return {
        [Symbol.asyncIterator]() {
          started ??= request(op, args, stream).catch((e) => stream.fail(e));
          return stream[Symbol.asyncIterator]();
        },
      };
    },
    me: () =>
      hello ? Promise.resolve(hello.me) : new Promise((r) => helloWaiters.push((h) => r(h.me))),
    artifact: () =>
      hello
        ? Promise.resolve(hello.artifact)
        : new Promise((r) => helloWaiters.push((h) => r(h.artifact))),
    signals() {
      const s = new Stream((x) => signalStreams.delete(x));
      signalStreams.add(s);
      return s as AsyncIterable<{ name: string; value: unknown }>;
    },
    close() {
      for (const s of streams.values()) s.close();
      streams.clear();
      for (const s of signalStreams) s.end();
      signalStreams.clear();
      const err = new KitError('unavailable', 'Closed');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      broker = null;
    },
  };
}

/** Options for the host-side helpers the artifact may call (`host.ui.*`). */
export interface KitUi {
  toast(message: string, kind: 'info' | 'success' | 'warning' | 'error'): void;
  /** Opens an app path (`/b/ENG`) or an http(s) URL in a new tab. */
  open(url: string): void;
}

/**
 * The object the kit exposes to the artifact as `host`. Plain objects of
 * functions (the kit only reaches own properties). Streams are AsyncIterables.
 */
export function createKitApi(link: BrokerLink, ui: KitUi) {
  const c = link.call;
  const w = (op: DriverOp, args: Record<string, unknown>) => link.watch(op, args);
  return {
    me: () => link.me(),
    artifact: () => link.artifact(),
    /** readonly / revoked / build announcements. */
    signals: () => link.signals(),
    /** Firestore under this artifact (paths are the artifact's own view, '/orders/o1'). */
    db: {
      get: (path: string) => c('fs.get', { path }),
      set: (path: string, data: Record<string, unknown>, options?: { merge?: boolean }) =>
        c('fs.set', { path, data, merge: options?.merge === true }),
      update: (path: string, patch: Record<string, unknown>) => c('fs.update', { path, patch }),
      delete: (path: string) => c('fs.delete', { path }),
      add: (path: string, data: Record<string, unknown>) => c('fs.add', { path, data }),
      list: (path: string, query?: DriverArgs<'fs.list'>['query']) => c('fs.list', { path, query }),
      watch: (path: string) => w('fs.onDoc', { path }),
      watchList: (path: string, query?: DriverArgs<'fs.onList'>['query']) =>
        w('fs.onList', { path, query }),
      /** A value that becomes the server's time when written. */
      serverTime: () => SERVER_TIME,
    },
    /** Realtime Database under this artifact. */
    rtdb: {
      get: (path: string) => c('rtdb.get', { path }),
      set: (path: string, value: unknown) => c('rtdb.set', { path, value }),
      update: (path: string, patch: Record<string, unknown>) => c('rtdb.update', { path, patch }),
      push: (path: string, value: unknown) => c('rtdb.push', { path, value }),
      remove: (path: string) => c('rtdb.remove', { path }),
      watch: (path: string) => w('rtdb.on', { path }),
    },
    /** This artifact's files (Storage). */
    files: {
      upload: (path: string, blob: Blob, contentType?: string) =>
        c('st.upload', { path, blob, ...(contentType ? { contentType } : {}) }),
      url: (path: string) => c('st.url', { path }),
      list: (path = '/') => c('st.list', { path }),
      delete: (path: string) => c('st.delete', { path }),
    },
    /** Per-viewer key/value store. */
    kv: {
      get: (key: string) => c('kv.get', { key }),
      set: (key: string, value: unknown) => c('kv.set', { key, value }),
      delete: (key: string) => c('kv.delete', { key }),
    },
    /** Boards the owner granted this artifact (§K). */
    tickets: {
      boards: () => c('tk.boards', {}),
      list: (board: string, query?: DriverArgs<'tk.list'>['query']) =>
        c('tk.list', { board, query }),
      watchList: (board: string, query?: DriverArgs<'tk.onList'>['query']) =>
        w('tk.onList', { board, query }),
      get: (key: string) => c('tk.get', { key }),
      create: (board: string, ticket: DriverArgs<'tk.create'>['ticket']) =>
        c('tk.create', { board, ticket }),
      update: (key: string, patch: DriverArgs<'tk.update'>['patch']) =>
        c('tk.update', { key, patch }),
      comment: (key: string, markdown: string) => c('tk.comment', { key, markdown }),
      thread: (key: string, query?: DriverArgs<'tk.thread'>['query']) =>
        c('tk.thread', { key, query }),
      watchThread: (key: string, query?: DriverArgs<'tk.onThread'>['query']) =>
        w('tk.onThread', { key, query }),
      fileUrl: (key: string, file: string) => c('tk.fileUrl', { key, file }),
      aggregates: (board: string, query?: DriverArgs<'tk.aggregates'>['query']) =>
        c('tk.aggregates', { board, query }),
      watchAggregates: (board: string, query?: DriverArgs<'tk.onAggregates'>['query']) =>
        w('tk.onAggregates', { board, query }),
    },
    /** Buckets granted to this artifact (bucket.html §H). */
    bucket: {
      list: () => c('mem.list', {}),
      tree: (bucket: string, path?: string) => c('mem.tree', { bucket, ...(path ? { path } : {}) }),
      read: (bucket: string, path: string) => c('mem.read', { bucket, path }),
      url: (bucket: string, path: string) => c('mem.url', { bucket, path }),
      write: (bucket: string, path: string, content: string | Blob, contentType?: string) =>
        c('mem.write', {
          bucket,
          path,
          ...(typeof content === 'string' ? { text: content } : { blob: content }),
          ...(contentType ? { contentType } : {}),
        }),
      mkdir: (bucket: string, path: string) => c('mem.mkdir', { bucket, path }),
      remove: (bucket: string, path: string) => c('mem.remove', { bucket, path }),
    },
    /** The host page's own UI: things an artifact cannot draw outside its frame. */
    ui: {
      toast: (message: string, kind: 'info' | 'success' | 'warning' | 'error' = 'info') =>
        void ui.toast(String(message).slice(0, 300), kind),
      open: (url: string) => void ui.open(String(url)),
    },
  };
}

export type KitApi = ReturnType<typeof createKitApi>;
