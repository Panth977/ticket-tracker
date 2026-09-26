/**
 * PHASE 16 (docs/plan/agents.html §X, last two bullets) — WHAT IT COSTS.
 *
 * Two things are worth proving about a cost panel, and they are the two
 * things a wrong panel gets wrong:
 *
 *   1. THE ARITHMETIC. The free Firestore quota is DAILY and does not roll
 *      over, so a month's bill is the sum of each day's overflow — not the
 *      month's total minus one allowance. Two 60k-read days cost 2 × 10k, not
 *      max(0, 120k − 50k). Get that wrong and the panel says ₹0 on the exact
 *      months it should be shouting.
 *   2. THE CACHE. §X says looking costs almost nothing: the answer is kept in
 *      `_config/usage` for an hour, so the second open makes NO Monitoring
 *      query at all — and when Monitoring is unreachable, yesterday's numbers
 *      plus a sentence beat an empty page.
 *
 * The Monitoring API itself is a fake (`setUsageProbe`): a probe is also how
 * the reader is told it is not really running under the emulators, so the real
 * parsing, bucketing, arithmetic and caching all run here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FREE_DAILY,
  FREE_MONTHLY,
  USAGE_CACHE_DOC,
  USAGE_CACHE_TTL_MS,
  emptyUsageDay,
  estimate,
  pricesFor,
  type UsageDay,
} from '@tm/shared/api/usage';
import { db } from '../../src/runtime/firebase.js';
import {
  dayKey,
  monthDays,
  nextReset,
  readUsage,
  resetUsageProbe,
  setUsageProbe,
  startOfDay,
} from '../../src/platform/usage.js';
import { createUser, request, setupEmulators, type TestUser } from '../harness/index.js';

setupEmulators();

/* ─────────────────────────── the arithmetic ─────────────────────────── */

const prices = pricesFor('asia-south1');

const day = (d: string, patch: Partial<UsageDay> = {}): UsageDay => ({
  ...emptyUsageDay(d),
  ...patch,
});
const line = (e: ReturnType<typeof estimate>, id: string) => e.lines.find((l) => l.id === id)!;

describe('the arithmetic (shared/src/api/usage.ts)', () => {
  it('bills the DAILY free quota per day, never against the month total', () => {
    // Two days of 60k reads. Per day: 10k over. Against a month total it would
    // look like 120k − 50k = 70k, which is the bug this test exists for.
    const e = estimate(
      [
        day('2026-09-01', { firestoreReads: 60_000 }),
        day('2026-09-02', { firestoreReads: 60_000 }),
      ],
      prices,
    );
    const reads = line(e, 'firestoreReads');
    expect(reads.used).toBe(120_000);
    expect(reads.billable).toBe(20_000);
    expect(reads.free).toBe(2 * FREE_DAILY.firestoreReads);
    // 20k reads at $0.03/100k × ₹88 = ₹0.528 → ₹0.53
    expect(reads.inr).toBe(0.53);
  });

  it('charges nothing while every day sits inside the allowance — the §W target', () => {
    const quiet = ['2026-09-01', '2026-09-02', '2026-09-03'].map((d) =>
      day(d, { firestoreReads: 5_000, firestoreWrites: 2_000, runRequests: 400, vcpuSeconds: 120 }),
    );
    const e = estimate(quiet, prices);
    expect(e.totalInr).toBe(0);
    // The rows are still there: "0 of 50,000 used" is the useful line.
    expect(line(e, 'firestoreReads').used).toBe(15_000);
    expect(line(e, 'firestoreReads').billable).toBe(0);
  });

  it('bills a MONTHLY free quota against the month, not per day', () => {
    // 30 days × 10k vCPU-s = 300k, of which 180k is free → 120k billable.
    const days = Array.from({ length: 30 }, (_, i) =>
      day(`2026-09-${String(i + 1).padStart(2, '0')}`, { vcpuSeconds: 10_000 }),
    );
    const cpu = line(estimate(days, prices), 'vcpuSeconds');
    expect(cpu.used).toBe(300_000);
    expect(cpu.free).toBe(FREE_MONTHLY.vcpuSeconds);
    expect(cpu.billable).toBe(120_000);
    // 120k vCPU-s × $0.000024 × ₹88 = ₹253.44
    expect(cpu.inr).toBe(253.44);
  });

  it('rolls up by service and the total is exactly the sum of the lines', () => {
    const e = estimate(
      [
        day('2026-09-01', {
          firestoreReads: 250_000,
          firestoreWrites: 120_000,
          vcpuSeconds: 200_000,
        }),
        day('2026-09-02', { firestoreReads: 250_000, rtdbDownloadBytes: 40 * 1024 ** 3 }),
      ],
      prices,
    );
    const sum = e.lines.reduce((a, l) => a + l.inr, 0);
    expect(e.totalInr).toBeCloseTo(sum, 2);
    expect(e.services.map((s) => s.id)).toContain('firestore');
    // Sorted biggest first, so the panel's first row is where the money went.
    for (let i = 1; i < e.services.length; i++)
      expect(e.services[i - 1]!.inr).toBeGreaterThanOrEqual(e.services[i]!.inr);
    expect(e.services.reduce((a, s) => a + s.inr, 0)).toBeCloseTo(e.totalInr, 2);
  });

  it('keeps one daily value per day, so a sparkline costs nothing extra', () => {
    const e = estimate(
      [day('2026-09-01', { firestoreReads: 10 }), day('2026-09-02', { firestoreReads: 20 })],
      prices,
    );
    expect(line(e, 'firestoreReads').series).toEqual([10, 20]);
  });

  it('is dated, region-aware and quotes its rate', () => {
    expect(prices.region).toBe('asia-south1');
    expect(prices.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pricesFor('nowhere-1').region).toBe('asia-south1'); // unknown → the project's region
    expect(line(estimate([day('2026-09-01')], prices), 'firestoreReads').rate).toContain(
      'per 100k',
    );
  });
});

