/**
 * The driver against a (fake) TaskManager host: the handshake, one Promise per
 * request, error mapping, subscriptions and signals — i.e. the iframe half of
 * the protocol in @tm/shared/artifacts/driver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRIVER_PROTOCOL_VERSION,
  DRIVER_TAG,
  SERVER_TIME,
  type FromArtifact,
  type FromHost,
} from '@tm/shared/artifacts/driver';
import { createDriver } from '../src/driver.js';
import { BackendDriverError } from '../src/transport.js';
import { FakeWindow, flush, framePair } from './fakeWindow.js';

const base = { tag: DRIVER_TAG, v: DRIVER_PROTOCOL_VERSION } as const;
const HELLO = {
  ...base,
  type: 'hello',
  artifact: { id: 'art123456', name: 'Sales', buildId: 'build12345' },
  me: {
    uid: 'u1',
    name: 'Ana',
    email: 'ana@example.com',
    photoURL: null,
    role: 'editor',
    readOnly: false,
  },
} as const satisfies FromHost;

type Msg = FromArtifact;
const sent = (host: FakeWindow, type?: Msg['type']) =>
  (host.received as Msg[]).filter((m) => !type || m.type === type);
const reqs = (host: FakeWindow) => sent(host, 'req') as Extract<Msg, { type: 'req' }>[];

async function greeted() {
  const { host, frame } = framePair();
  const db = createDriver(frame);
  await flush();
  frame.postFrom(host, HELLO);
  await db.ready;
  return { host, frame, db };
}
/** Answer request number `n` (0-based) the way the broker would. */
function answer(
  host: FakeWindow,
  frame: FakeWindow,
  n: number,
  res: { ok: true; value: unknown } | { ok: false; error: unknown },
) {
  frame.postFrom(host, { ...base, type: 'res', id: reqs(host)[n]!.id, ...res });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('handshake', () => {
  it('knocks at once and every 500 ms until hello, then stops', async () => {
    const { host, frame } = framePair();
    const db = createDriver(frame);
    expect(sent(host, 'ready')).toHaveLength(1);
    expect(sent(host)[0]).toEqual({ ...base, type: 'ready' });
    await vi.advanceTimersByTimeAsync(1100);
    expect(sent(host, 'ready')).toHaveLength(3);
    expect(db.me).toBeNull();

    frame.postFrom(host, HELLO);
    await db.ready;
    expect(db.me).toEqual(HELLO.me);
    expect(db.artifact).toEqual(HELLO.artifact);
    expect(db.mock).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent(host, 'ready')).toHaveLength(3);
  });

  it('never becomes the mock when framed; hints once after 5 s and keeps waiting', async () => {
    const { host, frame } = framePair();
    const db = createDriver(frame);
    let ready = false;
    void db.ready.then(() => (ready = true));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ready).toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.info).not.toHaveBeenCalled();
    frame.postFrom(host, HELLO);
    await db.ready;
    expect(db.mock).toBe(false);
  });

  it('ignores a hello that is not from the parent, and messages without the tag', async () => {
    const { host, frame } = framePair();
    const db = createDriver(frame);
    let ready = false;
    void db.ready.then(() => (ready = true));
    frame.postFrom(new FakeWindow(), HELLO);
    frame.postFrom(host, { type: 'hello', artifact: HELLO.artifact, me: HELLO.me });
    frame.postFrom(host, { ...HELLO, v: 2 });
    await flush();
    expect(ready).toBe(false);
  });

  it('calls made before ready are sent once the host has answered', async () => {
    const { host, frame } = framePair();
    const db = createDriver(frame);
    const p = db.firestore.get('/a/b');
    await flush();
    expect(reqs(host)).toHaveLength(0);
    frame.postFrom(host, HELLO);
    await flush();
    expect(reqs(host)).toHaveLength(1);
    answer(host, frame, 0, {
      ok: true,
      value: { id: 'b', path: '/a/b', exists: false, data: null },
    });
    await expect(p).resolves.toMatchObject({ exists: false });
  });
});

