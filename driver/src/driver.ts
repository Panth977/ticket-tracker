/**
 * window.BackendDriver (docs/plan/artifacts.html §E2): the public object, over
 * whichever backend answered — the TaskManager host (./host) or, outside it,
 * the mock (./mock). Every call waits for `ready`, so an artifact may call
 * straight away without awaiting it first.
 */
import {
  SERVER_TIME,
  type DriverArgs,
  type DriverOp,
  type DriverResult,
  type ListQuery,
} from '@tm/shared/artifacts/driver';
import type * as Api from './api.js';
import { connectHost } from './host.js';
import { createMock } from './mock.js';
import {
  toDriverError,
  type Session,
  type SignalName,
  type SubOp,
  type WindowLike,
} from './transport.js';

/**
 * How long a TOP-LEVEL page waits before it becomes the mock. A framed page
 * never does: inside a frame the host may simply be slow (a cold start, a
 * phone waking up), and quietly writing someone's real data into a mock
 * would be worse than waiting. `?mock=1` forces the mock anywhere.
 */
export const MOCK_AFTER_MS = 1500;

const MOCK_INFO =
  '[BackendDriver] Not inside TaskManager — using the MOCK backend (data stays in this browser: localStorage). ' +
  'Publish the artifact and open it at /x/{id} for the real one. ?role=owner|editor|viewer and ?readonly=1 change who you are.';

