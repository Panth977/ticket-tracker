/**
 * WHAT IT COSTS, SERVER SIDE (docs/plan/agents.html §X) — the Cloud Monitoring
 * reader behind GET /api/usage.
 *
 * WHAT IT DOES. Once an hour it asks Cloud Monitoring for nine counters,
 * hour by hour, for the current billing month; buckets them into QUOTA DAYS
 * (Pacific midnight — see shared/src/api/usage.ts); runs the arithmetic in
 * @tm/shared over them; and keeps the answer in `_config/usage`. Opening the
 * panel after that costs ONE document read, which is the whole point: a cost
 * panel that costs money to look at would be a joke.
 *
 * HOW IT AUTHENTICATES. With the function's own service account, from the
 * metadata server — no key file, no extra dependency, nothing to rotate:
 *
 *   GET http://metadata.google.internal/computeMetadata/v1/
 *       instance/service-accounts/default/token     (Metadata-Flavor: Google)
 *
 * That account needs `roles/monitoring.viewer`, which is NOT granted by
 * default. infra/monitoring-role.md has the one command. Until it is granted
 * this module answers `status: 'notGranted'` with that command in the message
 * — a normal 200 the panel can explain, never an error page.
 *
 * WHY HOURLY BUCKETS AND NOT DAILY ONES. Monitoring's alignment grid is
 * anchored on the query interval, so asking for 86400-second buckets gives
 * 24-hour windows that start wherever the interval does — not at Pacific
 * midnight, which is what the free daily quota resets on. Hour buckets are
 * hour-aligned whatever the anchor (both ends of the interval are on the
 * hour), and every time-zone offset in play is a whole number of hours, so
 * summing hours into quota days is exact. The cost is ~740 points per metric,
 * which is one page and one free API call.
 *
 * WHAT IT NEVER DOES: write a billing export, create a sink, or do anything
 * else that itself costs money. Monitoring reads are free at this volume.
 */
import {
  FREE_DAILY,
  QUOTA_TIME_ZONE,
  USAGE_CACHE_DOC,
  USAGE_CACHE_TTL_MS,
  UsageCacheSchema,
  emptyUsageDay,
  estimate,
  pricesFor,
  type UsageCounter,
  type UsageDay,
  type UsageRes,
  type UsageStatus,
} from '@tm/shared/api/usage';
import { db, isEmulated, projectId } from '../runtime/firebase.js';
import { region } from '../runtime/deploy.js';

/* ────────────────────────── quota-day arithmetic ────────────────────────── */

const HOUR_MS = 3_600_000;