describe('request / response', () => {
  it('sends op + args with a unique id and resolves from the matching res', async () => {
    const { host, frame, db } = await greeted();
    const a = db.firestore.set('/a/b', { n: 1, at: db.serverTime }, { merge: true });
    const b = db.rtdb.get('/x');
    await flush();
    const [r1, r2] = reqs(host);
    expect(r1).toMatchObject({
      op: 'fs.set',
      args: { path: '/a/b', data: { n: 1, at: SERVER_TIME }, merge: true },
    });
    expect(r2).toMatchObject({ op: 'rtdb.get', args: { path: '/x' } });
    expect(r1!.id).not.toBe(r2!.id);
    // Answered out of order: each Promise gets its own answer.
    answer(host, frame, 1, { ok: true, value: 42 });
    answer(host, frame, 0, { ok: true, value: { ok: true } });
    await expect(b).resolves.toBe(42);
    await expect(a).resolves.toBeUndefined();
  });

  it('covers every part of the API with the protocol op it stands for', async () => {
    const { host, db } = await greeted();
    const blob = new Blob(['hi'], { type: 'text/plain' });
    void db.firestore.get('/a/b');
    void db.firestore.update('/a/b', { n: 2 });
    void db.firestore.delete('/a/b');
    void db.firestore.add('/a', { n: 3 });
    void db.firestore.list('/a', { limit: 5 });
    void db.rtdb.set('/x', 1);
    void db.rtdb.update('/x', { y: 1 });
    void db.rtdb.push('/x', 1);
    void db.rtdb.remove('/x');
    void db.storage.upload('/f.txt', blob, { contentType: 'text/plain' });
    void db.storage.url('/f.txt');
    void db.storage.list();
    void db.storage.delete('/f.txt');
    void db.kv.get('k');
    void db.kv.set('k', 1);
    void db.kv.delete('k');
    await flush();
    expect(reqs(host).map((r) => r.op)).toEqual([
      'fs.get',
      'fs.update',
      'fs.delete',
      'fs.add',
      'fs.list',
      'rtdb.set',
      'rtdb.update',
      'rtdb.push',
      'rtdb.remove',
      'st.upload',
      'st.url',
      'st.list',
      'st.delete',
      'kv.get',
      'kv.set',
      'kv.delete',
    ]);
    const upload = reqs(host).find((r) => r.op === 'st.upload')!.args as unknown as { blob: Blob };
    expect(upload.blob).toBeInstanceOf(Blob);
    expect(reqs(host).find((r) => r.op === 'st.list')!.args).toEqual({ path: '' });
  });

  it('tickets (§K): each method is its tk.* op with the args the broker reads', async () => {
    const { host, frame, db } = await greeted();
    void db.tickets.boards();
    void db.tickets.list('ENG', { assignee: 'me' });
    void db.tickets.get('ENG-1');
    void db.tickets.create('ENG', { title: 'x' });
    const upd = db.tickets.update('ENG-1', { stage: 'Done' });
    void db.tickets.comment('ENG-1', 'hi');
    const seen: unknown[] = [];
    db.tickets.onList('ENG', null, (ts) => seen.push(ts));
    await flush();
    expect(reqs(host).map((r) => [r.op, r.args])).toEqual([
      ['tk.boards', {}],
      ['tk.list', { board: 'ENG', query: { assignee: 'me' } }],
      ['tk.get', { key: 'ENG-1' }],
      ['tk.create', { board: 'ENG', ticket: { title: 'x' } }],
      ['tk.update', { key: 'ENG-1', patch: { stage: 'Done' } }],
      ['tk.comment', { key: 'ENG-1', markdown: 'hi' }],
      ['tk.onList', { board: 'ENG' }],
    ]);
    answer(host, frame, 4, { ok: true, value: { ok: true } });
    await expect(upd).resolves.toBeUndefined(); // update / comment resolve to nothing
    answer(host, frame, 6, { ok: true, value: { sub: 't1' } });
    await flush();
    frame.postFrom(host, {
      ...base,
      type: 'event',
      sub: 't1',
      ok: true,
      value: [{ key: 'ENG-1' }],
    });
    await flush();
    expect(seen).toEqual([[{ key: 'ENG-1' }]]);
  });

  it('tickets (§K): thread, onThread (both forms), fileUrl and aggregates are their tk.* ops', async () => {
    const { host, frame, db } = await greeted();
    void db.tickets.thread('ENG-1', { limit: 10, before: 'm9' });
    void db.tickets.thread('ENG-1');
    db.tickets.onThread('ENG-1', () => {});
    db.tickets.onThread('ENG-1', { limit: 5 }, () => {});
    const url = db.tickets.fileUrl('ENG-1', 'att_1');
    void db.tickets.aggregates('ENG', { field: 'Cost', from: '2026-10-01' });
    db.tickets.onAggregates('ENG', null, () => {});
    await flush();
    expect(reqs(host).map((r) => [r.op, r.args])).toEqual([
      ['tk.thread', { key: 'ENG-1', query: { limit: 10, before: 'm9' } }],
      ['tk.thread', { key: 'ENG-1' }],
      ['tk.onThread', { key: 'ENG-1' }],
      ['tk.onThread', { key: 'ENG-1', query: { limit: 5 } }],
      ['tk.fileUrl', { key: 'ENG-1', file: 'att_1' }],
      ['tk.aggregates', { board: 'ENG', query: { field: 'Cost', from: '2026-10-01' } }],
      ['tk.onAggregates', { board: 'ENG' }],
    ]);
    answer(host, frame, 4, { ok: true, value: { url: 'https://signed/f', expiresAt: 1 } });
    await expect(url).resolves.toBe('https://signed/f');
  });

  it('storage.url resolves to the URL string', async () => {
    const { host, frame, db } = await greeted();
    const p = db.storage.url('/f.png');
    await flush();
    answer(host, frame, 0, { ok: true, value: { url: 'https://signed/x', expiresAt: 1 } });
    await expect(p).resolves.toBe('https://signed/x');
  });
});

