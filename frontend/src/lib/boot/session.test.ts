import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetSession,
  readSession,
  rememberSession,
  SESSION_KEY,
  SESSION_MAX_AGE_MS,
} from './session';

/** vitest runs in node here: localStorage is ours to provide. */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
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

describe('the remembered session (§T)', () => {
  it('round-trips the principal a reload needs to paint', () => {
    rememberSession({ uid: 'u1', displayName: 'Ada', photoURL: 'https://x/a.png', theme: 'dark' });
    expect(readSession()).toMatchObject({
      uid: 'u1',
      displayName: 'Ada',
      photoURL: 'https://x/a.png',
      theme: 'dark',
    });
  });

  it('stores nothing but those four facts — never a token', () => {
    rememberSession({ uid: 'u1', displayName: 'Ada', photoURL: null, theme: 'system' });
    const raw = JSON.parse(store.getItem(SESSION_KEY)!) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['at', 'displayName', 'photoURL', 'theme', 'uid']);
    // Even if a caller hands one over, the closed shape drops it.
    rememberSession({ uid: 'u1', theme: 'light', idToken: 'secret' } as never);
    expect(JSON.stringify(readSession())).not.toContain('secret');
  });

  it('does not rewrite an unchanged record', () => {
    const first = rememberSession({
      uid: 'u1',
      displayName: 'Ada',
      photoURL: null,
      theme: 'light',
    });
    const written = store.getItem(SESSION_KEY);
    const again = rememberSession({
      uid: 'u1',
      displayName: 'Ada',
      photoURL: null,
      theme: 'light',
    });
    expect(store.getItem(SESSION_KEY)).toBe(written);
    expect(again?.at).toBe(first?.at);
  });

  it('forgets on sign-out', () => {
    rememberSession({ uid: 'u1', theme: 'dark' });
    forgetSession();
    expect(readSession()).toBeNull();
  });

  it('never lets a bad memory stop a boot', () => {
    store.setItem(SESSION_KEY, 'not json at all');
    expect(readSession()).toBeNull();
    expect(store.getItem(SESSION_KEY)).toBeNull(); // and it is cleaned up

    store.setItem(SESSION_KEY, JSON.stringify({ uid: 42, theme: { nope: true } }));
    expect(readSession()).toBeNull();

    store.setItem(SESSION_KEY, JSON.stringify({ uid: 'u1', theme: 'chartreuse' }));
    expect(readSession()).toMatchObject({ uid: 'u1', theme: 'system' });
  });

  it('drops a memory older than the maximum age', () => {
    const now = Date.now();
    rememberSession({ uid: 'u1', theme: 'dark' }, now - SESSION_MAX_AGE_MS - 1);
    expect(readSession(now)).toBeNull();
  });

  it('works when localStorage throws (private mode)', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
    expect(() => rememberSession({ uid: 'u1', theme: 'dark' })).not.toThrow();
    expect(readSession()).toBeNull();
    expect(() => forgetSession()).not.toThrow();
  });
});
