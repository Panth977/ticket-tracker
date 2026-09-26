/**
 * §W — "a refresh pays only for what changed".
 *
 * The delta store with Firestore faked: what matters is WHICH query it opens
 * (the full one, or `updatedAt > watermark`), what it does with the rows it
 * gets back, and how many reads the meter attributes to it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

// ─── a fake Firestore: just enough of the query builder to inspect ──────────

interface FakeDoc {
  id: string;
  path: string;
  data: Record<string, unknown>;
}
interface FakeQuery {
  path: string;
  where: { f: string; op: string; v: unknown }[];
}
interface Listener {
  q: FakeQuery;
  next: (snap: unknown) => void;
  error: (e: unknown) => void;
  closed: boolean;
}

let listeners: Listener[] = [];
/** What getDocsFromCache answers with, per collection path. */
let cache = new Map<string, FakeDoc[]>();
let cacheThrows = false;

const snapshotOf = (docs: FakeDoc[], fromCache: boolean, removed: FakeDoc[] = []) => ({
  docs: docs.map((d) => ({ id: d.id, ref: { path: d.path }, data: () => d.data })),
  docChanges: () => [
    ...docs.map((d) => ({
      type: 'added' as const,
      doc: { id: d.id, ref: { path: d.path }, data: () => d.data },
    })),
    ...removed.map((d) => ({
      type: 'removed' as const,
      doc: { id: d.id, ref: { path: d.path }, data: () => d.data },
    })),
  ],
  metadata: { fromCache },
  empty: docs.length === 0,
});

vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, path: string): FakeQuery => ({ path, where: [] }),
  query: (base: FakeQuery, ...cs: { f: string; op: string; v: unknown }[]): FakeQuery => ({
    path: base.path,
    where: [...base.where, ...cs],
  }),
  where: (f: string, op: string, v: unknown) => ({ f, op, v }),
  getDocsFromCache: (q: FakeQuery) => {
    if (cacheThrows) throw new Error('IndexedDB unavailable');
    return Promise.resolve(snapshotOf(cache.get(q.path) ?? [], true));
  },
  onSnapshot: (
    q: FakeQuery,
    next: (snap: unknown) => void,
    error: (e: unknown) => void,
  ): (() => void) => {
    const l: Listener = { q, next, error, closed: false };
    listeners.push(l);
    return () => (l.closed = true);
  },
}));
vi.mock('$lib/firebase/client', () => ({ getDb: () => ({}) }));

const { deltaQueryStore } = await import('./delta');
const { registry } = await import('./live');
const { noteSynced, readSynced, forgetSynced } = await import('$lib/boot/pointer');
const { resetReads, reads } = await import('./reads');

class MemoryStorage implements Storage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

interface Row {
  state: string;
  updatedAt: number;
  title?: string;
}

const row = (id: string, updatedAt: number, state = 'active', title = id): FakeDoc => ({
  id,
  path: `boards/b1/tickets/${id}`,
  data: { state, updatedAt, title },
});

const spec = () => ({
  key: 'tickets:b1',
  path: 'boards/b1/tickets',
  uid: 'u1',
  scope: 'b1',
  cold: [['state', '==', 'active'] as [string, string, unknown]],
  stamp: 'updatedAt',
  keep: (t: Row) => t.state === 'active',
});

/** Subscribe, let the async seed settle, and hand back the live listener. */
async function open() {
  const store = deltaQueryStore<Row>(spec() as never);
  const seen: unknown[] = [];
  const off = store.subscribe((v) => seen.push(v));
  await Promise.resolve();
  await Promise.resolve();
  return { store, seen, off, listener: () => listeners[listeners.length - 1]! };
}

beforeEach(() => {
  listeners = [];
  cache = new Map();
  cacheThrows = false;
  registry.closeAll();
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
  resetReads();
});