describe('error mapping', () => {
  it('rejects with an Error subclass carrying the code and message', async () => {
    const { host, frame, db } = await greeted();
    const p = db.firestore.delete('/a/b');
    await flush();
    answer(host, frame, 0, {
      ok: false,
      error: { code: 'permission-denied', message: 'read-only' },
    });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendDriverError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({
      name: 'BackendDriverError',
      code: 'permission-denied',
      message: 'read-only',
    });
  });

  it('an unknown or missing code reads as unavailable', async () => {
    const { host, frame, db } = await greeted();
    const p = db.kv.get('k');
    const q = db.kv.get('k2');
    await flush();
    answer(host, frame, 0, { ok: false, error: { code: 'weird', message: 'x' } });
    answer(host, frame, 1, { ok: false, error: null });
    await expect(p).rejects.toMatchObject({ code: 'unavailable', message: 'x' });
    await expect(q).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('a value that cannot cross postMessage is invalid-argument, not a hang', async () => {
    const { db } = await greeted();
    await expect(db.firestore.set('/a/b', { fn: () => 1 })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
});

describe('subscriptions', () => {
  it('routes events to the callback and posts unsub on unsubscribe', async () => {
    const { host, frame, db } = await greeted();
    const seen: unknown[] = [];
    const off = db.firestore.onDoc('/a/b', (d) => seen.push(d));
    await flush();
    expect(reqs(host)[0]).toMatchObject({ op: 'fs.onDoc', args: { path: '/a/b' } });
    answer(host, frame, 0, { ok: true, value: { sub: 's1' } });
    await flush();
    frame.postFrom(host, { ...base, type: 'event', sub: 's1', ok: true, value: { id: 'b', n: 1 } });
    frame.postFrom(host, { ...base, type: 'event', sub: 'other', ok: true, value: 'not mine' });
    frame.postFrom(host, { ...base, type: 'event', sub: 's1', ok: true, value: { id: 'b', n: 2 } });
    await flush();
    expect(seen).toEqual([
      { id: 'b', n: 1 },
      { id: 'b', n: 2 },
    ]);

    off();
    expect(sent(host, 'unsub')).toEqual([{ ...base, type: 'unsub', sub: 's1' }]);
    frame.postFrom(host, { ...base, type: 'event', sub: 's1', ok: true, value: 'late' });
    await flush();
    expect(seen).toHaveLength(2);
    off(); // idempotent
    expect(sent(host, 'unsub')).toHaveLength(1);
  });

  it('unsubscribing before the host answered still closes the listener over there', async () => {
    const { host, frame, db } = await greeted();
    const off = db.rtdb.on('/x', () => {});
    await flush();
    off();
    expect(sent(host, 'unsub')).toHaveLength(0);
    answer(host, frame, 0, { ok: true, value: { sub: 's9' } });
    await flush();
    expect(sent(host, 'unsub')).toEqual([{ ...base, type: 'unsub', sub: 's9' }]);
  });

  it('onList sends the query; a refused start and an error event both reach onError', async () => {
    const { host, frame, db } = await greeted();
    const errors: unknown[] = [];
    db.firestore.onList(
      '/a',
      { where: [['n', '>', 1]], limit: 3 },
      () => {},
      (e) => errors.push(e.code),
    );
    db.firestore.onList(
      '/b',
      null,
      () => {},
      (e) => errors.push(e.code),
    );
    await flush();
    expect(reqs(host)[0]!.args).toEqual({
      path: '/a',
      query: { where: [['n', '>', 1]], limit: 3 },
    });
    answer(host, frame, 0, { ok: false, error: { code: 'quota', message: 'too many listeners' } });
    answer(host, frame, 1, { ok: true, value: { sub: 's2' } });
    await flush();
    frame.postFrom(host, {
      ...base,
      type: 'event',
      sub: 's2',
      ok: false,
      error: { code: 'permission-denied', message: 'no' },
    });
    await flush();
    expect(errors).toEqual(['quota', 'permission-denied']);
  });

  it('a callback that throws does not stop the next event, and needs a function', async () => {
    const { host, frame, db } = await greeted();
    let n = 0;
    db.rtdb.on('/x', () => {
      n++;
      throw new Error('artifact bug');
    });
    await flush();
    answer(host, frame, 0, { ok: true, value: { sub: 's1' } });
    await flush();
    frame.postFrom(host, { ...base, type: 'event', sub: 's1', ok: true, value: 1 });
    frame.postFrom(host, { ...base, type: 'event', sub: 's1', ok: true, value: 2 });
    await flush();
    expect(n).toBe(2);
    expect(() => db.rtdb.on('/x', undefined as never)).toThrow(TypeError);
  });
});

describe('signals', () => {
  it('readonly updates db.me, build carries the id, revoked refuses every later call', async () => {
    const { host, frame, db } = await greeted();
    const got: unknown[] = [];
    const off = db.on('readonly', (v) => got.push(['readonly', v]));
    db.on('build', (v) => got.push(['build', v]));
    db.on('revoked', (v) => got.push(['revoked', v]));
    frame.postFrom(host, { ...base, type: 'signal', name: 'readonly', value: true });
    frame.postFrom(host, { ...base, type: 'signal', name: 'build', value: 'build99999' });
    await flush();
    expect(db.me?.readOnly).toBe(true);
    off();
    frame.postFrom(host, { ...base, type: 'signal', name: 'readonly', value: false });
    frame.postFrom(host, { ...base, type: 'signal', name: 'revoked', value: null });
    await flush();
    expect(got).toEqual([
      ['readonly', true],
      ['build', 'build99999'],
      ['revoked', null],
    ]);
    const before = reqs(host).length;
    await expect(db.firestore.get('/a/b')).rejects.toMatchObject({ code: 'permission-denied' });
    expect(reqs(host)).toHaveLength(before);
  });
});
