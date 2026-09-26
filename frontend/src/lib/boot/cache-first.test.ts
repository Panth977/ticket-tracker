/**
 * §T — "loading means nothing to show yet, never no server answer yet."
 *
 * The two halves of that promise, tested without Firebase: the registry's
 * memory of what a key last held (../stores/shared) and the rule live.ts gives
 * it for handing that memory back (../stores/live › reviveState).
 */
import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createRegistry } from '../stores/shared';
import { reviveState, type QueryState } from '../stores/live';

interface Row {
  id: string;
}

const RESOLVED: QueryState<Row> = {
  loading: false,
  error: null,
  data: [{ id: 'a' }],
  fromCache: false,
};
const LOADING: QueryState<Row> = { loading: true, error: null, data: [], fromCache: false };

describe('reviveState', () => {
  it('hands a resolved state back as local data, not as a loading state', () => {
    expect(reviveState(RESOLVED)).toEqual({
      loading: false,
      error: null,
      data: [{ id: 'a' }],
      fromCache: true,
    });
  });

  it('refuses a state that never resolved, or that ended in an error', () => {
    expect(reviveState(LOADING)).toBeNull();
    expect(reviveState({ ...RESOLVED, error: new Error('denied') })).toBeNull();
  });

  it('keeps an empty-but-answered result: "no rows" is something to show', () => {
    const empty: QueryState<Row> = { loading: false, error: null, data: [], fromCache: false };
    expect(reviveState(empty)).toEqual({ ...empty, fromCache: true });
  });
});

describe('the shared registry remembers what a key last held (§T)', () => {
  const opener =
    (value: QueryState<Row>, close = () => {}) =>
    (set: (v: QueryState<Row>) => void) => {
      // A real listener answers later; the point is what the subscriber saw first.
      queueMicrotask(() => set(value));
      return close;
    };

  it('a resubscribed key starts from its last value, with loading false', () => {
    const reg = createRegistry(0); // no linger: the listener closes with its last subscriber
    let push: (v: QueryState<Row>) => void = () => {};
    const open = (set: (v: QueryState<Row>) => void) => {
      push = set;
      return () => {};
    };

    const first: QueryState<Row>[] = [];
    const off = reg
      .get<QueryState<Row>>('q:boards', LOADING, open, { revive: reviveState })
      .subscribe((v) => first.push(v));
    expect(first[0]).toEqual(LOADING); // nothing known yet: a skeleton is honest
    push(RESOLVED);
    off();

    const seen: QueryState<Row>[] = [];
    reg
      .get<QueryState<Row>>('q:boards', LOADING, open, { revive: reviveState })
      .subscribe((v) => seen.push(v))();
    expect(seen[0]).toEqual({ loading: false, error: null, data: [{ id: 'a' }], fromCache: true });
  });

  it('does not remember a key that never resolved', () => {
    const reg = createRegistry(0);
    const open = () => () => {};
    reg
      .get<QueryState<Row>>('q:slow', LOADING, open, { revive: reviveState })
      .subscribe(() => {})();
    const seen: QueryState<Row>[] = [];
    reg
      .get<QueryState<Row>>('q:slow', LOADING, open, { revive: reviveState })
      .subscribe((v) => seen.push(v))();
    expect(seen[0]).toEqual(LOADING);
  });

  it('still opens exactly one listener per key, and still lingers', () => {
    vi.useFakeTimers();
    const reg = createRegistry(100);
    const close = vi.fn();
    const open = vi.fn(opener(RESOLVED, close));
    const s = reg.get<QueryState<Row>>('q:one', LOADING, open, { revive: reviveState });
    const offA = s.subscribe(() => {});
    const offB = s.subscribe(() => {});
    expect(open).toHaveBeenCalledTimes(1);
    offA();
    offB();
    vi.advanceTimersByTime(50);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(close).toHaveBeenCalledTimes(1);
    expect(reg.openCount()).toBe(0);
    vi.useRealTimers();
  });

  it('is bounded, and sign-out forgets everything', () => {
    const reg = createRegistry(0, 2); // keep at most two keys' last values
    for (const k of ['a', 'b', 'c']) {
      const open = (set: (v: QueryState<Row>) => void) => {
        set(RESOLVED);
        return () => {};
      };
      reg.get<QueryState<Row>>(k, LOADING, open, { revive: reviveState }).subscribe(() => {})();
    }
    expect(reg.rememberedCount()).toBe(2);
    reg.closeAll();
    expect(reg.rememberedCount()).toBe(0);
  });

  it('the remembered value is the one the listener last set', () => {
    const reg = createRegistry(0);
    let push: (v: QueryState<Row>) => void = () => {};
    const open = (set: (v: QueryState<Row>) => void) => {
      push = set;
      return () => {};
    };
    const off = reg
      .get<QueryState<Row>>('k', LOADING, open, { revive: reviveState })
      .subscribe(() => {});
    push({ loading: false, error: null, data: [{ id: 'server' }], fromCache: false });
    off();
    const seen: QueryState<Row>[] = [];
    reg
      .get<QueryState<Row>>('k', LOADING, open, { revive: reviveState })
      .subscribe((v) => seen.push(v))();
    expect(seen[0]?.data).toEqual([{ id: 'server' }]);
    expect(seen[0]?.fromCache).toBe(true);
    expect(get(reg.get<QueryState<Row>>('k', LOADING, open, { revive: reviveState })).loading).toBe(
      false,
    );
  });
});
