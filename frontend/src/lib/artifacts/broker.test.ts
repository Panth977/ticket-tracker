/**
 * The broker is the host page's promise about what an artifact's messages can
 * ever turn into. These tests play the artifact — including a hostile one —
 * against a recording fake of the stores, and check the promise:
 * only our iframe is heard, every path stays under OUR artifact's prefix,
 * a read-only viewer writes nothing, listeners are capped and cleaned up,
 * and no message, however malformed, throws.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ARTIFACT_MAX_LISTENERS,
  ARTIFACT_UPLOAD_MAX_BYTES,
  DRIVER_OPS,
  DRIVER_PROTOCOL_VERSION,
  DRIVER_TAG,
  DRIVER_WRITE_OPS,
  SERVER_TIME,
  type ArtifactRole,
  type DriverOp,
} from '@tm/shared';
import {
  createBroker,
  toDriverError,
  type BrokerBackend,
  type CheckedQuery,
  type StoredDoc,
  type StoredRow,
} from './broker';
import { ENG_ID, fakeTickets, SEC_ID } from './fakeTickets';

const ID = 'artAAAAAA1';
const OTHER = 'artBBBBBB2';
const UID = 'user-1';
const FS = `artifacts/${ID}/db/data`;
const RT = `artifactData/${ID}`;
const ST = `artifacts/${ID}/files`;
const KV = `artifacts/${ID}/viewers/${UID}/kv`;

/** Stand-ins for Firestore's Timestamp / sentinels, so conversion is visible in what was stored. */
class Stamp {
  constructor(readonly ms: number) {}
}
const FS_NOW = { sentinel: 'fs-server-time' };
const RT_NOW = { '.sv': 'timestamp' };

interface Call {
  op: string;
  path: string;
  args: unknown[];
}

