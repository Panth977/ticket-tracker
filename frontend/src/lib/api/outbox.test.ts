import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@tm/shared';
import { _resetOverlays, applyOverlays, patchDoc } from '$lib/stores/overlay';
import { Outbox, MAX_RETRIES, type OutboxDeps, type OutboxEntry } from './outbox.svelte';
import { localOutboxStorage, memoryOutboxStorage, parseEntries } from './outboxStore';

let online = true;
let n = 0;

function make(over: Partial<OutboxDeps> = {}) {
  const deps = {
    send: vi.fn(async (): Promise<unknown> => ({ ok: true })),
    isOnline: () => online,
    storage: memoryOutboxStorage(),
    applyOptimistic: (spec: unknown) => {
      if (!spec) return () => {};
      if (typeof spec === 'function') return (spec as () => () => void)();
      const s = spec as { path: string; patch: Record<string, unknown> };
      return patchDoc(s.path, s.patch);
    },
    onFailure: vi.fn(),
    onResolved: vi.fn(),
    navigate: vi.fn(),
    newId: () => `id${++n}`,
    backoffMs: (a: number) => a * 100,
    settleMs: 50,
    ...over,
  } satisfies OutboxDeps;
  const ob = new Outbox(deps);
  ob.uid = 'u1';
  return { ob, deps };
}

