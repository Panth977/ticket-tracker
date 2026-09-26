import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetPointer,
  forgetSynced,
  MAX_BOARDS,
  noteSynced,
  notePointer,
  POINTER_PREFIX,
  readPointer,
  readSynced,
  SYNC_MAX_AGE_MS,
  SYNC_VERSION,
} from './pointer';

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

let store: MemoryStorage;
beforeEach(() => {
  store = new MemoryStorage();
  (globalThis as { localStorage?: Storage }).localStorage = store;
});

describe('the boot pointer (§T)', () => {
  it('is per account and versioned in the key', () => {
    notePointer('u1', { board: { id: 'b1', key: 'ENG' } });
    notePointer('u2', { board: { id: 'b2', key: 'OPS' } });
    expect(readPointer('u1').board?.key).toBe('ENG');
    expect(readPointer('u2').board?.key).toBe('OPS');
    expect([...store.map.keys()].every((k) => k.startsWith(POINTER_PREFIX))).toBe(true);
  });

  it('merges: a new ticket does not forget the board, and vice versa', () => {
    notePointer('u1', { boards: [{ id: 'b1', key: 'ENG' }] });
    notePointer('u1', { board: { id: 'b1', key: 'ENG' }, viewId: 'v7' });
    notePointer('u1', { ticket: { key: 'ENG-42', boardKey: 'ENG' } });
    expect(readPointer('u1')).toMatchObject({
      boards: [{ id: 'b1', key: 'ENG' }],
      board: { id: 'b1', key: 'ENG', viewId: 'v7' },
      ticket: { key: 'ENG-42', boardKey: 'ENG' },
    });
  });

  it('drops the remembered view when the board changes', () => {
    notePointer('u1', { board: { id: 'b1', key: 'ENG' }, viewId: 'v7' });
    notePointer('u1', { board: { id: 'b2', key: 'OPS' } });
    expect(readPointer('u1').board).toEqual({ id: 'b2', key: 'OPS', viewId: null });
  });

  it('is a no-op when nothing changed', () => {
    notePointer('u1', { board: { id: 'b1', key: 'ENG' } });
    const written = store.getItem(POINTER_PREFIX + 'u1');
    notePointer('u1', { board: { id: 'b1', key: 'ENG' } });
    expect(store.getItem(POINTER_PREFIX + 'u1')).toBe(written);
  });

  it('is bounded: at most MAX_BOARDS boards', () => {
    const many = Array.from({ length: MAX_BOARDS + 20 }, (_, i) => ({ id: `b${i}`, key: `K${i}` }));
    notePointer('u1', { boards: many });
    expect(readPointer('u1').boards).toHaveLength(MAX_BOARDS);
  });

  it('never lets a bad shape crash a boot', () => {
    store.setItem(POINTER_PREFIX + 'u1', '{{{');
    expect(readPointer('u1')).toMatchObject({ boards: [], board: null, ticket: null });

    store.setItem(
      POINTER_PREFIX + 'u1',
      JSON.stringify({ boards: 'nope', board: 7, ticket: { key: 9 } }),
    );
    expect(readPointer('u1')).toMatchObject({ boards: [], board: null, ticket: null });

    // Rows missing half of themselves are skipped, not trusted.
    store.setItem(
      POINTER_PREFIX + 'u1',
      JSON.stringify({ boards: [{ id: 'b1' }, { id: 'b2', key: 'OPS' }] }),
    );
    expect(readPointer('u1').boards).toEqual([{ id: 'b2', key: 'OPS' }]);
  });

  it('forgets one account on sign-out, or all of them', () => {
    notePointer('u1', { board: { id: 'b1', key: 'ENG' } });
    notePointer('u2', { board: { id: 'b2', key: 'OPS' } });
    forgetPointer('u1');
    expect(readPointer('u1').board).toBeNull();
    expect(readPointer('u2').board?.key).toBe('OPS');
    forgetPointer();
    expect(readPointer('u2').board).toBeNull();
  });

  it('has nothing to say without a uid', () => {
    expect(readPointer(null)).toMatchObject({ boards: [], board: null, ticket: null });
    expect(() => notePointer(undefined, { board: { id: 'b', key: 'K' } })).not.toThrow();
    expect(store.map.size).toBe(0);
  });
});

describe('the delta watermark (§W)', () => {
  it('remembers how far each board is synced, per account', () => {
    noteSynced('u1', 'b1', 1000);
    noteSynced('u1', 'b2', 2000);
    noteSynced('u2', 'b1', 3000);
    expect(readSynced('u1', 'b1')).toBe(1000);
    expect(readSynced('u1', 'b2')).toBe(2000);
    expect(readSynced('u2', 'b1')).toBe(3000);
  });

  it('is 0 for a board nobody has synced — which means "ask for everything"', () => {
    expect(readSynced('u1', 'b1')).toBe(0);
    expect(readSynced(null, 'b1')).toBe(0);
    expect(readSynced('u1', null)).toBe(0);
  });

  it('expires by WHEN it was written, not by the watermark itself', () => {
    // A board nobody has touched for a year still has a good watermark…
    noteSynced('u1', 'b1', Date.now() - 365 * 24 * 3600_000);
    expect(readSynced('u1', 'b1')).toBeGreaterThan(0);
    // …but a pointer written long ago is not trusted (a hard delete may have
    // happened since, and no `updatedAt >` query can report one).
    expect(readSynced('u1', 'b1', Date.now() + SYNC_MAX_AGE_MS + 1)).toBe(0);
  });

  it('drops every watermark written by a different SYNC_VERSION', () => {
    noteSynced('u1', 'b1', 1000);
    const key = POINTER_PREFIX + 'u1';
    const raw = JSON.parse(store.getItem(key)!) as { synced: { v: number } };
    raw.synced.v = SYNC_VERSION + 1;
    store.setItem(key, JSON.stringify(raw));
    expect(readSynced('u1', 'b1')).toBe(0);
    // …and the rest of the pointer survives it.
    notePointer('u1', { board: { id: 'b1', key: 'ENG' } });
    expect(readPointer('u1').board?.key).toBe('ENG');
  });

  it('forgets one board, or all of them, so the next open is a full query', () => {
    noteSynced('u1', 'b1', 1000);
    noteSynced('u1', 'b2', 2000);
    forgetSynced('u1', 'b1');
    expect(readSynced('u1', 'b1')).toBe(0);
    expect(readSynced('u1', 'b2')).toBe(2000);
    forgetSynced('u1');
    expect(readSynced('u1', 'b2')).toBe(0);
  });

  it('does not touch localStorage when the same watermark is confirmed again', () => {
    noteSynced('u1', 'b1', 1000);
    const before = store.getItem(POINTER_PREFIX + 'u1');
    noteSynced('u1', 'b1', 1000);
    expect(store.getItem(POINTER_PREFIX + 'u1')).toBe(before);
  });

  it('keeps at most MAX_BOARDS of them, the most recently seen', () => {
    for (let i = 0; i < MAX_BOARDS + 5; i++) noteSynced('u1', `b${i}`, 1000 + i);
    const marks = readPointer('u1').synced.boards;
    expect(Object.keys(marks).length).toBe(MAX_BOARDS);
    expect(marks.b0).toBeUndefined();
    expect(marks[`b${MAX_BOARDS + 4}`]).toBeDefined();
  });

  it('goes with the rest of the pointer on sign-out', () => {
    noteSynced('u1', 'b1', 1000);
    forgetPointer('u1');
    expect(readSynced('u1', 'b1')).toBe(0);
  });
});