describe('a cold open', () => {
  it('asks the server for the whole active set, and writes the watermark', async () => {
    const { listener, store, off } = await open();
    expect(listener().q.where).toEqual([{ f: 'state', op: '==', v: 'active' }]);
    listener().next(snapshotOf([row('t1', 100), row('t2', 300)], false));
    expect(get(store).data.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(readSynced('u1', 'b1')).toBe(300);
    off();
  });

  it('bills one read per document the server returned', async () => {
    const { listener, off } = await open();
    listener().next(snapshotOf([row('t1', 100), row('t2', 200), row('t3', 300)], false));
    expect(reads().total).toBe(3);
    off();
  });

  it('bills nothing for a snapshot Firestore served from its own cache', async () => {
    const { listener, off } = await open();
    listener().next(snapshotOf([row('t1', 100)], true));
    expect(reads().total).toBe(0);
    // …and a cached snapshot must not move the watermark.
    expect(readSynced('u1', 'b1')).toBe(0);
    off();
  });

  it('is what a board with no watermark and no cache gets', async () => {
    noteSynced('u1', 'b1', 500);
    // The watermark says 500, but the cache has nothing to seed from.
    const { listener, off } = await open();
    expect(listener().q.where).toEqual([{ f: 'state', op: '==', v: 'active' }]);
    off();
  });

  it('falls back to the full query when the cache cannot be read at all', async () => {
    noteSynced('u1', 'b1', 500);
    cache.set('boards/b1/tickets', [row('t1', 100)]);
    cacheThrows = true;
    const { listener, off } = await open();
    expect(listener().q.where).toEqual([{ f: 'state', op: '==', v: 'active' }]);
    off();
  });
});

describe('a warm open pays only for the delta', () => {
  beforeEach(() => {
    cache.set('boards/b1/tickets', [row('t1', 100), row('t2', 200)]);
    noteSynced('u1', 'b1', 200);
  });

  it('paints the cached rows before the server answers, for free', async () => {
    const { store, off } = await open();
    expect(get(store).data.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(get(store).loading).toBe(false);
    expect(get(store).fromCache).toBe(true);
    expect(reads().total).toBe(0);
    off();
  });

  it('asks only for what changed since the watermark', async () => {
    const { listener, off } = await open();
    expect(listener().q.where).toEqual([{ f: 'updatedAt', op: '>', v: 200 }]);
    off();
  });

  it('costs one read when nothing changed', async () => {
    const { listener, store, off } = await open();
    listener().next(snapshotOf([], false));
    // Firestore's minimum for a query that returns nothing — and the cards
    // are all still on screen.
    expect(reads().total).toBe(1);
    expect(get(store).data.map((t) => t.id)).toEqual(['t1', 't2']);
    off();
  });

  it('merges a changed ticket over the cached one, and adds a new one', async () => {
    const { listener, store, off } = await open();
    listener().next(snapshotOf([row('t2', 400, 'active', 'renamed'), row('t3', 500)], false));
    const data = get(store).data;
    expect(data.map((t) => t.id).sort()).toEqual(['t1', 't2', 't3']);
    expect(data.find((t) => t.id === 't2')!.title).toBe('renamed');
    expect(reads().total).toBe(2);
    expect(readSynced('u1', 'b1')).toBe(500);
    off();
  });

  it('drops a ticket that left the active set — which is why the delta is unfiltered', async () => {
    const { listener, store, off } = await open();
    listener().next(snapshotOf([row('t1', 600, 'archived')], false));
    expect(get(store).data.map((t) => t.id)).toEqual(['t2']);
    off();
  });

  it('drops a ticket the server reports as removed', async () => {
    const { listener, store, off } = await open();
    listener().next(snapshotOf([], false, [row('t1', 600)]));
    expect(get(store).data.map((t) => t.id)).toEqual(['t2']);
    off();
  });

  it('shows nothing rather than a stale board when the delta is refused', async () => {
    const { listener, store, off } = await open();
    listener().error(new Error('permission-denied'));
    const s = get(store);
    expect(s.error).toBeTruthy();
    expect(s.data).toEqual([]);
    off();
  });

  it('forgets the watermark when the delta is refused, so the next open is a full query', async () => {
    const { listener, off } = await open();
    listener().error(new Error('failed-precondition: the query requires an index'));
    expect(readSynced('u1', 'b1')).toBe(0);
    off();
    registry.closeAll();
    const again = await open();
    expect(again.listener().q.where).toEqual([{ f: 'state', op: '==', v: 'active' }]);
    again.off();
  });
});

describe('the watermark decides which half runs', () => {
  it('a forgotten board goes back to the full query', async () => {
    cache.set('boards/b1/tickets', [row('t1', 100)]);
    noteSynced('u1', 'b1', 100);
    forgetSynced('u1', 'b1');
    const { listener, off } = await open();
    expect(listener().q.where).toEqual([{ f: 'state', op: '==', v: 'active' }]);
    off();
  });

  it('closing the store closes its listener', async () => {
    const { listener, off } = await open();
    const l = listener();
    off();
    registry.closeAll();
    expect(l.closed).toBe(true);
  });
});
