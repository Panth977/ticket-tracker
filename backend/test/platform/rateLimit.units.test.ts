/**
 * The limiter counts in the instance first (§W): the shared RTDB counter is
 * consulted every RECONCILE_EVERY calls, and every call once a bucket is
 * running warm — never twice per request for a loop that is nowhere near its
 * limit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transaction = vi.fn();
vi.mock('../../src/runtime/firebase.js', () => ({
  rtdbAdmin: () => ({ ref: () => ({ transaction }) }),
}));

const { RECONCILE_EVERY, forgetLocalRateCounts, rateLimit } =
  await import('../../src/platform/rateLimit.js');

/** The shared counter agrees with whatever we add. */
function sharedCounter() {
  let n = 0;
  transaction.mockImplementation(async (update: (cur: number | null) => number | undefined) => {
    const next = update(n);
    if (next === undefined) return { committed: false, snapshot: { val: () => n } };
    n = next;
    return { committed: true, snapshot: { val: () => n } };
  });
  return () => n;
}

describe('rate limiting is local first', () => {
  beforeEach(() => {
    process.env.TM_RATE_LIMITS = '1'; // §X: off in this app, so the tests ask for it
    transaction.mockReset();
    forgetLocalRateCounts();
  });

  it('does not touch the shared counter on every call', async () => {
    sharedCounter();
    const now = 1_700_000_000_000;
    for (let i = 0; i < RECONCILE_EVERY; i++) await rateLimit('key:a', { perDay: 10_000 }, now);
    // One reconcile for the batch, not one per call.
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('checks every call once the bucket is warm, and still refuses at the limit', async () => {
    sharedCounter();
    const now = 1_700_000_000_000;
    await rateLimit('key:b', { perMin: 4 }, now);
    await rateLimit('key:b', { perMin: 4 }, now);
    await rateLimit('key:b', { perMin: 4 }, now);
    await rateLimit('key:b', { perMin: 4 }, now);
    await expect(rateLimit('key:b', { perMin: 4 }, now)).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('a new window starts from zero', async () => {
    sharedCounter();
    const now = 1_700_000_000_000;
    for (let i = 0; i < 3; i++) await rateLimit('key:c', { perMin: 3 }, now);
    await expect(rateLimit('key:c', { perMin: 3 }, now)).rejects.toMatchObject({
      code: 'rate_limited',
    });
    await expect(rateLimit('key:c', { perMin: 3 }, now + 60_000)).resolves.toBeUndefined();
  });

  it('fails open when the shared counter errors', async () => {
    transaction.mockRejectedValue(new Error('rtdb down'));
    const now = 1_700_000_000_000;
    // Warm enough to reconcile, and the reconcile blows up: the call still goes through.
    await expect(rateLimit('key:d', { perMin: 2 }, now)).resolves.toBeUndefined();
  });
});

describe('rate limiting is off in a private app (§X)', () => {
  it('does not count, and never refuses, unless TM_RATE_LIMITS=1', async () => {
    delete process.env.TM_RATE_LIMITS;
    transaction.mockReset();
    forgetLocalRateCounts();
    for (let i = 0; i < 50; i++) await rateLimit('key:off', { perMin: 1 }, 1_700_000_000_000);
    expect(transaction).not.toHaveBeenCalled();
  });
});
