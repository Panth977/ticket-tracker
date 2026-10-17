/**
 * The VM build's line to its server (live.ts) and its session (auth.ts),
 * against a fake WebSocket and a fake /identity — the races a real network
 * hits that a local one never does:
 *
 *   - a socket that closes BEFORE it opens (a sign-in does that) must not
 *     leave the requests and listeners queued for it hanging forever;
 *   - restoring a saved session must not recurse into itself (it once wiped
 *     the session, which signed every other tab out).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = ((e?: unknown) => void) | null;

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: Record<string, unknown>[] = [];
  onopen: Handler = null;
  onmessage: Handler = null;
  onclose: Handler = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error('send while not open');
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
    queueMicrotask(() => this.onclose?.());
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  /** The server answers the last auth frame (ok, or refused). */
  answerAuth(ok = true) {
    const m = this.sent.filter((x) => x.op === 'auth').at(-1)!;
    const frame = ok
      ? { id: m.id, ok: true, result: { uid: m.token ? 'u1' : null } }
      : { id: m.id, ok: false, error: { code: 'unauthenticated', message: 'expired' } };
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** The server answers every request it got. */
  answerAll(result: unknown = { ok: 1 }) {
    for (const m of this.sent)
      if (m.op !== 'auth' && m.id && !m.lid) this.onmessage?.({ data: JSON.stringify({ id: m.id, ok: true, result }) });
  }
}

const store = new Map<string, string>();
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  FakeSocket.all = [];
  store.clear();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'https:', host: 'tt.example.com', hash: '', pathname: '/', search: '' });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('vm/live: the socket', () => {
  it('a socket closed before it opened: its queued request and listener go out on the next one', async () => {
    const live = await import('./live');
    let got: unknown;
    const frames: unknown[] = [];
    void live.request({ op: 'get', path: 'users/u1' }).then((r) => (got = r));
    live.subscribe({ op: 'listen', path: 'boards/b1' }, (f) => frames.push(f));
    await flush();
    const first = FakeSocket.all[0]!;
    expect(first.readyState).toBe(FakeSocket.CONNECTING);
    first.close(); // e.g. the page signed in while the socket was still connecting
    await flush();
    await vi.advanceTimersByTimeAsync(1000); // the reconnect backoff
    const second = FakeSocket.all[1]!;
    expect(second).toBeDefined();
    second.open();
    await flush();
    second.answerAuth();
    await flush();
    const ops = second.sent.map((m) => m.op);
    expect(ops).toEqual(['auth', 'listen', 'get']);
    second.answerAll({ exists: true });
    await flush();
    expect(got).toEqual({ exists: true });
  });

  it('a new token while connecting does not kill the socket; it goes with the auth frame', async () => {
    const live = await import('./live');
    void live.request({ op: 'get', path: 'users/u1' });
    await flush();
    const s = FakeSocket.all[0]!;
    live.setLiveToken('tok-1'); // signed in while connecting
    expect(s.readyState).toBe(FakeSocket.CONNECTING);
    s.open();
    await flush();
    expect(s.sent[0]).toMatchObject({ op: 'auth', token: 'tok-1' });
    expect(FakeSocket.all).toHaveLength(1);
  });
});

describe('vm/live: never signed out by a stale token', () => {
  it('a reconnect asks auth for the token NOW, and holds listeners until the server accepts it', async () => {
    const live = await import('./live');
    live.setLiveToken('tok-expired'); // what the page held when the laptop slept
    const source = vi.fn(async () => 'tok-fresh');
    live.setLiveTokenSource(source);
    live.subscribe({ op: 'listen', path: 'users/u1' }, () => {});
    await flush();
    const s = FakeSocket.all[0]!;
    s.open();
    await flush();
    expect(s.sent.map((m) => m.op)).toEqual(['auth']);
    expect(s.sent[0]).toMatchObject({ token: 'tok-fresh' });
    s.answerAuth();
    await flush();
    expect(s.sent.map((m) => m.op)).toEqual(['auth', 'listen']);
  });

  it('a refused token: refresh it and retry; listeners never go out unauthenticated', async () => {
    const live = await import('./live');
    const source = vi.fn(async (force: boolean) => (force ? 'tok-new' : 'tok-old'));
    live.setLiveTokenSource(source);
    live.subscribe({ op: 'listen', path: 'users/u1' }, () => {});
    await flush();
    const s = FakeSocket.all[0]!;
    s.open();
    await flush();
    s.answerAuth(false);
    await flush();
    expect(source).toHaveBeenLastCalledWith(true);
    expect(s.sent.map((m) => [m.op, m.token])).toEqual([
      ['auth', 'tok-old'],
      ['auth', 'tok-new'],
    ]);
    s.answerAuth();
    await flush();
    expect(s.sent.map((m) => m.op)).toEqual(['auth', 'auth', 'listen']);
  });

  it('refused twice: drop the socket and come back later, still without sending listeners', async () => {
    const live = await import('./live');
    live.setLiveTokenSource(async () => 'tok-bad');
    live.subscribe({ op: 'listen', path: 'users/u1' }, () => {});
    await flush();
    const s = FakeSocket.all[0]!;
    s.open();
    await flush();
    s.answerAuth(false);
    await flush();
    s.answerAuth(false);
    await flush();
    expect(s.sent.map((m) => m.op)).toEqual(['auth', 'auth']);
    expect(s.readyState).toBe(FakeSocket.CLOSED);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.all).toHaveLength(2);
  });
});

describe('vm/auth: the session', () => {
  const session = (n: number) => ({
    idToken: `id-${n}`,
    refreshToken: 'rt',
    expiresIn: 3600,
    user: { uid: 'u1', email: 'a@b.c', emailVerified: true, metadata: {}, providerData: [] },
  });

  it('restoring a saved session refreshes once, keeps it, and never recurses', async () => {
    store.set('tm.vm.session', JSON.stringify({ refreshToken: 'rt', user: session(0).user }));
    const fetch = vi.fn(async () => new Response(JSON.stringify(session(1)), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('window', { addEventListener: () => {} });
    const auth = await import('./auth');
    const a = auth.getAuth();
    await a.authStateReady();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a.currentUser?.uid).toBe('u1');
    expect(JSON.parse(store.get('tm.vm.session')!)).toMatchObject({ refreshToken: 'rt', idToken: 'id-1' });
    expect(await a.currentUser!.getIdToken()).toBe('id-1');
  });

  it('a saved ID token that is still good needs no round trip at all', async () => {
    store.set(
      'tm.vm.session',
      JSON.stringify({ refreshToken: 'rt', user: session(0).user, idToken: 'id-saved', expiresAt: Date.now() + 3600_000 }),
    );
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('window', { addEventListener: () => {} });
    const auth = await import('./auth');
    await auth.getAuth().authStateReady();
    expect(fetch).not.toHaveBeenCalled();
    expect(await auth.getAuth().currentUser!.getIdToken()).toBe('id-saved');
  });
});