/* ─────────────────────── the quota day is a PACIFIC day ─────────────────────── */

describe('quota days', () => {
  it('starts at midnight US Pacific, not IST', () => {
    // 2026-09-26T05:00Z is 10:30 IST on the 26th but still 22:00 on the 25th
    // in Los Angeles — and the free allowance that matters is the 25th's.
    const t = Date.parse('2026-09-26T05:00:00Z');
    expect(dayKey(t)).toBe('2026-09-25');
    expect(startOfDay('2026-09-25')).toBe(Date.parse('2026-09-25T07:00:00Z')); // PDT = UTC−7
  });

  it('survives the daylight-saving change', () => {
    expect(startOfDay('2026-11-02')).toBe(Date.parse('2026-11-02T08:00:00Z')); // PST = UTC−8
    expect(startOfDay('2026-11-01')).toBe(Date.parse('2026-11-01T07:00:00Z')); // the day it changes
  });

  it('lists the month so far and knows when the allowance resets', () => {
    const t = Date.parse('2026-09-26T20:00:00Z'); // 13:00 in Los Angeles
    const days = monthDays(t);
    expect(days[0]).toBe('2026-09-01');
    expect(days.at(-1)).toBe('2026-09-26');
    expect(days).toHaveLength(26);
    expect(nextReset(t)).toBe(Date.parse('2026-09-27T07:00:00Z'));
  });
});

/* ─────────────────────── the reader and its hourly cache ─────────────────────── */

/** Hourly Monitoring points, as the API shapes them. */
function points(from: number, hours: number, value: number) {
  return Array.from({ length: hours }, (_, i) => ({
    interval: {
      startTime: new Date(from + i * 3_600_000).toISOString(),
      endTime: new Date(from + (i + 1) * 3_600_000).toISOString(),
    },
    value: { int64Value: String(value) },
  }));
}

interface FakeMonitoring {
  calls: number;
  /** Set to 403 to act as a project that has not been granted the role. */
  status: number;
  /** metric.type → the points that metric answers with. */
  series: Map<string, ReturnType<typeof points>>;
}

