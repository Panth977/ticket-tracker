/**
 * Fixed-window rate limits in the Realtime Database (platform/db.json rateLimits):
 *
 *   rate/{bucket}/{window} = count        bucket 'key:{keyId}' | 'intake:{slug}' | 'mcp:{grantId}' …
 *                                         window 'm{minute}' | 'h{hour}' | 'd{day}'
 *
 * RTDB BECAUSE A COUNTER HERE IS ONE CHEAP TRANSACTION, not a contended
 * Firestore document. Each window is checked and incremented in its own
 * transaction; a request over ANY limit is refused with 429 + Retry-After
 * (seconds until that window rolls over). Old windows are deleted by
 * housekeeping.
 *
 * OFF BY DEFAULT (§X). TaskManager is one person's private tracker: the only
 * callers are its owner, the accounts they allow in, and their own agents.
 * A limiter there does not protect anything — it just stops an orchestrator
 * mid-run (one did) and pays two cross-region round trips per call to do it.
 * Set TM_RATE_LIMITS=1 to turn it back on; the code below is kept whole for
 * the day this is not a private app.
 *
 * FAILS OPEN: if the database itself errors, the request goes through (and
 * the error is logged) — a limiter outage must not become an API outage.
 *
 * COUNTED IN THE INSTANCE FIRST (§W). Two RTDB transactions per request, from
 * a function in one region to a database in another, were ~100 ms of every
 * 250 ms call — and the platform bills CPU for the wait. So each instance
 * counts its own window in memory and only reconciles with the shared counter
 * every RECONCILE_EVERY calls, or as soon as the local count is close enough
 * to the limit to matter. With a handful of instances the shared number can
 * lag by at most (instances × RECONCILE_EVERY) calls inside a window; the
 * limits exist to stop a runaway loop, not to meter to the request, and the
 * moment a bucket approaches its limit every call is checked again.
 */
import { errors, rtdb } from '@tm/shared';
import { rtdbAdmin } from '../runtime/firebase.js';

export interface Limits {
  perMin?: number;
  perHour?: number;
  perDay?: number;
}

const WINDOWS = [
  { key: 'perMin', prefix: 'm', ms: 60_000 },
  { key: 'perHour', prefix: 'h', ms: 3_600_000 },
  { key: 'perDay', prefix: 'd', ms: 86_400_000 },
] as const;

/** How many calls an instance may count locally before it reconciles. */
export const RECONCILE_EVERY = 20;
/** Above this share of the limit, every call goes to the shared counter again. */
const STRICT_FROM = 0.5;

interface Local {
  idx: number;
  /** Counted since the last reconcile. */
  pending: number;
  /** What the shared counter said at the last reconcile, plus what we have counted since. */
  seen: number;
}
const local = new Map<string, Local>();
/** Bounded: one entry per bucket+window; buckets are per key, and old windows are dropped below. */
const LOCAL_MAX = 500;

/** Tests. */
export function forgetLocalRateCounts(): void {
  local.clear();
}

class Over extends Error {
  constructor(readonly retryAfter: number) {
    super('over');
  }
}

/** Whether limits apply at all (TM_RATE_LIMITS=1 turns them on). */
export const rateLimitsOn = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.TM_RATE_LIMITS === '1';

/** Count one request against `bucket`; throws rate_limited when any window is full. */
export async function rateLimit(bucket: string, limits: Limits, now: number): Promise<void> {
  if (!rateLimitsOn()) return;
  const checks = WINDOWS.filter((w) => typeof limits[w.key] === 'number').map(async (w) => {
    const limit = limits[w.key]!;
    const idx = Math.floor(now / w.ms);
    const lkey = `${bucket}|${w.prefix}`;
    const l = local.get(lkey);
    const cur: Local = l && l.idx === idx ? l : { idx, pending: 0, seen: 0 };
    cur.pending += 1;
    cur.seen += 1;
    if (local.size >= LOCAL_MAX) local.clear();
    local.set(lkey, cur);
    // Already over what we know of the window: refuse without asking anyone.
    if (cur.seen > limit) throw new Over(Math.max(1, Math.ceil(((idx + 1) * w.ms - now) / 1000)));
    // Otherwise the shared counter is consulted only now and then, and always
    // once the bucket is running warm.
    const strict = cur.seen >= limit * STRICT_FROM;
    if (!strict && cur.pending < RECONCILE_EVERY) return;
    const add = cur.pending;
    cur.pending = 0;
    const ref = rtdbAdmin().ref(rtdb.rate(bucket, `${w.prefix}${idx}`));
    const res = await ref.transaction(
      (shared: number | null) => {
        const n = typeof shared === 'number' ? shared : 0;
        return n >= limit ? undefined : n + add; // undefined = abort
      },
      undefined,
      false,
    );
    // The shared count is the truth: adopt it, so every instance converges.
    const shared = res.snapshot?.val();
    if (typeof shared === 'number') cur.seen = Math.max(cur.seen, shared);
    if (!res.committed) throw new Over(Math.max(1, Math.ceil(((idx + 1) * w.ms - now) / 1000)));
  });
  const results = await Promise.allSettled(checks);
  let retryAfter = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') continue;
    if (r.reason instanceof Over) retryAfter = Math.max(retryAfter, r.reason.retryAfter);
    else console.error(`[rateLimit] ${bucket}: limiter unavailable, failing open`, r.reason);
  }
  if (retryAfter > 0) {
    throw errors.rate_limited('Rate limit exceeded — slow down', { retryAfter });
  }
}
