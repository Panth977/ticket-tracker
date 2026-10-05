/**
 * BOTH HALVES, WIRED TOGETHER: the real driver (driver/src — what is bundled
 * into /backend-driver/v1/driver.js) inside a fake iframe window, talking to
 * the real broker in a fake host window, over a postMessage that structured-
 * clones like a browser's. The stores are an in-memory fake; everything
 * between an artifact's `db.firestore.set(…)` and the store call is the code
 * that ships. If the two sides ever disagree about the protocol, this fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDriver } from '../../../../driver/src/driver';
import { FakeWindow, flush, framePair } from '../../../../driver/test/fakeWindow';
import { createBroker, type BrokerBackend, type StoredDoc, type StoredRow } from './broker';
import { ENG_ID, fakeTickets } from './fakeTickets';

const ID = 'artAAAAAA1';
const FS = `artifacts/${ID}/db/data`;

class Stamp {
  constructor(readonly ms: number) {}
}

/** A tiny live document store: enough for get / set / list / listeners. */
function memoryBackend() {
  const tk = fakeTickets('u1');
  const docs = new Map<string, Record<string, unknown>>();
  const watchers = new Set<() => void>();
  const changed = () => watchers.forEach((w) => w());
  const snap = (path: string): StoredDoc => ({
    exists: docs.has(path),
    data: docs.get(path) ?? null,
  });
  const rowsOf = (col: string): StoredRow[] =>
    [...docs.entries()]
      .filter(([p]) => p.startsWith(`${col}/`) && !p.slice(col.length + 1).includes('/'))
      .map(([p, data]) => ({ id: p.slice(col.length + 1), data }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  const watch = (fire: () => void) => {
    watchers.add(fire);
    fire();
    return () => void watchers.delete(fire);
  };
  let rt: unknown = null;
  const no = async () => {
    throw Object.assign(new Error('not in this test'), { code: 'unavailable' });
  };
  const backend: BrokerBackend = {
    fs: {
      codec: { date: (d) => new Stamp(d.getTime()), serverTime: () => new Stamp(42) },
      asDate: (v) => (v instanceof Stamp ? new Date(v.ms) : null),
      get: async (path) => snap(path),
      async set(path, data, merge) {
        docs.set(path, merge ? { ...docs.get(path), ...data } : data);
        changed();
      },
      async update(path, patch) {
        if (!docs.has(path))
          throw Object.assign(new Error('No document to update'), { code: 'not-found' });
        docs.set(path, { ...docs.get(path), ...patch });
        changed();
      },
      async delete(path) {
        docs.delete(path);
        changed();
      },
      async add(col, data) {
        const id = `auto${docs.size + 1}`;
        docs.set(`${col}/${id}`, data);
        changed();
        return id;
      },
      list: async (col, q) => rowsOf(col).slice(0, q.limit),
      onDoc: (path, next) => watch(() => next(snap(path))),
      onList: (col, q, next) => watch(() => next(rowsOf(col).slice(0, q.limit))),
    },
    rtdb: {
      codec: { date: (d) => d.getTime(), serverTime: () => 42, finiteOnly: true },
      get: async () => rt,
      async set(_p, v) {
        rt = v;
      },
      update: no,
      push: no as never,
      remove: no,
      on: () => () => {},
    },
    storage: { upload: async () => {} },
    files: { url: no as never, list: async () => [], delete: no },
    tickets: tk.backend,
  };
  return { backend, docs, watchers, tk };
}

function wire(role: 'owner' | 'viewer' = 'owner', readOnly = false) {
  const { host, frame } = framePair();
  const mem = memoryBackend();
  const broker = createBroker({
    artifactId: ID,
    uid: 'u1',
    // The broker posts to "the iframe's window": deliver it as coming from the host.
    frame: () => frameProxy,
    artifact: () => ({ name: 'Guest book', buildId: 'build12345' }),
    viewer: () => ({ name: 'Ana', email: 'ana@example.com', photoURL: null }),
    role,
    readOnly,
    backend: mem.backend,
    boards: () => ({ [ENG_ID]: 'write' }),
    origin: 'https://app.example',
  });
  const frameProxy = { postMessage: (msg: unknown) => frame.postFrom(host, msg) };
  // What the iframe posts arrives at the host window with source = the frame;
  // the broker compares it with frame(), so hand it the same object.
  host.addEventListener('message', ((e: { data: unknown; source: unknown }) =>
    broker.handle({ data: e.data, source: e.source === frame ? frameProxy : e.source })) as never);
  const db = createDriver(frame);
  return { db, broker, host, frame, ...mem };
}

/** Several message hops (req → res → event), each a few microtasks long. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await flush();
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('driver ⇄ broker', () => {
  it('handshakes: the artifact learns who is looking and which artifact it is', async () => {
    const { db } = wire('viewer', true);
    await db.ready;
    expect(db.mock).toBe(false);
    expect(db.artifact).toEqual({ id: ID, name: 'Guest book', buildId: 'build12345' });
    expect(db.me).toEqual({
      uid: 'u1',
      name: 'Ana',
      email: 'ana@example.com',
      photoURL: null,
      role: 'viewer',
      readOnly: true,
    });
  });

  it('a write lands under the artifact prefix, converted; the read comes back as the artifact wrote it', async () => {
    const { db, docs } = wire();
    const when = new Date('2026-02-03T04:05:06Z');
    await db.firestore.set('/entries/a', { text: 'hi', when, at: db.serverTime });
    expect([...docs.keys()]).toEqual([`${FS}/entries/a`]);
    expect(docs.get(`${FS}/entries/a`)).toEqual({
      text: 'hi',
      when: new Stamp(when.getTime()),
      at: new Stamp(42),
    });

    const got = await db.firestore.get('entries/a');
    expect(got).toEqual({
      id: 'a',
      path: '/entries/a',
      exists: true,
      data: { text: 'hi', when, at: new Date(42) },
    });

    const added = await db.firestore.add('/entries', { text: 'two' });
    expect(added).toEqual({ id: 'auto2', path: '/entries/auto2' });
    expect((await db.firestore.list('/entries')).map((d) => d.path)).toEqual([
      '/entries/a',
      '/entries/auto2',
    ]);
  });

  it('errors arrive as BackendDriverError with the mapped code', async () => {
    const { db, docs } = wire();
    await expect(db.firestore.update('/entries/missing', { x: 1 })).rejects.toMatchObject({
      name: 'BackendDriverError',
      code: 'not-found',
    });
    await expect(db.firestore.get('/../boards/b1')).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(db.firestore.set('/a/b', { m: new Map() })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(db.storage.url('/nope.png')).rejects.toMatchObject({ code: 'unavailable' });
    expect(docs.size).toBe(0);
  });

  it('live: onList fires now and on every change, until unsubscribe closes the host listener', async () => {
    const { db, broker, watchers } = wire();
    await db.ready;
    const seen: string[][] = [];
    const off = db.firestore.onList('/entries', null, (docs) => seen.push(docs.map((d) => d.id)));
    await settle();
    expect(seen).toEqual([[]]);
    expect(broker.listeners).toBe(1);

    await db.firestore.set('/entries/a', { n: 1 });
    await db.firestore.set('/entries/b', { n: 2 });
    await settle();
    expect(seen).toEqual([[], ['a'], ['a', 'b']]);

    off();
    await settle();
    expect(broker.listeners).toBe(0);
    expect(watchers.size).toBe(0);
    await db.firestore.delete('/entries/a');
    await settle();
    expect(seen).toHaveLength(3);
  });

  it('a read-only viewer: reads work, writes are refused before the store is touched, and the signal flips db.me', async () => {
    const { db, broker, docs } = wire('viewer', true);
    await db.ready;
    await expect(db.firestore.set('/a/b', { n: 1 })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(docs.size).toBe(0);
    expect((await db.firestore.get('/a/b')).exists).toBe(false);

    const heard: boolean[] = [];
    db.on('readonly', (v) => heard.push(v));
    broker.setAccess('viewer', false); // the owner turned the switch off
    await settle();
    expect(heard).toEqual([false]);
    expect(db.me?.readOnly).toBe(false);
    await db.firestore.set('/a/b', { n: 1 });
    expect(docs.has(`${FS}/a/b`)).toBe(true);
  });

  it('revoked: the artifact is told, its listeners are gone, and every later call fails', async () => {
    const { db, broker, watchers } = wire();
    db.firestore.onDoc('/a/b', () => {});
    let told = false;
    db.on('revoked', () => (told = true));
    await settle();
    expect(watchers.size).toBe(1);
    broker.revoke();
    await settle();
    expect(told).toBe(true);
    expect(watchers.size).toBe(0);
    await expect(db.firestore.get('/a/b')).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('a message from any other window is not heard by either side', async () => {
    const { db, host, frame, docs } = wire();
    await db.ready;
    const stranger = new FakeWindow();
    host.postFrom(stranger, {
      tag: 'tm-artifact',
      v: 1,
      type: 'req',
      id: 'x',
      op: 'fs.set',
      args: { path: '/a/b', data: { evil: true } },
    });
    frame.postFrom(stranger, {
      tag: 'tm-artifact',
      v: 1,
      type: 'signal',
      name: 'revoked',
      value: null,
    });
    await settle();
    expect(docs.size).toBe(0);
    await expect(db.firestore.get('/a/b')).resolves.toMatchObject({ exists: false });
  });
});

describe('§K board tickets, driver ⇄ broker', () => {
  it('tickets.list / create / onList round-trip as the shipped driver calls them', async () => {
    const { db, tk } = wire();
    await db.ready;
    const boards = await db.tickets.boards();
    expect(boards.map((b) => [b.key, b.access])).toEqual([['ENG', 'write']]);
    expect((await db.tickets.list('ENG', { assignee: 'me' })).map((t) => t.key)).toEqual(['ENG-1']);

    const seen: string[][] = [];
    const off = db.tickets.onList('ENG', { stage: 'To do' }, (ts) =>
      seen.push(ts.map((t) => t.key)),
    );
    await settle();
    const made = await db.tickets.create('ENG', { title: 'From the dashboard', assignees: ['me'] });
    await settle();
    expect(made).toEqual({ id: 't4', key: 'ENG-4' });
    expect(tk.writes[0]!.args[0]).toMatchObject({ boardId: ENG_ID, assigneeUids: ['u1'] });
    expect(seen.at(-1)).toEqual(['ENG-1', 'ENG-4']);
    off();
    await expect(db.tickets.list('OPS')).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