beforeEach(() => {
  online = true;
  vi.useFakeTimers();
});
afterEach(() => {
  _resetOverlays();
  vi.useRealTimers();
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('outbox', () => {
  it('applies the optimistic change at once, sends in the background, then settles', async () => {
    const { ob, deps } = make();
    const { done } = ob.queue(
      'profileUpdate',
      { name: 'New' },
      { optimistic: { path: 'users/u1', patch: { name: 'New' } } },
    );
    expect(applyOverlays('users/u1', { name: 'Old' })).toEqual({ name: 'New' });
    expect(ob.entries).toHaveLength(1);
    await expect(done).resolves.toEqual({ ok: true });
    expect(deps.send).toHaveBeenCalledWith('profileUpdate', { name: 'New' }, expect.any(String));
    expect(ob.entries).toHaveLength(0);
    // The overlay outlives the response a moment (the listener catches up), then goes.
    expect(applyOverlays('users/u1', { name: 'Old' })).toEqual({ name: 'New' });
    await vi.advanceTimersByTimeAsync(60);
    expect(applyOverlays('users/u1', { name: 'Old' })).toEqual({ name: 'Old' });
  });

  it(`retries transient failures ${MAX_RETRIES} times with backoff, then fails and keeps the optimistic change`, async () => {
    const send = vi.fn(async () => {
      throw new AppError('unavailable', 'down');
    });
    const { ob, deps } = make({ send });
    ob.queue(
      'profileUpdate',
      { name: 'X' },
      { optimistic: { path: 'users/u1', patch: { name: 'X' } }, label: 'rename' },
    );
    await flush();
    expect(ob.entries[0]!.status).toBe('retrying');
    await vi.advanceTimersByTimeAsync(100); // retry 1
    await vi.advanceTimersByTimeAsync(200); // retry 2
    await vi.advanceTimersByTimeAsync(300); // retry 3
    expect(send).toHaveBeenCalledTimes(MAX_RETRIES + 1);
    expect(ob.entries[0]!.status).toBe('failed');
    expect(ob.failed).toHaveLength(1);
    expect(deps.onFailure).toHaveBeenCalledTimes(1);
    expect(applyOverlays('users/u1', { name: 'Old' })).toEqual({ name: 'X' });
  });

  it('fails at once on a refusal (no retry)', async () => {
    const send = vi.fn(async () => {
      throw new AppError('forbidden', 'nope');
    });
    const { ob } = make({ send });
    ob.queue('profileUpdate', { name: 'X' });
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(ob.entries[0]).toMatchObject({
      status: 'failed',
      error: 'nope',
      errorCode: 'forbidden',
    });
  });

  it('Cancel drops the entry and rolls back (both the overlay and the extra rollback)', async () => {
    const send = vi.fn(async () => {
      throw new AppError('conflict', 'stale');
    });
    const rollback = vi.fn();
    const { ob, deps } = make({ send });
    const { id, done } = ob.queue(
      'profileUpdate',
      { name: 'X' },
      { optimistic: { path: 'users/u1', patch: { name: 'X' } }, rollback },
    );
    await flush();
    expect(ob.cancel(id)).toBe(true);
    expect(rollback).toHaveBeenCalled();
    expect(applyOverlays('users/u1', { name: 'Old' })).toEqual({ name: 'Old' });
    expect(ob.entries).toHaveLength(0);
    expect(deps.onResolved).toHaveBeenCalled();
    await expect(done).resolves.toBeNull();
  });

  it('Retry resends a failed entry with the same clientId', async () => {
    let fail = true;
    const send = vi.fn(async () => {
      if (fail) throw new AppError('invalid', 'bad');
      return { ok: true };
    });
    const { ob } = make({ send });
    const { id, done } = ob.queue('profileUpdate', { name: 'X' });
    await flush();
    fail = false;
    ob.retry(id);
    await expect(done).resolves.toEqual({ ok: true });
    expect(send.mock.calls.map((c) => (c as unknown[])[2])).toEqual([id, id]);
  });

  it('waits while offline and resumes on online', async () => {
    online = false;
    const { ob, deps } = make();
    ob.queue('profileUpdate', { name: 'X' });
    await flush();
    expect(ob.entries[0]!.status).toBe('offline');
    expect(deps.send).not.toHaveBeenCalled();
    online = true;
    ob.resume();
    await flush();
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(ob.entries).toHaveLength(0);
  });

  it('losing the connection mid-send waits instead of burning a retry', async () => {
    const send = vi.fn(async () => {
      online = false;
      throw new AppError('unavailable');
    });
    const { ob } = make({ send });
    ob.queue('profileUpdate', { name: 'X' });
    await flush();
    expect(ob.entries[0]).toMatchObject({ status: 'offline', attempts: 0 });
  });

  it('onError can handle a refusal itself (dropped + rolled back, no failure)', async () => {
    const send = vi.fn(async () => {
      throw new AppError('unprocessable', 'requires', { missing: ['f1'] });
    });
    const { ob, deps } = make({ send });
    const onError = vi.fn(() => true);
    ob.queue(
      'profileUpdate',
      { name: 'X' },
      { optimistic: { path: 'users/u1', patch: { name: 'X' } }, onError },
    );
    await flush();
    expect(onError).toHaveBeenCalled();
    expect(ob.entries).toHaveLength(0);
    expect(deps.onFailure).not.toHaveBeenCalled();
    expect(applyOverlays('users/u1', { name: 'Old' })).toEqual({ name: 'Old' });
  });

  it('prepare() can rewrite the input before sending (uploads finished)', async () => {
    const { ob, deps } = make();
    ob.queue('profileUpdate', { name: 'X' }, { prepare: async () => ({ name: 'Y' }) });
    await flush();
    expect(deps.send).toHaveBeenCalledWith('profileUpdate', { name: 'Y' }, expect.any(String));
  });

  it('linger keeps a sent entry (✓) for a while', async () => {
    const { ob } = make();
    ob.queue('profileUpdate', { name: 'X' }, { linger: 1000, kind: 'message', ticketId: 't1' });
    await flush();
    expect(ob.entries[0]!.status).toBe('sent');
    expect(ob.hasUnsent('t1')).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ob.entries).toHaveLength(0);
  });

  it('tracks tickets with unsent messages', async () => {
    online = false;
    const { ob } = make();
    ob.queue('profileUpdate', { name: 'X' }, { kind: 'message', ticketId: 't1' });
    await flush();
    expect([...ob.unsentTickets]).toEqual(['t1']);
    expect(ob.hasUnsent('t1')).toBe(true);
    expect(ob.messages('t1')).toHaveLength(1);
  });

  it('persists entries with a draft and resends them for the same user on the next visit', async () => {
    online = false;
    const storage = memoryOutboxStorage();
    const first = make({ storage }).ob;
    first.queue(
      'profileUpdate',
      { name: 'X' },
      { draft: { text: 'hi' }, kind: 'message', ticketId: 't1' },
    );
    first.queue('profileUpdate', { name: 'no draft' });
    await flush();
    expect(await storage.load('u1')).toHaveLength(1);
    expect(await storage.load('u2')).toHaveLength(0);

    online = true;
    const { ob, deps } = make({ storage });
    ob.uid = null;
    await ob.setUser('u1');
    await flush();
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(await storage.load('u1')).toHaveLength(0);
  });

  it('open() navigates and lets the destination take() the entry', async () => {
    const send = vi.fn(async () => {
      throw new AppError('invalid', 'bad');
    });
    const { ob, deps } = make({ send });
    const { id } = ob.queue(
      'profileUpdate',
      { name: 'X' },
      { kind: 'ticketCreate', openTo: '/b/ENG', draft: { title: 'X' } },
    );
    await flush();
    ob.open(id);
    expect(deps.navigate).toHaveBeenCalledWith('/b/ENG', expect.objectContaining({ id }));
    expect(ob.take('message')).toBeNull();
    expect(ob.take('ticketCreate')?.draft).toEqual({ title: 'X' });
    expect(ob.opening).toBeNull();
  });

  it('a send in flight cannot be cancelled', async () => {
    let release!: () => void;
    const send = vi.fn(() => new Promise<unknown>((r) => (release = () => r({ ok: true }))));
    const { ob } = make({ send });
    const { id } = ob.queue('profileUpdate', { name: 'X' });
    await flush();
    expect(ob.cancel(id)).toBe(false);
    release();
    await flush();
    expect(ob.entries).toHaveLength(0);
  });
});

describe('outbox storage', () => {
  const e = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
    id: 'a',
    uid: 'u1',
    command: 'messagePost',
    input: {},
    kind: 'message',
    label: 'send',
    status: 'queued',
    attempts: 0,
    createdAt: Date.now(),
    persist: true,
    ...over,
  });

  it('parseEntries drops other users, junk and stale entries', () => {
    const now = Date.now();
    const out = parseEntries(
      [e(), e({ id: 'b', uid: 'u2' }), null, { id: 1 }, e({ id: 'c', createdAt: now - 8 * 864e5 })],
      'u1',
      now,
    );
    expect(out.map((x) => x.id)).toEqual(['a']);
  });

  it('localStorage fallback keeps entries per user', async () => {
    const m = new Map<string, string>();
    const ls = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    } as Storage;
    const s = localOutboxStorage(ls);
    await s.save(e());
    await s.save(e({ id: 'b', uid: 'u2' }));
    expect((await s.load('u1')).map((x) => x.id)).toEqual(['a']);
    await s.remove('u1', 'a');
    expect(await s.load('u1')).toEqual([]);
    expect(m.has('tm.outbox.u1')).toBe(false);
  });
});