/** 'YYYY-MM-DD' for an instant, in the quota time zone. */
export function dayKey(ms: number, tz: string = QUOTA_TIME_ZONE): string {
  // en-CA formats as YYYY-MM-DD, which is the whole reason it is used here.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/** How far ahead of UTC the zone's wall clock is, at this instant. */
function offsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const at = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(
    at('year'),
    at('month') - 1,
    at('day'),
    at('hour') % 24,
    at('minute'),
    at('second'),
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a quota day begins. Two passes because the offset itself
 * depends on which side of a daylight-saving change the answer lands on.
 */
export function startOfDay(key: string, tz: string = QUOTA_TIME_ZONE): number {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const midnightUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  const first = midnightUtc - offsetMs(midnightUtc, tz);
  return midnightUtc - offsetMs(first, tz);
}

/** Every quota day of the current billing month so far, oldest first. */
export function monthDays(now: number, tz: string = QUOTA_TIME_ZONE): string[] {
  const today = dayKey(now, tz);
  const month = today.slice(0, 7);
  const dom = Number(today.slice(8));
  return Array.from({ length: dom }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

/** The instant today's free allowance resets (the next Pacific midnight). */
export function nextReset(now: number, tz: string = QUOTA_TIME_ZONE): number {
  // +36h lands squarely inside tomorrow whatever the DST shift, then round down.
  return startOfDay(dayKey(startOfDay(dayKey(now, tz), tz) + 36 * HOUR_MS, tz), tz);
}

/* ────────────────────────── the metrics ────────────────────────── */

interface MetricSpec {
  counter: UsageCounter;
  type: string;
  /** Multiply the raw value by this to reach the counter's unit. */
  scale?: number;
}

/**
 * The nine counters §X asks for. A metric that returns no time series — the
 * service has never been used, or Google renamed it — contributes zeros and
 * the panel simply shows a row of nothing, which is exactly what an absent
 * metric means for the bill.
 */
const METRICS: readonly MetricSpec[] = [
  { counter: 'firestoreReads', type: 'firestore.googleapis.com/document/read_count' },
  { counter: 'firestoreWrites', type: 'firestore.googleapis.com/document/write_count' },
  { counter: 'firestoreDeletes', type: 'firestore.googleapis.com/document/delete_count' },
  // A 2nd-gen function IS a Cloud Run service, so its metrics live under run.*.
  { counter: 'runRequests', type: 'run.googleapis.com/request_count' },
  { counter: 'vcpuSeconds', type: 'run.googleapis.com/container/cpu/allocation_time' },
  { counter: 'gibSeconds', type: 'run.googleapis.com/container/memory/allocation_time' },
  {
    counter: 'rtdbDownloadBytes',
    type: 'firebasedatabase.googleapis.com/network/sent_bytes_count',
  },
  { counter: 'storageEgressBytes', type: 'storage.googleapis.com/network/sent_bytes_count' },
  {
    counter: 'hostingEgressBytes',
    type: 'firebasehosting.googleapis.com/network/sent_bytes_count',
  },
];

/* ────────────────────────── the probe (swappable for tests) ────────────────────────── */

export interface UsageProbe {
  fetch: typeof fetch;
  /** An OAuth access token for the function's own service account, or null. */
  token(): Promise<string | null>;
}

let probe: UsageProbe | null = null;

/**
 * Point the reader at a fake Monitoring (tests). Installing a probe also turns
 * off the "there is nothing to measure under the emulators" short-circuit, so
 * a test can exercise the real parsing, arithmetic and cache.
 */
export function setUsageProbe(p: UsageProbe | null): void {
  probe = p;
  tokenMemo = null;
}
export const resetUsageProbe = (): void => setUsageProbe(null);

const METADATA_HOST = () => process.env.GCE_METADATA_HOST?.trim() || 'metadata.google.internal';

/** The instance's own token, remembered until a minute before it expires. */
let tokenMemo: { token: string; until: number } | null = null;

async function metadataToken(now = Date.now()): Promise<string | null> {
  if (tokenMemo && now < tokenMemo.until) return tokenMemo.token;
  try {
    const res = await fetch(
      `http://${METADATA_HOST()}/computeMetadata/v1/instance/service-accounts/default/token`,
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3_000) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) return null;
    tokenMemo = {
      token: body.access_token,
      until: now + Math.max(0, (body.expires_in ?? 600) - 60) * 1000,
    };
    return tokenMemo.token;
  } catch {
    // No metadata server: running on a laptop, in a test, or in the emulators.
    return null;
  }
}

const activeProbe = (): UsageProbe => probe ?? { fetch, token: metadataToken };

/* ────────────────────────── Cloud Monitoring ────────────────────────── */

/** A refusal that has a sentence for the admin instead of a stack trace. */
class UsageUnavailable extends Error {
  constructor(
    readonly status: Exclude<UsageStatus, 'ok'>,
    message: string,
  ) {
    super(message);
  }
}

const grantMessage = (): string =>
  `The functions' service account cannot read Cloud Monitoring yet. Grant it once:\n` +
  `  gcloud projects add-iam-policy-binding ${projectId()} \\\n` +
  `    --member="serviceAccount:${projectId()}@appspot.gserviceaccount.com" \\\n` +
  `    --role="roles/monitoring.viewer"\n` +
  `See infra/monitoring-role.md. Nothing else about the app is affected.`;

/** ISO 8601 with seconds — what the Monitoring API wants. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * One metric, hour by hour, summed across every series (every function
 * revision, every bucket, every database) into one number per hour.
 */
async function readMetric(
  spec: MetricSpec,
  startMs: number,
  endMs: number,
): Promise<Map<number, number>> {
  const { fetch: f, token } = activeProbe();
  const access = await token();
  if (!access)
    throw new UsageUnavailable(
      'unavailable',
      'No service-account token here — usage is only measured on the deployed project.',
    );

  const out = new Map<number, number>();
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({
      filter: `metric.type="${spec.type}"`,
      'interval.startTime': iso(startMs),
      'interval.endTime': iso(endMs),
      'aggregation.alignmentPeriod': '3600s',
      'aggregation.perSeriesAligner': 'ALIGN_SUM',
      'aggregation.crossSeriesReducer': 'REDUCE_SUM',
      view: 'FULL',
    });
    if (pageToken) q.set('pageToken', pageToken);

    let res: Response;
    try {
      res = await f(
        `https://monitoring.googleapis.com/v3/projects/${projectId()}/timeSeries?${q}`,
        {
          headers: { authorization: `Bearer ${access}`, accept: 'application/json' },
          signal: AbortSignal.timeout(20_000),
        },
      );
    } catch {
      throw new UsageUnavailable('unavailable', 'Could not reach the Cloud Monitoring API.');
    }
    if (res.status === 401 || res.status === 403)
      throw new UsageUnavailable('notGranted', grantMessage());
    if (!res.ok) {
      // A metric type this project has never produced is a 400, not an outage:
      // treat it as "nothing to report" rather than failing the whole panel.
      if (res.status === 400) return out;
      throw new UsageUnavailable('unavailable', `Cloud Monitoring answered ${res.status}.`);
    }

    const body = (await res.json()) as {
      timeSeries?: { points?: MonitoringPoint[] }[];
      nextPageToken?: string;
    };
    for (const series of body.timeSeries ?? [])
      for (const p of series.points ?? []) {
        // Bucket by the point's START: an hour's traffic belongs to the hour it
        // happened in, and Monitoring's end time is the following boundary.
        const start = Date.parse(p.interval?.startTime ?? p.interval?.endTime ?? '');
        if (!Number.isFinite(start)) continue;
        const hour = Math.floor(start / HOUR_MS) * HOUR_MS;
        out.set(hour, (out.get(hour) ?? 0) + pointValue(p) * (spec.scale ?? 1));
      }
    pageToken = body.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return out;
}

interface MonitoringPoint {
  interval?: { startTime?: string; endTime?: string };
  value?: {
    int64Value?: string | number;
    doubleValue?: number;
    distributionValue?: { count?: string | number };
  };
}

function pointValue(p: MonitoringPoint): number {
  const v = p.value ?? {};
  if (typeof v.doubleValue === 'number') return v.doubleValue;
  if (v.int64Value != null) return Number(v.int64Value);
  if (v.distributionValue?.count != null) return Number(v.distributionValue.count);
  return 0;
}

/** Every counter, for every quota day of the month so far. */
async function measure(now: number): Promise<{ days: string[]; rows: UsageDay[]; cutoff: number }> {
  const days = monthDays(now);
  const startMs = startOfDay(days[0]!);
  // Stop at the last whole hour: a partial bucket would be attributed wrongly
  // and Monitoring will not align a grid to an arbitrary instant anyway.
  const cutoff = Math.floor(now / HOUR_MS) * HOUR_MS;
  const rows = days.map(emptyUsageDay);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  if (cutoff <= startMs) return { days, rows, cutoff: now };

  // Nine small queries, once an hour, all free. Sequential on purpose: this is
  // never on anyone's hot path and a burst buys nothing.
  for (const spec of METRICS) {
    const hours = await readMetric(spec, startMs, cutoff);
    for (const [hour, value] of hours) {
      const row = byDay.get(dayKey(hour));
      if (row) row[spec.counter] += value;
    }
  }
  return { days, rows, cutoff };
}

/* ────────────────────────── the answer ────────────────────────── */

function build(
  now: number,
  rows: UsageDay[],
  days: string[],
  status: UsageStatus,
  message: string | null,
  measuredAt: number,
): UsageRes {
  const prices = pricesFor(process.env.TM_USAGE_REGION?.trim() || region());
  const today = rows[rows.length - 1] ?? emptyUsageDay(days[days.length - 1] ?? dayKey(now));
  return {
    status,
    message,
    month: (days[0] ?? dayKey(now)).slice(0, 7),
    days,
    today: {
      day: today.day,
      reads: today.firestoreReads,
      writes: today.firestoreWrites,
      readsFree: FREE_DAILY.firestoreReads,
      writesFree: FREE_DAILY.firestoreWrites,
      resetsAt: nextReset(now),
    },
    estimate: estimate(rows, prices),
    prices: { region: prices.region, asOf: prices.asOf, usdToInr: prices.usdToInr },
    measuredAt,
    freshUntil: now + USAGE_CACHE_TTL_MS,
    stale: false,
    cached: false,
  };
}

/** Every line at zero, plus the sentence that says why. */
function emptyAnswer(now: number, status: UsageStatus, message: string): UsageRes {
  const days = monthDays(now);
  return build(now, days.map(emptyUsageDay), days, status, message, now);
}

/* ────────────────────────── the hourly cache ────────────────────────── */

async function readCache(): Promise<{ at: number; res: UsageRes } | null> {
  try {
    const snap = await db().doc(USAGE_CACHE_DOC).get();
    if (!snap.exists) return null;
    const parsed = UsageCacheSchema.safeParse(snap.data());
    // A cache written by an older shape is not an error: throw it away and
    // measure again. Nothing here is a source of truth.
    return parsed.success ? parsed.data : null;
  } catch (e) {
    console.warn('[usage] could not read the cached answer', e);
    return null;
  }
}

async function writeCache(at: number, res: UsageRes): Promise<void> {
  await db()
    .doc(USAGE_CACHE_DOC)
    .set({ at, res })
    .catch((e: unknown) => console.warn('[usage] could not cache the answer', e));
}

/**
 * THE PANEL'S ANSWER (§X). One Firestore read on the happy path; a Monitoring
 * query at most once an hour.
 *
 * When a refresh fails but a cached answer exists, the cached numbers are
 * served with `stale: true` and the reason — old numbers plus an explanation
 * beat an empty page.
 */
export async function readUsage(opts: { now?: number; refresh?: boolean } = {}): Promise<UsageRes> {
  const now = opts.now ?? Date.now();
  const cached = await readCache();
  if (!opts.refresh && cached && now - cached.at < USAGE_CACHE_TTL_MS) {
    return { ...cached.res, cached: true, freshUntil: cached.at + USAGE_CACHE_TTL_MS };
  }

  // Nothing to measure offline: the demo project has no Monitoring data and
  // no metadata server. Say so plainly instead of timing out on every open.
  if (isEmulated() && !probe) {
    return emptyAnswer(
      now,
      'local',
      'Running against the emulators — there is no billing data to read. Deploy to see real numbers.',
    );
  }

  try {
    const { days, rows, cutoff } = await measure(now);
    const res = build(now, rows, days, 'ok', null, cutoff);
    await writeCache(now, res);
    return res;
  } catch (e) {
    const status: Exclude<UsageStatus, 'ok'> =
      e instanceof UsageUnavailable ? e.status : 'unavailable';
    const message =
      e instanceof UsageUnavailable ? e.message : 'Could not read usage from Cloud Monitoring.';
    if (!(e instanceof UsageUnavailable)) console.error('[usage] measuring failed', e);
    if (cached) return { ...cached.res, cached: true, stale: true, status, message };
    return emptyAnswer(now, status, message);
  }
}