function fakeMonitoring(): FakeMonitoring {
  const fake: FakeMonitoring = { calls: 0, status: 200, series: new Map() };
  setUsageProbe({
    token: async () => 'fake-token',
    fetch: (async (input: RequestInfo | URL) => {
      fake.calls++;
      if (fake.status !== 200)
        return new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), {
          status: fake.status,
          headers: { 'content-type': 'application/json' },
        });
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const type = /metric\.type="([^"]+)"/.exec(url.searchParams.get('filter') ?? '')?.[1] ?? '';
      const ps = fake.series.get(type);
      return new Response(JSON.stringify(ps ? { timeSeries: [{ points: ps }] } : {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  });
  return fake;
}

const READ_COUNT = 'firestore.googleapis.com/document/read_count';

/** A fixed "now": 2026-09-26 13:00 in Los Angeles. */
const NOW = Date.parse('2026-09-26T20:00:00Z');

async function clearCache() {
  await db().doc(USAGE_CACHE_DOC).delete();
}

describe('the reader and its hourly cache', () => {
  beforeEach(clearCache);
  afterEach(async () => {
    resetUsageProbe();
    await clearCache();
  });

  it('buckets hourly Monitoring points into quota days', async () => {
    const fake = fakeMonitoring();
    // 24 hours of 1,000 reads/hour starting at the 25th's Pacific midnight, so
    // the whole 24k belongs to the 25th and nothing to the 26th.
    fake.series.set(READ_COUNT, points(startOfDay('2026-09-25'), 24, 1_000));

    const res = await readUsage({ now: NOW });
    expect(res.status).toBe('ok');
    expect(res.month).toBe('2026-09');
    expect(res.days).toHaveLength(26);

    const reads = res.estimate.lines.find((l) => l.id === 'firestoreReads')!;
    expect(reads.used).toBe(24_000);
    expect(reads.series[24]).toBe(24_000); // the 25th (index 24 of 1..26)
    expect(reads.series[25]).toBe(0); // the 26th, so far
    expect(reads.billable).toBe(0); // 24k < 50k: a free day
    // And TODAY's number — the one that decides ₹0 or ₹600 — is the 26th's.
    expect(res.today.day).toBe('2026-09-26');
    expect(res.today.reads).toBe(0);
    expect(res.today.readsFree).toBe(FREE_DAILY.firestoreReads);
    expect(res.today.resetsAt).toBe(Date.parse('2026-09-27T07:00:00Z'));
  });

  it('answers the second open from Firestore — no Monitoring query at all', async () => {
    const fake = fakeMonitoring();
    fake.series.set(READ_COUNT, points(startOfDay('2026-09-26'), 3, 30_000));

    const first = await readUsage({ now: NOW });
    expect(first.cached).toBe(false);
    const queries = fake.calls;
    expect(queries).toBeGreaterThan(0);

    const second = await readUsage({ now: NOW + 59 * 60_000 });
    expect(fake.calls).toBe(queries); // the whole point of §X's "cached for an hour"
    expect(second.cached).toBe(true);
    expect(second.stale).toBe(false);
    expect(second.today.reads).toBe(90_000);
    // 90k reads on one day: 40k over the free 50k, so this one is NOT free.
    expect(second.estimate.lines.find((l) => l.id === 'firestoreReads')!.billable).toBe(40_000);
    expect(second.estimate.totalInr).toBeGreaterThan(0);
  });

  it('asks again once the hour is up, and ?refresh=1 asks immediately', async () => {
    const fake = fakeMonitoring();
    fake.series.set(READ_COUNT, points(startOfDay('2026-09-26'), 1, 10));
    await readUsage({ now: NOW });
    const after = fake.calls;

    await readUsage({ now: NOW, refresh: true });
    expect(fake.calls).toBeGreaterThan(after);

    const forced = fake.calls;
    await readUsage({ now: NOW + USAGE_CACHE_TTL_MS + 1 });
    expect(fake.calls).toBeGreaterThan(forced);
  });

  it("says 'not granted yet' with the command, instead of failing", async () => {
    const fake = fakeMonitoring();
    fake.status = 403;

    const res = await readUsage({ now: NOW });
    expect(res.status).toBe('notGranted');
    expect(res.message).toContain('roles/monitoring.viewer');
    expect(res.message).toContain('infra/monitoring-role.md');
    // Still a whole, drawable answer: every line at zero rather than an error page.
    expect(res.estimate.totalInr).toBe(0);
    expect(res.estimate.lines.length).toBeGreaterThan(0);
    expect(res.days).toHaveLength(26);
  });

  it('serves the cached numbers when a refresh fails, and says they are stale', async () => {
    const fake = fakeMonitoring();
    fake.series.set(READ_COUNT, points(startOfDay('2026-09-26'), 2, 1_000));
    await readUsage({ now: NOW });

    fake.status = 403;
    const res = await readUsage({ now: NOW + USAGE_CACHE_TTL_MS + 1 });
    expect(res.stale).toBe(true);
    expect(res.cached).toBe(true);
    expect(res.status).toBe('notGranted');
    expect(res.today.reads).toBe(2_000); // yesterday's truth, not zeros
  });

  it('ignores a cache document written by an older shape', async () => {
    await db()
      .doc(USAGE_CACHE_DOC)
      .set({ at: NOW, res: { nonsense: true } });
    const fake = fakeMonitoring();
    fake.series.set(READ_COUNT, points(startOfDay('2026-09-26'), 1, 7));
    const res = await readUsage({ now: NOW });
    expect(res.status).toBe('ok');
    expect(res.today.reads).toBe(7);
  });
});

/* ─────────────────────────── the door ─────────────────────────── */

describe('GET /api/usage', () => {
  const previousAdmin = process.env.TM_ADMIN_EMAIL;
  let admin: TestUser;
  let other: TestUser;

  beforeEach(async () => {
    admin = await createUser({ name: 'Panth' });
    other = await createUser({ name: 'Someone else' });
    process.env.TM_ADMIN_EMAIL = admin.email;
    await clearCache();
  });

  afterEach(async () => {
    if (previousAdmin === undefined) delete process.env.TM_ADMIN_EMAIL;
    else process.env.TM_ADMIN_EMAIL = previousAdmin;
    resetUsageProbe();
    await clearCache();
  });

  const get = (user: TestUser | null) =>
    request('/api/usage', {
      method: 'GET',
      ...(user ? { headers: { authorization: `Bearer ${user.token}` } } : {}),
    });

  it('answers the admin', async () => {
    const fake = fakeMonitoring();
    fake.series.set(READ_COUNT, points(startOfDay(dayKey(Date.now())), 1, 5));
    const res = await get(admin);
    expect(res.status).toBe(200);
    expect((res.body as { estimate?: unknown }).estimate).toBeTruthy();
  });

  it('refuses everyone else — it is the project bill, not a board', async () => {
    const res = await get(other);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'forbidden' });
  });

  it('refuses without a token', async () => {
    expect((await get(null)).status).toBe(401);
  });
});