function forcedMock(win: WindowLike | undefined): boolean {
  try {
    const v = new URLSearchParams(win?.location?.search ?? '').get('mock');
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

function connect(
  win: WindowLike | undefined,
  onSignal: (n: SignalName, v: unknown) => void,
): Promise<Session> {
  const mock = () => {
    console.info(MOCK_INFO);
    return createMock(win);
  };
  // No window at all (a module imported by a test runner or SSR): nothing to talk to.
  if (!win || forcedMock(win)) return Promise.resolve(mock());
  const framed = !!win.parent && win.parent !== win;
  if (framed) return connectHost(win, onSignal).session;
  return new Promise((resolve) => setTimeout(() => resolve(mock()), MOCK_AFTER_MS));
}

export function createDriver(win: WindowLike | undefined): Api.BackendDriver {
  let session: Session | null = null;
  const handlers: Record<SignalName, Set<(value: never) => void>> = {
    readonly: new Set(),
    revoked: new Set(),
    build: new Set(),
  };
  const emit = (name: SignalName, value: unknown) => {
    for (const h of [...(handlers[name] ?? [])]) guard(() => (h as (v: unknown) => void)(value));
  };
  const connected = connect(win, emit).then((s) => (session = s));
  const ready = connected.then(() => undefined);

  const call = async <O extends DriverOp>(op: O, args: DriverArgs<O>): Promise<DriverResult<O>> => {
    const s = await connected;
    try {
      return await s.transport.request(op, args);
    } catch (e) {
      throw toDriverError(e);
    }
  };
  const done = (p: Promise<unknown>): Promise<void> => p.then(() => undefined);

  const subscribe = <O extends SubOp>(
    op: O,
    args: DriverArgs<O>,
    callback: (value: never) => void,
    onError?: Api.OnError,
  ): Api.Unsubscribe => {
    if (typeof callback !== 'function')
      throw new TypeError(`${op}: a callback function is required`);
    let stop: (() => void) | null = null;
    let stopped = false;
    void connected.then((s) => {
      if (stopped) return;
      stop = s.transport.subscribe(
        op,
        args,
        (value) => guard(() => (callback as (v: unknown) => void)(value)),
        (error) => {
          const err = toDriverError(error);
          if (onError) guard(() => onError(err));
          else console.error(`[BackendDriver] ${op} failed:`, err);
        },
      );
    });
    return () => {
      stopped = true;
      stop?.();
      stop = null;
    };
  };

  return {
    ready,
    get me() {
      return session?.me ?? null;
    },
    get artifact() {
      return session?.artifact ?? null;
    },
    get mock() {
      return session?.mock ?? false;
    },
    serverTime: SERVER_TIME,
    firestore: {
      get: (path) => call('fs.get', { path }) as Promise<never>,
      set: (path, data, options) =>
        done(call('fs.set', { path, data, merge: options?.merge === true })),
      update: (path, patch) => done(call('fs.update', { path, patch })),
      delete: (path) => done(call('fs.delete', { path })),
      add: (path, data) => call('fs.add', { path, data }),
      list: (path, query) =>
        call('fs.list', { path, query: query as ListQuery | undefined }) as Promise<never>,
      onDoc: (path, callback, onError) => subscribe('fs.onDoc', { path }, callback, onError),
      onList: (path, query, callback, onError) =>
        subscribe(
          'fs.onList',
          { path, query: (query ?? undefined) as ListQuery | undefined },
          callback,
          onError,
        ),
    },
    rtdb: {
      get: (path) => call('rtdb.get', { path }) as Promise<never>,
      set: (path, value) => done(call('rtdb.set', { path, value })),
      update: (path, patch) => done(call('rtdb.update', { path, patch })),
      push: (path, value) => call('rtdb.push', { path, value }),
      remove: (path) => done(call('rtdb.remove', { path })),
      on: (path, callback, onError) => subscribe('rtdb.on', { path }, callback, onError),
    },
    storage: {
      upload: (path, blob, options) =>
        call('st.upload', {
          path,
          blob,
          ...(options?.contentType ? { contentType: options.contentType } : {}),
        }),
      url: (path) => call('st.url', { path }).then((r) => r.url),
      list: (prefix) => call('st.list', { path: prefix ?? '' }),
      delete: (path) => done(call('st.delete', { path })),
    },
    kv: {
      get: (key) => call('kv.get', { key }) as Promise<never>,
      set: (key, value) => done(call('kv.set', { key, value })),
      delete: (key) => done(call('kv.delete', { key })),
    },
    tickets: {
      boards: () => call('tk.boards', {}),
      list: (board, query) => call('tk.list', { board, ...(query ? { query } : {}) }),
      onList: (board, query, callback, onError) =>
        subscribe('tk.onList', { board, ...(query ? { query } : {}) }, callback, onError),
      get: (key) => call('tk.get', { key }),
      create: (board, ticket) => call('tk.create', { board, ticket }),
      update: (key, patch) => done(call('tk.update', { key, patch })),
      comment: (key, markdown) => done(call('tk.comment', { key, markdown })),
      thread: (key, query) => call('tk.thread', { key, ...(query ? { query } : {}) }),
      onThread: (key: string, a: unknown, b?: unknown, c?: Api.OnError): Api.Unsubscribe => {
        // onThread(key, cb, onError?) or onThread(key, query, cb, onError?)
        const [query, callback, onError] =
          typeof a === 'function' ? [null, a, b as Api.OnError | undefined] : [a, b, c];
        return subscribe(
          'tk.onThread',
          { key, ...(query ? { query: query as Api.ThreadQuery } : {}) },
          callback as (value: never) => void,
          onError,
        );
      },
      fileUrl: (key, file) => call('tk.fileUrl', { key, file }).then((r) => r.url),
      aggregates: (board, query) => call('tk.aggregates', { board, ...(query ? { query } : {}) }),
      onAggregates: (board, query, callback, onError) =>
        subscribe('tk.onAggregates', { board, ...(query ? { query } : {}) }, callback, onError),
    },
    memory: {
      list: () => call('mem.list', {}),
      tree: (memory, path) => call('mem.tree', { memory, ...(path ? { path } : {}) }),
      read: (memory, path) => call('mem.read', { memory, path }).then((r) => r.text),
      url: (memory, path) => call('mem.url', { memory, path }).then((r) => r.url),
      write: (memory, path, content, options) =>
        done(
          call('mem.write', {
            memory,
            path,
            ...(typeof content === 'string' ? { text: content } : { blob: content }),
            ...(options?.contentType ? { contentType: options.contentType } : {}),
          }),
        ),
      mkdir: (memory, path) => done(call('mem.mkdir', { memory, path })),
      remove: (memory, path) => done(call('mem.remove', { memory, path })),
    },
    on(name, callback) {
      const set = handlers[name];
      if (!set) throw new TypeError(`BackendDriver.on: unknown signal '${String(name)}'`);
      set.add(callback as (value: never) => void);
      return () => void set.delete(callback as (value: never) => void);
    },
  };
}

/** The artifact's own callback threw: report it, but never let it stop the message loop. */
function guard(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error('[BackendDriver] a callback threw:', e);
  }
}
