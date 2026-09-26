import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { createRegistry } from './shared';

describe('createRegistry', () => {
  it('opens one listener per key and closes after the last subscriber (with linger)', () => {
    vi.useFakeTimers();
    const reg = createRegistry(100);
    const close = vi.fn();
    const open = vi.fn((set: (v: number) => void) => {
      set(1);
      return close;
    });
    const a = reg.get('k', 0, open);
    const b = reg.get('k', 0, open);
    const seen: number[] = [];
    const ua = a.subscribe((v) => seen.push(v));
    const ub = b.subscribe(() => {});
    expect(open).toHaveBeenCalledTimes(1);
    expect(get(a)).toBe(1);
    ua();
    ub();
    expect(close).not.toHaveBeenCalled();
    // resubscribe inside the linger window reuses the listener
    const uc = a.subscribe(() => {});
    vi.advanceTimersByTime(500);
    expect(close).not.toHaveBeenCalled();
    uc();
    vi.advanceTimersByTime(100);
    expect(close).toHaveBeenCalledTimes(1);
    expect(reg.openCount()).toBe(0);
    vi.useRealTimers();
  });
});