function fakeBackend() {
  const tk = fakeTickets(UID);
  const calls: Call[] = [];
  const docs = new Map<string, Record<string, unknown>>();
  const live: {
    path: string;
    next: (v: never) => void;
    error: (e: unknown) => void;
    stopped: boolean;
  }[] = [];
  let fail: unknown = null;
  const rec = (op: string, path: string, ...args: unknown[]) => {
    calls.push({ op, path, args });
    if (fail) throw fail;
  };
  const listen = (
    op: string,
    path: string,
    next: (v: never) => void,
    error: (e: unknown) => void,
    ...args: unknown[]
  ) => {
    rec(op, path, ...args);
    const l = { path, next, error, stopped: false };
    live.push(l);
    return () => void (l.stopped = true);
  };
  const backend: BrokerBackend = {
    fs: {
      codec: { date: (d) => new Stamp(d.getTime()), serverTime: () => FS_NOW },
      asDate: (v) => (v instanceof Stamp ? new Date(v.ms) : null),
      async get(path): Promise<StoredDoc> {
        rec('fs.get', path);
        const data = docs.get(path) ?? null;
        return { exists: !!data, data };
      },
      async set(path, data, merge) {
        rec('fs.set', path, data, merge);
        docs.set(path, data);
      },
      async update(path, patch) {
        rec('fs.update', path, patch);
      },
      async delete(path) {
        rec('fs.delete', path);
        docs.delete(path);
      },
      async add(path, data) {
        rec('fs.add', path, data);
        return 'newDocId';
      },
      async list(path, q): Promise<StoredRow[]> {
        rec('fs.list', path, q);
        return [{ id: 'r1', data: { at: new Stamp(5) } }];
      },
      onDoc: (path, next, error) => listen('fs.onDoc', path, next as never, error),
      onList: (path, q, next, error) => listen('fs.onList', path, next as never, error, q),
    },
    rtdb: {
      codec: {
        date: (d) => d.getTime(),
        serverTime: () => RT_NOW,
        key: (k) => {
          if (/[.$#[\]/]/.test(k))
            throw Object.assign(new Error(`bad key ${k}`), { code: 'invalid-argument' });
        },
        finiteOnly: true,
      },
      async get(path) {
        rec('rtdb.get', path);
        return undefined;
      },
      async set(path, value) {
        rec('rtdb.set', path, value);
      },
      async update(path, patch) {
        rec('rtdb.update', path, patch);
      },
      async push(path, value) {
        rec('rtdb.push', path, value);
        return '-Nkey';
      },
      async remove(path) {
        rec('rtdb.remove', path);
      },
      on: (path, next, error) => listen('rtdb.on', path, next as never, error),
    },
    storage: {
      async upload(path, blob, contentType) {
        rec('st.upload', path, blob, contentType);
      },
    },
    files: {
      async url(path) {
        rec('st.url', path);
        return { url: `https://signed${path}`, expiresAt: 99 };
      },
      async list(path) {
        rec('st.list', path);
        return [{ path: '/pics/a.png', size: 3, contentType: 'image/png', updatedAt: 1 }];
      },
      async delete(path) {
        rec('st.delete', path);
      },
    },
    tickets: tk.backend,
    // memory.html §H: one memory granted read (./brokerMemory.test covers the ops).
    memory: {
      list: async () => [
        {
          memory: {
            id: 'mem01',
            name: 'Brand',
            description: null,
            indicator: { kind: 'emoji', emoji: '🧠' } as const,
            icon: null,
            reach: 'manage',
            archived: false,
            stats: { files: 1, folders: 0, bytes: 1 },
            updatedAt: 1,
          },
          grant: 'read',
        },
      ],
      tree: async () => [],
      read: async () => ({ text: 'x', truncated: false, url: 'https://u', expiresAt: 1 }),
      async write(m, path) {
        rec('mem.write', path);
      },
      async mkdir(m, path) {
        rec('mem.mkdir', path);
      },
      async remove(m, path) {
        rec('mem.remove', path);
      },
    },
  };
  return { backend, calls, docs, live, tk, failWith: (e: unknown) => (fail = e) };
}

type Posted = Record<string, unknown> & { type: string };

function setup(
  over: {
    role?: ArtifactRole;
    readOnly?: boolean;
    maxListeners?: number;
    boards?: Record<string, 'read' | 'write'>;
  } = {},
) {
  const fake = fakeBackend();
  const posted: { msg: Posted; origin: string }[] = [];
  const frame = {
    postMessage: (msg: unknown, origin: string) => void posted.push({ msg: msg as Posted, origin }),
  };
  let current: typeof frame | null = frame;
  const broker = createBroker({
    artifactId: ID,
    uid: UID,
    frame: () => current,
    artifact: () => ({ name: 'Sales', buildId: 'build12345' }),
    viewer: () => ({ name: 'Ana', email: 'ana@example.com', photoURL: null }),
    role: over.role ?? 'editor',
    readOnly: over.readOnly ?? false,
    backend: fake.backend,
    boards: () => over.boards ?? {},
    origin: 'https://app.example',
    maxListeners: over.maxListeners,
    now: () => 1234,
  });
  let n = 0;
  const say = (body: Record<string, unknown>, source: unknown = frame) =>
    broker.handle({ source, data: { tag: DRIVER_TAG, v: DRIVER_PROTOCOL_VERSION, ...body } });
  /** Send a request as the iframe and wait for its answer. */
  async function req(op: string, args: unknown, extra: Record<string, unknown> = {}) {
    const id = `q${++n}`;
    say({ type: 'req', id, op, args, ...extra });
    for (let i = 0; i < 20 && !posted.some((p) => p.msg.id === id); i++) await Promise.resolve();
    const res = posted.find((p) => p.msg.id === id)?.msg;
    if (!res) throw new Error(`no answer to ${op}`);
    return res as Posted & {
      ok: boolean;
      value?: unknown;
      error?: { code: string; message: string };
    };
  }
  const of = (type: string) => posted.filter((p) => p.msg.type === type).map((p) => p.msg);
  return { ...fake, broker, frame, posted, say, req, of, removeFrame: () => (current = null) };
}

describe('who is heard', () => {
  it("answers 'ready' from its own iframe with hello — and posts only to that iframe", () => {
    const t = setup({ role: 'viewer', readOnly: true });
    t.say({ type: 'ready' });
    expect(t.posted).toHaveLength(1);
    expect(t.posted[0]!.origin).toBe('*');
    expect(t.posted[0]!.msg).toEqual({
      tag: DRIVER_TAG,
      v: DRIVER_PROTOCOL_VERSION,
      type: 'hello',
      artifact: { id: ID, name: 'Sales', buildId: 'build12345' },
      me: {
        uid: UID,
        name: 'Ana',
        email: 'ana@example.com',
        photoURL: null,
        role: 'viewer',
        readOnly: true,
      },
    });
  });

  it('ignores every other window, untagged messages and other protocol versions', async () => {
    const t = setup();
    const stranger = { postMessage: vi.fn() };
    t.say({ type: 'ready' }, stranger);
    t.say({ type: 'req', id: 'x', op: 'fs.delete', args: { path: '/a/b' } }, stranger);
    t.say({ type: 'req', id: 'y', op: 'fs.delete', args: { path: '/a/b' } }, null);
    t.broker.handle({ source: t.frame, data: { type: 'ready' } });
    t.broker.handle({ source: t.frame, data: { tag: DRIVER_TAG, v: 2, type: 'ready' } });
    t.broker.handle({ source: t.frame, data: 'ready' });
    t.broker.handle({ source: t.frame, data: null });
    await Promise.resolve();
    expect(t.posted).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
    expect(stranger.postMessage).not.toHaveBeenCalled();
  });

  it('hears nothing once the iframe is gone', async () => {
    const t = setup();
    t.removeFrame();
    t.say({ type: 'ready' });
    t.say({ type: 'req', id: 'x', op: 'fs.get', args: { path: '/a/b' } });
    await Promise.resolve();
    expect(t.calls).toHaveLength(0);
  });

  it('attach() wires window.message and its stop closes the listeners', async () => {
    const t = setup();
    let handler: ((e: unknown) => void) | null = null;
    const target = {
      addEventListener: (_: string, h: (e: unknown) => void) => (handler = h),
      removeEventListener: vi.fn(),
    };
    const detach = t.broker.attach(target as never);
    handler!({
      source: t.frame,
      data: { tag: DRIVER_TAG, v: DRIVER_PROTOCOL_VERSION, type: 'ready' },
    });
    expect(t.of('hello')).toHaveLength(1);
    await t.req('rtdb.on', { path: '/x' });
    detach();
    expect(target.removeEventListener).toHaveBeenCalled();
    expect(t.live[0]!.stopped).toBe(true);
  });
});

describe('the fence: every path is built here, under OUR artifact', () => {
  it('prefixes each store with the id the host holds', async () => {
    const t = setup();
    await t.req('fs.get', { path: '/todos/a' });
    await t.req('fs.set', { path: 'todos/a', data: { n: 1 }, merge: true });
    await t.req('fs.update', { path: '/todos/a', patch: { n: 2 } });
    await t.req('fs.delete', { path: '/todos/a' });
    await t.req('fs.add', { path: '/todos', data: { n: 3 } });
    await t.req('fs.list', { path: '/todos' });
    await t.req('rtdb.get', { path: '/room/1' });
    await t.req('rtdb.set', { path: '', value: 1 });
    await t.req('rtdb.push', { path: '/log', value: 1 });
    await t.req('rtdb.remove', { path: '/room' });
    await t.req('st.upload', { path: '/pics/a.png', blob: new Blob(['x'], { type: 'image/png' }) });
    await t.req('kv.set', { key: 'theme', value: 'dark' });
    await t.req('kv.get', { key: 'theme' });
    await t.req('kv.delete', { key: 'theme' });
    expect(t.calls.map((c) => [c.op, c.path])).toEqual([
      ['fs.get', `${FS}/todos/a`],
      ['fs.set', `${FS}/todos/a`],
      ['fs.update', `${FS}/todos/a`],
      ['fs.delete', `${FS}/todos/a`],
      ['fs.add', `${FS}/todos`],
      ['fs.list', `${FS}/todos`],
      ['rtdb.get', `${RT}/room/1`],
      ['rtdb.set', RT],
      ['rtdb.push', `${RT}/log`],
      ['rtdb.remove', `${RT}/room`],
      ['st.upload', `${ST}/pics/a.png`],
      ['fs.set', `${KV}/theme`],
      ['fs.get', `${KV}/theme`],
      ['fs.delete', `${KV}/theme`],
    ]);
  });

  it("refuses '..' and '.' in every op that takes a path — and makes no call", async () => {
    const t = setup();
    const escapes = ['../x/y', '/a/../../b', '/a/./b', '..', '/todos/..'];
    const ops: [DriverOp, Record<string, unknown>][] = [
      ['fs.get', {}],
      ['fs.set', { data: {} }],
      ['fs.update', { patch: {} }],
      ['fs.delete', {}],
      ['fs.add', { data: {} }],
      ['fs.list', {}],
      ['fs.onDoc', {}],
      ['fs.onList', {}],
      ['rtdb.get', {}],
      ['rtdb.set', { value: 1 }],
      ['rtdb.update', { patch: {} }],
      ['rtdb.push', { value: 1 }],
      ['rtdb.remove', {}],
      ['rtdb.on', {}],
      ['st.upload', { blob: new Blob(['x']) }],
      ['st.url', {}],
      ['st.list', {}],
      ['st.delete', {}],
    ];
    for (const [op, rest] of ops)
      for (const path of escapes) {
        const res = await t.req(op, { path, ...rest });
        expect(res, `${op} ${path}`).toMatchObject({
          ok: false,
          error: { code: 'invalid-argument' },
        });
      }
    expect(t.calls).toHaveLength(0);
    expect(t.broker.listeners).toBe(0);
  });

  it('an absolute path naming ANOTHER artifact is just more path under ours', async () => {
    const t = setup();
    await t.req('fs.get', { path: `/artifacts/${OTHER}/db/data/secret/doc` });
    await t.req('rtdb.get', { path: `/artifactData/${OTHER}/x` });
    await t.req('st.url', { path: `artifacts/${OTHER}/files/a.png` });
    await t.req('fs.get', { path: `boards/b1` });
    expect(t.calls.map((c) => c.path)).toEqual([
      `${FS}/artifacts/${OTHER}/db/data/secret/doc`,
      `${RT}/artifactData/${OTHER}/x`,
      `/artifacts/${OTHER}/files/a.png`, // the command's own view; it prefixes server-side with OUR id
      `${FS}/boards/b1`,
    ]);
    for (const c of t.calls.filter((c) => c.op !== 'st.url'))
      expect(c.path.startsWith(`artifacts/${ID}/`) || c.path.startsWith(`${RT}/`)).toBe(true);
  });

  it('ignores an artifactId (or uid) smuggled into a message', async () => {
    const t = setup();
    await t.req(
      'fs.get',
      { path: '/a/b', artifactId: OTHER, id: OTHER },
      { artifactId: OTHER, artifact: { id: OTHER } },
    );
    await t.req('kv.set', { key: 'k', value: 1, uid: 'someone-else', artifactId: OTHER });
    expect(t.calls.map((c) => c.path)).toEqual([`${FS}/a/b`, `${KV}/k`]);
  });

  it('kv keys are one id: no slashes, no dots-only, no reserved names', async () => {
    const t = setup();
    for (const key of ['a/b', '..', '.', '', '__x__', `../../${OTHER}`, 5, null, 'x'.repeat(300)])
      expect(await t.req('kv.set', { key, value: 1 })).toMatchObject({
        ok: false,
        error: { code: 'invalid-argument' },
      });
    expect(t.calls).toHaveLength(0);
  });

  it('checks Firestore parity: a document is even, a collection is odd', async () => {
    const t = setup();
    expect((await t.req('fs.get', { path: '/todos' })).ok).toBe(false);
    expect((await t.req('fs.set', { path: '/a/b/c', data: {} })).ok).toBe(false);
    expect((await t.req('fs.list', { path: '/a/b' })).ok).toBe(false);
    expect((await t.req('fs.add', { path: '', data: {} })).ok).toBe(false);
    expect((await t.req('fs.get', { path: '/a/__name__' })).ok).toBe(false);
    expect(t.calls).toHaveLength(0);
  });

  it('rtdb.update: keys may be paths, but each one goes through the fence', async () => {
    const t = setup();
    expect(
      await t.req('rtdb.update', { path: '/room', patch: { 'a/name': 'A', b: { n: 1 } } }),
    ).toMatchObject({ ok: true });
    expect(t.calls[0]).toMatchObject({
      path: `${RT}/room`,
      args: [{ 'a/name': 'A', b: { n: 1 } }],
    });
    for (const key of ['../x', `../../artifactData/${OTHER}/x`, 'a/../b', 'a.b', '$x', ''])
      expect(await t.req('rtdb.update', { path: '/room', patch: { [key]: 1 } }), key).toMatchObject(
        { ok: false, error: { code: 'invalid-argument' } },
      );
    // Nested keys cannot smuggle RTDB's own sentinels ('.sv') or a path.
    expect(await t.req('rtdb.set', { path: '/x', value: { '.sv': 'timestamp' } })).toMatchObject({
      ok: false,
    });
    expect(await t.req('rtdb.set', { path: '/x', value: { 'a/b': 1 } })).toMatchObject({
      ok: false,
    });
    expect(t.calls).toHaveLength(1);
  });

  it('paths given back to the artifact are in ITS view, never the real ones', async () => {
    const t = setup();
    t.docs.set(`${FS}/todos/a`, { n: 1 });
    expect((await t.req('fs.get', { path: 'todos/a' })).value).toEqual({
      id: 'a',
      path: '/todos/a',
      exists: true,
      data: { n: 1 },
    });
    expect((await t.req('fs.get', { path: 'todos/nope' })).value).toEqual({
      id: 'nope',
      path: '/todos/nope',
      exists: false,
      data: null,
    });
    expect((await t.req('fs.add', { path: '/todos', data: {} })).value).toEqual({
      id: 'newDocId',
      path: '/todos/newDocId',
    });
    expect((await t.req('fs.list', { path: '/todos' })).value).toEqual([
      { id: 'r1', path: '/todos/r1', exists: true, data: { at: new Date(5) } },
    ]);
    expect((await t.req('rtdb.push', { path: '/log', value: 1 })).value).toEqual({
      key: '-Nkey',
      path: '/log/-Nkey',
    });
    expect(
      (await t.req('st.upload', { path: 'pics/a.png', blob: new Blob(['abc']) })).value,
    ).toEqual({ path: '/pics/a.png', size: 3 });
    expect((await t.req('st.list', { path: '/pics' })).value).toEqual([
      { path: '/pics/a.png', size: 3, contentType: 'image/png', updatedAt: 1 },
    ]);
    expect(JSON.stringify(t.posted)).not.toContain(`artifacts/${ID}`);
  });
});

describe('values in and out', () => {
  it('Date → timestamp and serverTime → the server timestamp, however deep', async () => {
    const t = setup();
    const when = new Date(1000);
    await t.req('fs.set', {
      path: '/a/b',
      data: { when, at: SERVER_TIME, deep: { list: [when, { at: SERVER_TIME }] }, gone: undefined },
    });
    const stored = t.calls[0]!.args[0] as Record<string, unknown>;
    expect(stored).toEqual({
      when: new Stamp(1000),
      at: FS_NOW,
      deep: { list: [new Stamp(1000), { at: FS_NOW }] },
    });
    expect('gone' in stored).toBe(false);
    expect(t.calls[0]!.args[1]).toBe(false);

    await t.req('rtdb.set', { path: '/x', value: { when, at: SERVER_TIME } });
    expect(t.calls[1]!.args[0]).toEqual({ when: 1000, at: RT_NOW });
  });

  it('kv stores { value, updatedAt } and gives back just the value', async () => {
    const t = setup();
    await t.req('kv.set', { key: 'k', value: { at: new Date(7) } });
    expect(t.calls[0]!.args).toEqual([{ value: { at: new Stamp(7) }, updatedAt: 1234 }, false]);
    expect((await t.req('kv.get', { key: 'k' })).value).toEqual({ at: new Date(7) });
    expect((await t.req('kv.get', { key: 'missing' })).value).toBeNull();
    expect(await t.req('kv.set', { key: 'k' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-argument' },
    });
  });

  it('refuses what cannot be stored, without calling the store', async () => {
    const t = setup();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const data of [
      new Map(),
      [1],
      'text',
      null,
      7,
      { m: new Map() },
      { b: new Blob(['x']) },
      { u: new Uint8Array(2) },
      cyclic,
    ])
      expect(await t.req('fs.set', { path: '/a/b', data })).toMatchObject({
        ok: false,
        error: { code: 'invalid-argument' },
      });
    expect(await t.req('fs.update', { path: '/a/b' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-argument' },
    });
    expect(await t.req('rtdb.set', { path: '/x', value: NaN })).toMatchObject({
      ok: false,
      error: { code: 'invalid-argument' },
    });
    expect(await t.req('rtdb.set', { path: '/x' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-argument' },
    });
    expect(t.calls).toHaveLength(0);
  });

  it('rtdb.get of nothing is null, not undefined', async () => {
    const t = setup();
    expect(await t.req('rtdb.get', { path: '/nothing' })).toMatchObject({ ok: true, value: null });
  });
});

describe('list queries', () => {
  const q = async (query: unknown) => {
    const t = setup();
    const res = await t.req('fs.list', { path: '/todos', query });
    return { res, sent: t.calls[0]?.args[0] as CheckedQuery | undefined };
  };

  it('defaults to 100 and caps the limit at 500', async () => {
    expect((await q(undefined)).sent).toEqual({
      where: [],
      orderBy: null,
      limit: 100,
      startAfter: null,
    });
    expect((await q({ limit: 20 })).sent!.limit).toBe(20);
    expect((await q({ limit: 100000 })).sent!.limit).toBe(500);
    expect((await q({ limit: 2.9 })).sent!.limit).toBe(2);
  });

  it('passes checked where / orderBy / startAfter, converting Dates', async () => {
    const { sent } = await q({
      where: [
        ['n', '>', 1],
        ['at', '<=', new Date(9)],
      ],
      orderBy: ['n'],
      startAfter: 'doc7',
    });
    expect(sent).toEqual({
      where: [
        ['n', '>', 1],
        ['at', '<=', new Stamp(9)],
      ],
      orderBy: ['n', 'asc'],
      limit: 100,
      startAfter: 'doc7',
    });
  });

  it('refuses unknown operators and malformed queries', async () => {
    const bad = [
      { where: [['n', 'like', 1]] },
      { where: [['n', '==']] },
      { where: [[5, '==', 1]] },
      { where: 'n == 1' },
      { where: [['n', '==', SERVER_TIME]] },
      { orderBy: 'n' },
      { orderBy: ['n', 'sideways'] },
      { limit: 0 },
      { limit: '10' },
      { startAfter: 'a/b' },
      { startAfter: '..' },
      { startAfter: 5 },
      'limit 5',
      [1],
    ];
    for (const query of bad) {
      const { res, sent } = await q(query);
      expect(res, JSON.stringify(query)).toMatchObject({
        ok: false,
        error: { code: 'invalid-argument' },
      });
      expect(sent).toBeUndefined();
    }
  });
});

describe('read-only viewer', () => {
  it('every write op is refused up front; reads, kv and subscriptions still work', async () => {
    // A write grant on ENG, so §K's reads answer and its writes meet the read-only gate.
    const t = setup({ role: 'viewer', readOnly: true, boards: { [ENG_ID]: 'write' } });
    const args: Record<string, unknown> = {
      path: '/a/b',
      data: {},
      patch: {},
      value: 1,
      blob: new Blob(['x']),
      key: 'k',
    };
    const tkArgs = { board: 'ENG', key: 'ENG-1', ticket: { title: 'x' }, patch: {}, markdown: 'm' };
    for (const op of DRIVER_OPS) {
      const a = op.startsWith('tk.')
        ? tkArgs
        : op.startsWith('mem.')
          ? { memory: 'mem01', path: 'a.md', text: 'x' }
          : op === 'fs.add' || op === 'fs.list' || op === 'fs.onList'
            ? { ...args, path: '/a' }
            : args;
      const res = await t.req(op, a);
      if (DRIVER_WRITE_OPS.has(op))
        expect(res, op).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
      else expect(res, op).toMatchObject({ ok: true });
    }
    const written = t.calls.filter(
      (c) => !c.path.startsWith(KV) && /set|update|delete|add|push|remove|upload/.test(c.op),
    );
    expect(written).toEqual([]);
  });

  it('setAccess flips behaviour and sends the readonly signal only on a change', async () => {
    const t = setup({ role: 'viewer', readOnly: false });
    expect((await t.req('fs.delete', { path: '/a/b' })).ok).toBe(true);
    t.broker.setAccess('viewer', true);
    t.broker.setAccess('viewer', true);
    expect(t.of('signal')).toEqual([expect.objectContaining({ name: 'readonly', value: true })]);
    expect(await t.req('fs.delete', { path: '/a/b' })).toMatchObject({
      ok: false,
      error: { code: 'permission-denied' },
    });
    t.broker.setAccess('editor', false);
    expect(t.of('signal')).toHaveLength(2);
    expect((await t.req('fs.delete', { path: '/a/b' })).ok).toBe(true);
    // The next handshake (a reload) tells the new role.
    t.say({ type: 'ready' });
    expect(t.of('hello')[0]).toMatchObject({ me: { role: 'editor', readOnly: false } });
  });
});

describe('live listeners', () => {
  it('answers { sub }, forwards snapshots as events, and unsub closes the listener', async () => {
    const t = setup();
    const res = await t.req('fs.onDoc', { path: '/a/b' });
    const sub = (res.value as { sub: string }).sub;
    expect(t.broker.listeners).toBe(1);
    t.live[0]!.next({ exists: true, data: { at: new Stamp(3) } } as never);
    expect(t.of('event')).toEqual([
      expect.objectContaining({
        sub,
        ok: true,
        value: { id: 'b', path: '/a/b', exists: true, data: { at: new Date(3) } },
      }),
    ]);
    t.say({ type: 'unsub', sub });
    expect(t.live[0]!.stopped).toBe(true);
    expect(t.broker.listeners).toBe(0);
    t.live[0]!.next({ exists: false, data: null } as never);
    expect(t.of('event')).toHaveLength(1);
    // Unknown / malformed unsub: nothing happens.
    t.say({ type: 'unsub', sub: 'nope' });
    t.say({ type: 'unsub', sub: 42 });
  });

  it('onList and rtdb.on forward what they hear', async () => {
    const t = setup();
    await t.req('fs.onList', { path: '/a', query: { limit: 2 } });
    await t.req('rtdb.on', { path: '/room' });
    expect(t.calls[0]).toMatchObject({ path: `${FS}/a`, args: [{ limit: 2 }] });
    t.live[0]!.next([{ id: 'x', data: { n: 1 } }] as never);
    t.live[1]!.next(undefined as never);
    expect(t.of('event').map((e) => e.value)).toEqual([
      [{ id: 'x', path: '/a/x', exists: true, data: { n: 1 } }],
      null,
    ]);
  });

  it(`caps them at ${ARTIFACT_MAX_LISTENERS} and frees a slot on unsub`, async () => {
    const t = setup();
    const subs: string[] = [];
    for (let i = 0; i < ARTIFACT_MAX_LISTENERS; i++)
      subs.push(((await t.req('rtdb.on', { path: `/n/${i}` })).value as { sub: string }).sub);
    expect(new Set(subs).size).toBe(ARTIFACT_MAX_LISTENERS);
    expect(await t.req('rtdb.on', { path: '/one-too-many' })).toMatchObject({
      ok: false,
      error: { code: 'quota' },
    });
    expect(await t.req('fs.onDoc', { path: '/a/b' })).toMatchObject({
      ok: false,
      error: { code: 'quota' },
    });
    expect(t.live).toHaveLength(ARTIFACT_MAX_LISTENERS);
    t.say({ type: 'unsub', sub: subs[0] });
    expect((await t.req('rtdb.on', { path: '/now-it-fits' })).ok).toBe(true);
    expect(t.broker.listeners).toBe(ARTIFACT_MAX_LISTENERS);
  });

  it('a listener error ends the subscription: one error event, the slot is freed', async () => {
    const t = setup({ maxListeners: 1 });
    const sub = ((await t.req('fs.onList', { path: '/a' })).value as { sub: string }).sub;
    t.live[0]!.error(
      Object.assign(new Error('Missing or insufficient permissions.'), {
        code: 'permission-denied',
      }),
    );
    t.live[0]!.error(new Error('again'));
    expect(t.of('event')).toEqual([
      expect.objectContaining({
        sub,
        ok: false,
        error: { code: 'permission-denied', message: 'Missing or insufficient permissions.' },
      }),
    ]);
    expect(t.live[0]!.stopped).toBe(true);
    expect((await t.req('fs.onList', { path: '/a' })).ok).toBe(true);
  });

  it("a fresh 'ready' (the iframe reloaded or navigated) drops the old document's listeners", async () => {
    const t = setup();
    await t.req('fs.onDoc', { path: '/a/b' });
    await t.req('rtdb.on', { path: '/x' });
    t.say({ type: 'ready' });
    expect(t.live.every((l) => l.stopped)).toBe(true);
    expect(t.broker.listeners).toBe(0);
    expect(t.of('hello')).toHaveLength(1);
  });

  it('stop() closes everything (unmount)', async () => {
    const t = setup();
    await t.req('fs.onDoc', { path: '/a/b' });
    await t.req('fs.onList', { path: '/a' });
    t.broker.stop();
    expect(t.live.every((l) => l.stopped)).toBe(true);
    expect(t.broker.listeners).toBe(0);
  });
});

describe('revoked', () => {
  it('signals once, drops listeners and refuses everything after', async () => {
    const t = setup();
    await t.req('fs.onDoc', { path: '/a/b' });
    t.broker.revoke();
    t.broker.revoke();
    expect(t.of('signal')).toEqual([expect.objectContaining({ name: 'revoked', value: null })]);
    expect(t.live[0]!.stopped).toBe(true);
    expect(t.broker.revoked).toBe(true);
    const before = t.calls.length;
    for (const op of ['fs.get', 'kv.get', 'rtdb.on', 'fs.set'])
      expect(await t.req(op, { path: '/a/b', key: 'k', data: {} })).toMatchObject({
        ok: false,
        error: { code: 'permission-denied' },
      });
    expect(t.calls).toHaveLength(before);
    t.broker.announceBuild('b2');
    t.broker.setAccess('viewer', true);
    expect(t.of('signal')).toHaveLength(1);
  });

  it('announceBuild sends the build signal', () => {
    const t = setup();
    t.broker.announceBuild('build99999');
    expect(t.of('signal')).toEqual([
      expect.objectContaining({ name: 'build', value: 'build99999' }),
    ]);
  });
});

describe('uploads and files', () => {
  it('uploads straight to the artifact prefix with a content type', async () => {
    const t = setup();
    const blob = new Blob(['abc'], { type: 'image/png' });
    await t.req('st.upload', { path: '/a.png', blob });
    await t.req('st.upload', {
      path: '/b.bin',
      blob: new Blob(['x']),
      contentType: 'application/x-thing',
    });
    await t.req('st.upload', { path: '/c', blob: new Blob(['x']) });
    expect(t.calls.map((c) => [c.path, c.args[1]])).toEqual([
      [`${ST}/a.png`, 'image/png'],
      [`${ST}/b.bin`, 'application/x-thing'],
      [`${ST}/c`, 'application/octet-stream'],
    ]);
  });

  it(`refuses more than ${ARTIFACT_UPLOAD_MAX_BYTES / 1024 / 1024} MB, and anything that is not a blob, before uploading`, async () => {
    const t = setup();
    expect(
      await t.req('st.upload', {
        path: '/big',
        blob: { size: ARTIFACT_UPLOAD_MAX_BYTES + 1, type: '' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'quota' } });
    for (const blob of [undefined, 'text', { size: '3' }, 42])
      expect(await t.req('st.upload', { path: '/x', blob })).toMatchObject({
        ok: false,
        error: { code: 'invalid-argument' },
      });
    expect(
      await t.req('st.upload', { path: '/x', blob: new Blob(['x']), contentType: 5 }),
    ).toMatchObject({ ok: false });
    expect(t.calls).toHaveLength(0);
  });

  it('url / list / delete go to the commands with a normalised artifact-view path', async () => {
    const t = setup();
    expect((await t.req('st.url', { path: 'pics//a.png' })).value).toEqual({
      url: 'https://signed/pics/a.png',
      expiresAt: 99,
    });
    await t.req('st.list', {});
    await t.req('st.list', { path: 'pics' });
    await t.req('st.delete', { path: '/pics/a.png' });
    expect(t.calls.map((c) => [c.op, c.path])).toEqual([
      ['st.url', '/pics/a.png'],
      ['st.list', '/'],
      ['st.list', '/pics/'],
      ['st.delete', '/pics/a.png'],
    ]);
  });
});

describe('nothing the iframe sends takes the broker down', () => {
  it('malformed requests are answered invalid-argument or dropped — never thrown', async () => {
    const t = setup();
    expect(await t.req('fs.nuke', { path: '/a/b' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-argument' },
    });
    expect(await t.req('constructor', {})).toMatchObject({
      ok: false,
      error: { code: 'invalid-argument' },
    });
    for (const args of [undefined, null, 'x', 5, [], new Map()])
      expect(await t.req('fs.get', args)).toMatchObject({
        ok: false,
        error: { code: 'invalid-argument' },
      });
    for (const path of [undefined, null, 5, {}, [], 'x'.repeat(2000)])
      expect(await t.req('fs.get', { path })).toMatchObject({
        ok: false,
        error: { code: 'invalid-argument' },
      });

    const before = t.posted.length;
    // No usable id: nobody to answer, so nothing is posted and nothing runs.
    for (const id of [undefined, 5, '', {}, 'x'.repeat(500)])
      expect(() => t.say({ type: 'req', id, op: 'fs.get', args: { path: '/a/b' } })).not.toThrow();
    expect(() => t.say({ type: 'nonsense' })).not.toThrow();
    expect(() => t.say({ type: 'req' })).not.toThrow();
    // A message whose getters throw.
    const trap = new Proxy(
      {},
      {
        get: () => {
          throw new Error('boom');
        },
      },
    );
    expect(() => t.broker.handle({ source: t.frame, data: trap })).not.toThrow();
    await Promise.resolve();
    expect(t.posted).toHaveLength(before);
    expect(t.calls).toHaveLength(0);
  });

  it('a store that throws becomes an error answer', async () => {
    const t = setup();
    t.failWith(
      Object.assign(new Error('Missing or insufficient permissions.'), {
        code: 'permission-denied',
      }),
    );
    expect(await t.req('fs.get', { path: '/a/b' })).toMatchObject({
      ok: false,
      error: { code: 'permission-denied', message: 'Missing or insufficient permissions.' },
    });
    expect(await t.req('fs.onDoc', { path: '/a/b' })).toMatchObject({ ok: true });
    expect(t.of('event')).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'permission-denied' }),
      }),
    ]);
    expect(t.broker.listeners).toBe(0);
  });

  it('a result that cannot be cloned becomes an error answer, not a lost request', async () => {
    const fake = fakeBackend();
    const posted: Posted[] = [];
    const frame = {
      postMessage(msg: unknown) {
        const m = msg as Posted;
        if (m.type === 'res' && m.ok === true) throw new Error('DataCloneError');
        posted.push(m);
      },
    };
    const broker = createBroker({
      artifactId: ID,
      uid: UID,
      frame: () => frame,
      artifact: () => ({ name: 'x', buildId: 'b' }),
      viewer: () => ({ name: null, email: null, photoURL: null }),
      role: 'owner',
      readOnly: false,
      backend: fake.backend,
    });
    broker.handle({
      source: frame,
      data: {
        tag: DRIVER_TAG,
        v: DRIVER_PROTOCOL_VERSION,
        type: 'req',
        id: 'q',
        op: 'rtdb.get',
        args: { path: '/x' },
      },
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(posted).toEqual([
      expect.objectContaining({
        id: 'q',
        ok: false,
        error: expect.objectContaining({ code: 'unavailable' }),
      }),
    ]);
  });
});

describe('toDriverError', () => {
  it('maps Firebase, Storage and command errors to the five driver codes', () => {
    const code = (c: unknown) => toDriverError({ code: c, message: 'm' }).code;
    expect(code('permission-denied')).toBe('permission-denied');
    expect(code('firestore/permission-denied')).toBe('permission-denied');
    expect(code('PERMISSION_DENIED')).toBe('permission-denied');
    expect(code('storage/unauthorized')).toBe('permission-denied');
    expect(code('forbidden')).toBe('permission-denied');
    expect(code('not-found')).toBe('not-found');
    expect(code('storage/object-not-found')).toBe('not-found');
    expect(code('not_found')).toBe('not-found');
    expect(code('failed-precondition')).toBe('invalid-argument');
    expect(code('invalid')).toBe('invalid-argument');
    expect(code('resource-exhausted')).toBe('quota');
    expect(code('storage/quota-exceeded')).toBe('quota');
    expect(code('too_large')).toBe('quota');
    expect(code('unavailable')).toBe('unavailable');
    expect(code('internal')).toBe('unavailable');
    expect(code(undefined)).toBe('unavailable');
    expect(toDriverError(null)).toEqual({ code: 'unavailable', message: 'Something went wrong' });
    expect(toDriverError(new Error('offline'))).toEqual({
      code: 'unavailable',
      message: 'offline',
    });
  });
});

describe('§K board tickets: the grant, then the viewer', () => {
  it('a board that is not granted does not exist for the artifact; one the viewer cannot read is skipped', async () => {
    const t = setup({ boards: { [ENG_ID]: 'read', [SEC_ID]: 'write' } });
    const boards = await t.req('tk.boards', {});
    expect(boards.ok).toBe(true);
    // SEC is granted, but this viewer is not on it: not listed, not usable.
    expect((boards.value as { key: string }[]).map((b) => b.key)).toEqual(['ENG']);
    expect((await t.req('tk.list', { board: 'SEC' })).error).toMatchObject({
      code: 'permission-denied',
    });
    const none = setup();
    expect((await none.req('tk.list', { board: 'ENG' })).error).toMatchObject({
      code: 'permission-denied',
      message: 'This artifact has no access to board ENG',
    });
    expect((await none.req('tk.boards', {})).value).toEqual([]);
  });

  it('reads: names, query, a key resolves its board', async () => {
    const t = setup({ boards: { [ENG_ID]: 'read' } });
    const list = await t.req('tk.list', { board: 'eng', query: { assignee: 'me' } });
    expect((list.value as { key: string; url: string }[]).map((x) => [x.key, x.url])).toEqual([
      ['ENG-1', 'https://app.example/t/ENG-1'],
    ]);
    const one = await t.req('tk.get', { key: 'ENG-2' });
    expect(one.value).toMatchObject({ key: 'ENG-2', stage: { name: 'In review' } });
    expect((await t.req('tk.get', { key: 'ENG-99' })).value).toBeNull();
    expect((await t.req('tk.get', { key: 'nope' })).error).toMatchObject({
      code: 'invalid-argument',
    });
    // canWrite needs a write grant AND the viewer's own role.
    const [b] = (await t.req('tk.boards', {})).value as { canWrite: boolean }[];
    expect(b!.canWrite).toBe(false);
  });

  it('writes need a write grant; then they are the viewer’s own commands, names resolved', async () => {
    const ro = setup({ boards: { [ENG_ID]: 'read' } });
    expect(
      (await ro.req('tk.create', { board: 'ENG', ticket: { title: 'x' } })).error,
    ).toMatchObject({
      code: 'permission-denied',
      message: 'This artifact may only read board ENG',
    });
    expect(ro.tk.writes).toEqual([]);

    const t = setup({ boards: { [ENG_ID]: 'write' } });
    const made = await t.req('tk.create', {
      board: 'ENG',
      ticket: { title: ' New ', stage: 'In review', assignees: ['me'], priority: 'High' },
    });
    expect(made.value).toEqual({ id: 't4', key: 'ENG-4' });
    expect(t.tk.writes[0]!.args[0]).toMatchObject({
      boardId: ENG_ID,
      title: 'New',
      stageId: 'st_rev',
      assigneeUids: [UID],
      priorityId: 'p_high',
    });
    expect((await t.req('tk.update', { key: 'ENG-1', patch: { stage: 'Done' } })).ok).toBe(true);
    expect(t.tk.writes[1]!.args).toEqual([ENG_ID, 't1', { stageId: 'st_done' }]);
    expect((await t.req('tk.comment', { key: 'ENG-1', markdown: 'Hi **there**' })).ok).toBe(true);
    expect(t.tk.writes[2]!.args[3]).toBe('Hi **there**');
    // Unknown names are the artifact's mistake, said plainly.
    expect(
      (await t.req('tk.update', { key: 'ENG-1', patch: { stage: 'Nope' } })).error,
    ).toMatchObject({ code: 'invalid-argument' });
    expect((await t.req('tk.update', { key: 'ENG-99', patch: {} })).error).toMatchObject({
      code: 'not-found',
    });
  });

  it('a read-only viewer writes no ticket, whatever the grant', async () => {
    const t = setup({ role: 'viewer', readOnly: true, boards: { [ENG_ID]: 'write' } });
    for (const [op, args] of [
      ['tk.create', { board: 'ENG', ticket: { title: 'x' } }],
      ['tk.update', { key: 'ENG-1', patch: { title: 'y' } }],
      ['tk.comment', { key: 'ENG-1', markdown: 'z' }],
    ] as const)
      expect((await t.req(op, args)).error).toMatchObject({ code: 'permission-denied' });
    expect(t.tk.writes).toEqual([]);
    expect((await t.req('tk.list', { board: 'ENG' })).ok).toBe(true);
  });

  it('tk.onList: { sub } first, then the list, again after a write; counts toward the cap', async () => {
    const t = setup({ boards: { [ENG_ID]: 'write' }, maxListeners: 1 });
    const res = await t.req('tk.onList', { board: 'ENG', query: { stage: 'To do' } });
    const sub = (res.value as { sub: string }).sub;
    await new Promise((r) => setTimeout(r, 0));
    const events = () =>
      t
        .of('event')
        .filter((e) => e.sub === sub)
        .map((e) => (e.value as { key: string }[]).map((x) => x.key));
    expect(events()).toEqual([['ENG-1']]);
    await t.req('tk.create', { board: 'ENG', ticket: { title: 'Another' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(events().at(-1)).toEqual(['ENG-1', 'ENG-4']);
    expect(t.broker.listeners).toBe(1);
    expect((await t.req('tk.onList', { board: 'ENG' })).error).toMatchObject({ code: 'quota' });
  });
});
