/**
 * The mock backend (§E5): what an artifact runs against on a developer's
 * machine. It has to behave like the real one where an artifact can tell the
 * difference — paths, queries, live callbacks, read-only — and survive a
 * reload through localStorage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDriver, MOCK_AFTER_MS } from '../src/driver.js';
import { MOCK_STORAGE_KEY } from '../src/mock.js';
import { FakeWindow, flush, framePair } from './fakeWindow.js';

async function mock(search = '', win = new FakeWindow(search)) {
  const db = createDriver(win);
  await vi.advanceTimersByTimeAsync(MOCK_AFTER_MS);
  await db.ready;
  return { db, win };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('switching to the mock', () => {
  it('a top-level page becomes the mock after ~1.5 s and says so once', async () => {
    const win = new FakeWindow();
    const db = createDriver(win);
    let ready = false;
    void db.ready.then(() => (ready = true));
    await vi.advanceTimersByTimeAsync(MOCK_AFTER_MS - 100);
    expect(ready).toBe(false);
    expect(db.mock).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(ready).toBe(true);
    expect(db.mock).toBe(true);
    expect(console.info).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.info).mock.calls[0]![0])).toMatch(/MOCK/);
    expect(db.artifact).toEqual({ id: 'mock', name: 'Mock artifact', buildId: 'mock' });
  });

  it('?mock=1 forces it at once, even inside a frame', async () => {
    const { frame, host } = framePair('?mock=1');
    const db = createDriver(frame);
    await db.ready;
    expect(db.mock).toBe(true);
    expect(host.received).toHaveLength(0);
  });

  it('who you are comes from the URL', async () => {
    expect((await mock()).db.me).toMatchObject({
      uid: 'mock-user',
      role: 'owner',
      readOnly: false,
    });
    expect((await mock('?role=editor')).db.me).toMatchObject({ role: 'editor', readOnly: false });
    expect((await mock('?role=viewer')).db.me).toMatchObject({ role: 'viewer', readOnly: false });
    expect((await mock('?role=viewer&readonly=1')).db.me).toMatchObject({
      role: 'viewer',
      readOnly: true,
    });
    // The switch only ever binds viewers — and alone it makes you one, so it shows.
    expect((await mock('?readonly=1')).db.me).toMatchObject({ role: 'viewer', readOnly: true });
    expect((await mock('?role=owner&readonly=1')).db.me).toMatchObject({
      role: 'owner',
      readOnly: false,
    });
    expect((await mock('?role=admin')).db.me).toMatchObject({ role: 'owner' });
  });
});

describe('firestore', () => {
  it('get / set / merge / update / delete / add', async () => {
    const { db } = await mock();
    expect(await db.firestore.get('/todos/a')).toEqual({
      id: 'a',
      path: '/todos/a',
      exists: false,
      data: null,
    });

    await db.firestore.set('todos/a', { title: 'one', tags: { x: 1 } });
    expect(await db.firestore.get('/todos/a')).toEqual({
      id: 'a',
      path: '/todos/a',
      exists: true,
      data: { title: 'one', tags: { x: 1 } },
    });

    await db.firestore.set('/todos/a', { tags: { y: 2 } }, { merge: true });
    expect((await db.firestore.get('/todos/a')).data).toEqual({
      title: 'one',
      tags: { x: 1, y: 2 },
    });

    await db.firestore.set('/todos/a', { title: 'replaced' });
    expect((await db.firestore.get('/todos/a')).data).toEqual({ title: 'replaced' });

    await db.firestore.update('/todos/a', { done: true, 'meta.by': 'me' });
    expect((await db.firestore.get('/todos/a')).data).toEqual({
      title: 'replaced',
      done: true,
      meta: { by: 'me' },
    });
    await expect(db.firestore.update('/todos/missing', { x: 1 })).rejects.toMatchObject({
      code: 'not-found',
    });

    const added = await db.firestore.add('/todos', { title: 'two' });
    expect(added.path).toBe(`/todos/${added.id}`);
    expect(added.id).toMatch(/^[A-Za-z0-9]{20}$/);

    await db.firestore.delete('/todos/a');
    expect((await db.firestore.get('/todos/a')).exists).toBe(false);
  });

  it('serverTime becomes a Date, Dates stay Dates, and what you get back is a copy', async () => {
    const { db } = await mock();
    vi.setSystemTime(new Date('2026-05-01T10:00:00Z'));
    const when = new Date('2026-01-01T00:00:00Z');
    await db.firestore.set('/a/b', { at: db.serverTime, when, nested: { at: db.serverTime } });
    const got = (await db.firestore.get<{ at: Date; when: Date; nested: { at: Date } }>('/a/b'))
      .data!;
    expect(got.at).toEqual(new Date('2026-05-01T10:00:00Z'));
    expect(got.nested.at).toBeInstanceOf(Date);
    expect(got.when).toEqual(when);
    got.when.setFullYear(1999);
    expect((await db.firestore.get<{ when: Date }>('/a/b')).data!.when).toEqual(when);
  });

  it('refuses the paths the real fence refuses', async () => {
    const { db } = await mock();
    for (const bad of ['/a', '/a/b/c', '', '/a/../b', '/a/./b', '/a/__x__'])
      await expect(db.firestore.get(bad)).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(db.firestore.list('/a/b')).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(db.firestore.add('/a/b', {})).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(db.firestore.get(42 as never)).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(db.firestore.set('/a/b', 'nope' as never)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  describe('list', () => {
    async function seeded() {
      const { db } = await mock();
      const rows = [
        { id: 'a', n: 1, tag: 'x', tags: ['red'], at: new Date(1000) },
        { id: 'b', n: 2, tag: 'y', tags: ['red', 'blue'], at: new Date(3000) },
        { id: 'c', n: 3, tag: 'x', tags: [], at: new Date(2000) },
        { id: 'd', n: 4, tag: null, tags: ['green'] },
        { id: 'e', tag: 'x' },
      ];
      for (const { id, ...data } of rows) await db.firestore.set(`/items/${id}`, data);
      await db.firestore.set('/items/a/sub/z', { n: 99 });
      await db.firestore.set('/other/q', { n: 1 });
      const ids = async (q?: Parameters<typeof db.firestore.list>[1]) =>
        (await db.firestore.list('/items', q)).map((d) => d.id);
      return { db, ids };
    }

    it('lists only that collection (no sub-collections), by id', async () => {
      const { ids, db } = await seeded();
      expect(await ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
      expect((await db.firestore.list('/items/a/sub')).map((d) => d.path)).toEqual([
        '/items/a/sub/z',
      ]);
    });

    it('where: every operator', async () => {
      const { ids } = await seeded();
      expect(await ids({ where: [['tag', '==', 'x']] })).toEqual(['a', 'c', 'e']);
      expect(await ids({ where: [['tag', '!=', 'x']] })).toEqual(['b']); // null and missing never match !=
      expect(await ids({ where: [['n', '>', 2]] })).toEqual(['c', 'd']);
      expect(
        await ids({
          where: [
            ['n', '>=', 2],
            ['n', '<', 4],
          ],
        }),
      ).toEqual(['b', 'c']);
      expect(await ids({ where: [['n', '<=', 1]] })).toEqual(['a']);
      expect(await ids({ where: [['at', '>', new Date(1500)]] })).toEqual(['b', 'c']);
      expect(await ids({ where: [['tags', 'array-contains', 'red']] })).toEqual(['a', 'b']);
      expect(await ids({ where: [['tags', 'array-contains-any', ['blue', 'green']]] })).toEqual([
        'b',
        'd',
      ]);
      expect(await ids({ where: [['n', 'in', [1, 4]]] })).toEqual(['a', 'd']);
      expect(await ids({ where: [['n', 'not-in', [1, 4]]] })).toEqual(['b', 'c']);
      expect(await ids({ where: [['tag', '==', null]] })).toEqual(['d']);
    });

    it('orderBy leaves out documents without the field; limit and startAfter page through', async () => {
      const { ids } = await seeded();
      expect(await ids({ orderBy: ['n', 'desc'] })).toEqual(['d', 'c', 'b', 'a']);
      expect(await ids({ orderBy: ['at'] })).toEqual(['a', 'c', 'b']);
      expect(await ids({ orderBy: ['n'], limit: 2 })).toEqual(['a', 'b']);
      expect(await ids({ orderBy: ['n'], limit: 2, startAfter: 'b' })).toEqual(['c', 'd']);
      expect(await ids({ limit: 2, startAfter: 'b' })).toEqual(['c', 'd']);
      expect(await ids({ startAfter: 'bb' })).toEqual(['c', 'd', 'e']);
    });

    it('caps the limit and refuses a malformed query', async () => {
      const { db, ids } = await seeded();
      for (let i = 0; i < 120; i++)
        await db.firestore.set(`/many/d${String(i).padStart(3, '0')}`, { i });
      expect(await db.firestore.list('/many')).toHaveLength(100); // the default
      expect(await db.firestore.list('/many', { limit: 5000 })).toHaveLength(120); // capped at 500
      await expect(ids({ where: [['n', 'like' as never, 1]] })).rejects.toMatchObject({
        code: 'invalid-argument',
      });
      await expect(ids({ where: 'n > 1' as never })).rejects.toMatchObject({
        code: 'invalid-argument',
      });
      await expect(ids({ limit: 0 })).rejects.toMatchObject({ code: 'invalid-argument' });
      await expect(ids({ orderBy: ['n'], startAfter: 'nope' })).rejects.toMatchObject({
        code: 'not-found',
      });
    });
  });

  it('live callbacks: now, and again on every local write that touches them', async () => {
    const { db } = await mock();
    const docs: unknown[] = [];
    const lists: string[][] = [];
    const offDoc = db.firestore.onDoc('/items/a', (d) => docs.push(d.data));
    const offList = db.firestore.onList('/items', { where: [['n', '>', 0]], orderBy: ['n'] }, (l) =>
      lists.push(l.map((d) => d.id)),
    );
    await flush();
    expect(docs).toEqual([null]);
    expect(lists).toEqual([[]]);

    await db.firestore.set('/items/a', { n: 2 });
    await db.firestore.set('/items/b', { n: 1 });
    await db.firestore.set('/elsewhere/x', { n: 5 }); // touches neither
    await flush();
    expect(docs).toEqual([null, { n: 2 }]);
    expect(lists).toEqual([[], ['a'], ['b', 'a']]);

    offDoc();
    offList();
    await db.firestore.delete('/items/a');
    await flush();
    expect(docs).toHaveLength(2);
    expect(lists).toHaveLength(3);
  });

  it('a subscription on a bad path or query reports through onError', async () => {
    const { db } = await mock();
    const errors: string[] = [];
    db.firestore.onDoc(
      '/just-a-collection',
      () => {},
      (e) => errors.push(e.code),
    );
    db.firestore.onList(
      '/a',
      { where: [['n', 'nope' as never, 1]] },
      () => {},
      (e) => errors.push(e.code),
    );
    await flush();
    expect(errors).toEqual(['invalid-argument', 'invalid-argument']);
  });
});

describe('persistence', () => {
  it('survives a reload through localStorage, Dates included', async () => {
    const win = new FakeWindow();
    const first = await mock('', win);
    await first.db.firestore.set('/a/b', { at: new Date(5000), n: 1 });
    await first.db.rtdb.set('/count', 3);
    await first.db.kv.set('theme', 'dark');
    expect(win.localStorage.getItem(MOCK_STORAGE_KEY)).toBeTruthy();

    const again = await mock('', win);
    expect((await again.db.firestore.get('/a/b')).data).toEqual({ at: new Date(5000), n: 1 });
    expect(await again.db.rtdb.get('/count')).toBe(3);
    expect(await again.db.kv.get('theme')).toBe('dark');
  });

  it('works in memory when localStorage throws (a sandboxed frame) or holds junk', async () => {
    const win = new FakeWindow();
    win.storageThrows = true;
    const { db } = await mock('', win);
    await db.firestore.set('/a/b', { n: 1 });
    expect((await db.firestore.get('/a/b')).data).toEqual({ n: 1 });

    const junk = new FakeWindow();
    junk.localStorage.setItem(MOCK_STORAGE_KEY, '{not json');
    expect(await (await mock('', junk)).db.firestore.list('/a')).toEqual([]);
  });

  it('another tab writing (the storage event) reaches live callbacks here', async () => {
    const win = new FakeWindow();
    const { db } = await mock('', win);
    const seen: unknown[] = [];
    db.firestore.onDoc('/a/b', (d) => seen.push(d.data));
    await flush();
    // The other tab saved a new state under the same key.
    win.localStorage.setItem(
      MOCK_STORAGE_KEY,
      JSON.stringify({ fs: { '/a/b': { n: 7 } }, rtdb: null, kv: {} }),
    );
    win.dispatch('storage', { key: MOCK_STORAGE_KEY, data: null, source: null, origin: '' });
    await flush();
    expect(seen).toEqual([null, { n: 7 }]);
  });
});

describe('rtdb', () => {
  it('set / get / update / push / remove, with empty branches pruned', async () => {
    const { db } = await mock();
    expect(await db.rtdb.get('/')).toBeNull();
    await db.rtdb.set('/room/a', { name: 'A', seen: db.serverTime });
    expect(await db.rtdb.get('/room/a/name')).toBe('A');
    expect(typeof (await db.rtdb.get<{ seen: number }>('/room/a'))!.seen).toBe('number');

    await db.rtdb.update('/room', { 'a/name': 'A2', b: { name: 'B' } });
    expect(await db.rtdb.get('/room')).toMatchObject({ a: { name: 'A2' }, b: { name: 'B' } });

    const p1 = await db.rtdb.push('/log', 'first');
    const p2 = await db.rtdb.push('/log', 'second');
    expect(p1.path).toBe(`/log/${p1.key}`);
    expect(p1.key < p2.key).toBe(true); // push keys sort by time
    expect(Object.values((await db.rtdb.get<Record<string, string>>('/log'))!)).toEqual([
      'first',
      'second',
    ]);

    await db.rtdb.remove('/room/a');
    await db.rtdb.set('/room/b', null);
    expect(await db.rtdb.get('/room')).toBeNull();
    await expect(db.rtdb.get('/a.b')).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(db.rtdb.update('/room', { '../x': 1 })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('on(): the subtree, now and when anything above or below it changes', async () => {
    const { db } = await mock();
    const seen: unknown[] = [];
    const off = db.rtdb.on('/room/a', (v) => seen.push(v));
    await flush();
    await db.rtdb.set('/room/a/name', 'A'); // below
    await db.rtdb.set('/other', 1); // unrelated
    await db.rtdb.set('/room', { a: { name: 'Z' } }); // above
    await flush();
    expect(seen).toEqual([null, { name: 'A' }, { name: 'Z' }]);
    off();
    await db.rtdb.remove('/room');
    await flush();
    expect(seen).toHaveLength(3);
  });
});

describe('storage and kv', () => {
  it('upload / url / list / delete keep the blob for this page load', async () => {
    const { db } = await mock();
    const blob = new Blob(['hello'], { type: 'text/plain' });
    expect(await db.storage.upload('pics/a.txt', blob)).toEqual({ path: '/pics/a.txt', size: 5 });
    await db.storage.upload('/b.bin', new Blob(['x']), { contentType: 'application/x-thing' });
    expect(await db.storage.url('/pics/a.txt')).toMatch(/^blob:/);
    expect((await db.storage.list()).map((f) => [f.path, f.size, f.contentType])).toEqual([
      ['/b.bin', 1, 'application/x-thing'],
      ['/pics/a.txt', 5, 'text/plain'],
    ]);
    expect((await db.storage.list('/pics')).map((f) => f.path)).toEqual(['/pics/a.txt']);
    await db.storage.delete('/pics/a.txt');
    await expect(db.storage.url('/pics/a.txt')).rejects.toMatchObject({ code: 'not-found' });
    await expect(db.storage.upload('/', blob)).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(db.storage.upload('/x', 'text' as never)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(
      db.storage.upload('/big', { size: 26 * 1024 * 1024, type: '' } as Blob),
    ).rejects.toMatchObject({ code: 'quota' });
  });

  it('kv: one key, any value; a missing key is null', async () => {
    const { db } = await mock();
    expect(await db.kv.get('k')).toBeNull();
    await db.kv.set('k', { a: [1, 2] });
    expect(await db.kv.get('k')).toEqual({ a: [1, 2] });
    await db.kv.delete('k');
    expect(await db.kv.get('k')).toBeNull();
    await expect(db.kv.set('a/b', 1)).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(db.kv.set('', 1)).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('read-only viewer', () => {
  it('reads and kv work; every data write is permission-denied', async () => {
    const seed = new FakeWindow();
    await (await mock('', seed)).db.firestore.set('/a/b', { n: 1 });
    seed.location.search = '?role=viewer&readonly=1';
    const { db } = await mock('', seed);

    expect((await db.firestore.get('/a/b')).data).toEqual({ n: 1 });
    await db.kv.set('mine', 1); // per-viewer preferences are not the artifact's data
    const denied = { code: 'permission-denied' };
    await expect(db.firestore.set('/a/b', {})).rejects.toMatchObject(denied);
    await expect(db.firestore.update('/a/b', {})).rejects.toMatchObject(denied);
    await expect(db.firestore.delete('/a/b')).rejects.toMatchObject(denied);
    await expect(db.firestore.add('/a', {})).rejects.toMatchObject(denied);
    await expect(db.rtdb.set('/x', 1)).rejects.toMatchObject(denied);
    await expect(db.rtdb.push('/x', 1)).rejects.toMatchObject(denied);
    await expect(db.storage.upload('/f', new Blob(['x']))).rejects.toMatchObject(denied);
    expect((await db.firestore.get('/a/b')).data).toEqual({ n: 1 });
  });
});

describe('tickets (§K): the DEMO board', () => {
  it('boards, list with a query, get, create / update / comment, live lists', async () => {
    const { db } = await mock();
    const boards = await db.tickets.boards();
    expect(boards.map((b) => [b.key, b.access, b.canWrite])).toEqual([['DEMO', 'write', true]]);

    const mine = await db.tickets.list('DEMO', { assignee: 'me', orderBy: 'due' });
    expect(mine.map((t) => t.key)).toEqual(['DEMO-1', 'DEMO-2', 'DEMO-5']);
    expect((await db.tickets.list('DEMO', { stage: 'Doing' })).map((t) => t.key)).toEqual([
      'DEMO-2',
    ]);

    const seen: string[][] = [];
    const off = db.tickets.onList('DEMO', { stage: 'Done' }, (ts) =>
      seen.push(ts.map((t) => t.key)),
    );
    await flush();
    const { key } = await db.tickets.create('DEMO', {
      title: 'New one',
      priority: 'High',
      assignees: ['me'],
    });
    await db.tickets.update(key, { stage: 'Done', dueAt: '2026-10-10' });
    await db.tickets.comment(key, 'Done **now**');
    await flush();
    const t = await db.tickets.get(key);
    expect(t).toMatchObject({
      title: 'New one',
      stage: { name: 'Done' },
      priority: { name: 'High' },
      messages: 1,
    });
    expect(t!.dueAt).toBe(Date.parse('2026-10-10'));
    expect(seen[0]).toEqual(['DEMO-1']);
    expect(seen.at(-1)).toEqual(['DEMO-1', key]);
    off();
  });

  it('refuses what the real broker refuses: another board, unknown names, a read-only viewer', async () => {
    const { db } = await mock();
    await expect(db.tickets.list('ENG')).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(db.tickets.create('DEMO', { title: 'x', stage: 'Nope' })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(db.tickets.get('not a key')).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(await db.tickets.get('DEMO-999')).toBeNull();
    const ro = (await mock('?readonly=1')).db;
    await expect(ro.tickets.comment('DEMO-1', 'hi')).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect((await ro.tickets.list('DEMO')).length).toBeGreaterThan(0);
  });
});

describe('memory (memory.html §H): the demo memory', () => {
  it('list, tree, read, write text and a Blob, url, mkdir, remove', async () => {
    const { db } = await mock();
    const [m] = await db.memory.list();
    expect(m).toMatchObject({ id: 'demo-memory', access: 'write', files: 1 });
    expect((await db.memory.tree(m!.id)).map((n) => n.path)).toEqual(['docs', 'docs/README.md']);
    expect(await db.memory.read(m!.id, 'docs/README.md')).toContain('# Demo memory');

    await db.memory.write(m!.id, '/notes//today.md ', '# Today');
    await db.memory.write(m!.id, 'img/a.bin', new Blob([new Uint8Array([1, 2, 3])]));
    const tree = await db.memory.tree(m!.id);
    expect(tree.map((n) => [n.path, n.kind])).toEqual([
      ['docs', 'folder'],
      ['docs/README.md', 'file'],
      ['img', 'folder'],
      ['img/a.bin', 'file'],
      ['notes', 'folder'],
      ['notes/today.md', 'file'],
    ]);
    expect(tree.find((n) => n.path === 'img/a.bin')).toMatchObject({ size: 3, name: 'a.bin' });
    expect(await db.memory.read(m!.id, 'notes/today.md')).toBe('# Today');
    expect(await db.memory.url(m!.id, 'img/a.bin')).toMatch(/^blob:/);
    expect((await db.memory.tree(m!.id, 'notes')).map((n) => n.path)).toEqual(['notes/today.md']);

    await db.memory.mkdir(m!.id, 'empty/deeper');
    expect((await db.memory.tree(m!.id, 'empty')).map((n) => n.path)).toEqual(['empty/deeper']);
    await db.memory.remove(m!.id, 'notes');
    expect((await db.memory.tree(m!.id)).some((n) => n.path.startsWith('notes'))).toBe(false);
  });

  it('refuses what the real broker refuses: another memory, bad paths, a read-only viewer', async () => {
    const { db } = await mock();
    await expect(db.memory.tree('other')).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(db.memory.read('demo-memory', 'a/../b')).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(db.memory.read('demo-memory', 'docs')).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(db.memory.write('demo-memory', 'docs', 'x')).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    const ro = (await mock('?readonly=1')).db;
    expect((await ro.memory.list())[0]!.access).toBe('read');
    await expect(ro.memory.write('demo-memory', 'x.md', 'x')).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(await ro.memory.read('demo-memory', 'docs/README.md')).toContain('Demo');
  });
});
