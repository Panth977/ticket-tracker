/**
 * WHAT IT COSTS, IN THE APP (docs/plan/agents.html §X, last bullet) — the
 * contract for the admin's usage panel, the PRICE TABLE, and the arithmetic
 * that turns "95k reads on the 25th" into rupees.
 *
 *   GET /api/usage            ID token, admin only → UsageRes
 *   GET /api/usage?refresh=1  skip the cache and ask Cloud Monitoring again
 *
 * ────────────────────────────────────────────────────────────────────────
 * THIS IS AN ESTIMATE. THE CONSOLE IS THE INVOICE.
 * ────────────────────────────────────────────────────────────────────────
 * The prices below are typed in by hand from the public price lists on the
 * date in `asOf`; Google changes them without telling this file, the rupee
 * conversion is a fixed rate rather than the day's, committed spend, support,
 * taxes and any promotional credit are not modelled, and stored data is not
 * measured at all (see STORED DATA below). The panel says so out loud. Use it
 * to notice a change of SHAPE — "something started doing 300k reads a day" —
 * and the Firebase console when you want the number you will actually pay.
 *
 * WHY THE FREE QUOTA IS THE POINT. §W's whole budget rests on the steady
 * state sitting inside the free DAILY quota (50k reads / 20k writes). The
 * daily allowance does not roll over and is not a monthly bucket, so the
 * month's bill is `sum over days of max(0, that day − the allowance)` — one
 * bad day costs money even if the month's total looks small. Every daily line
 * here is computed that way, per day, never from a month total.
 *
 * THE QUOTA DAY IS A US PACIFIC DAY. Firebase's daily free quotas reset at
 * midnight America/Los_Angeles, so "today" in this panel is the quota day,
 * not the Indian calendar day — otherwise the bar would read ~0% every
 * morning IST for a day that is already half spent. The panel labels it.
 *
 * STORED DATA IS NOT MEASURED. Firestore / RTDB / Storage / Hosting stored
 * bytes are left out on purpose: at this app's size (§W: 50 boards × 10 live
 * tickets) they sit inside the free tier, their Monitoring metric names are
 * the least stable part of this surface, and a wrong number is worse than an
 * absent one. The panel says what it does not count.
 */
import { z } from 'zod';

/** GET with the Firebase ID token. Admin only; the server checks, not the menu. */
export const USAGE_ROUTE = '/api/usage';

/**
 * Where the hourly answer is kept. `_config/…` is server-owned — no security
 * rule lets a client near it — like the allow list and the signing secrets.
 */
export const USAGE_CACHE_DOC = '_config/usage';

/** An hour (§X: "cached for an hour, so looking costs almost nothing"). */
export const USAGE_CACHE_TTL_MS = 60 * 60_000;

/** Firebase's daily free quotas reset at midnight here. Not IST. */
export const QUOTA_TIME_ZONE = 'America/Los_Angeles';

const GiB = 1024 ** 3;

/* ────────────────────────── free tiers ────────────────────────── */

/**
 * The free allowance that resets EVERY DAY (Pacific midnight). Spending it is
 * free; the day's overflow is what costs.
 */
export const FREE_DAILY = {
  firestoreReads: 50_000,
  firestoreWrites: 20_000,
  firestoreDeletes: 20_000,
  /** Cloud Storage: 1 GB downloaded per day. */
  storageEgressBytes: GiB,
} as const;

/**
 * The free allowance that resets every MONTH. Cloud Run's (which is what a
 * 2nd-gen function is) is enormous compared with anything this app does;
 * RTDB's and Hosting's are the ones worth watching.
 */
export const FREE_MONTHLY = {
  runRequests: 2_000_000,
  vcpuSeconds: 180_000,
  gibSeconds: 360_000,
  /** RTDB: 10 GB downloaded per month on Blaze. */
  rtdbDownloadBytes: 10 * GiB,
  /** Hosting: 10 GB transferred per month. */
  hostingEgressBytes: 10 * GiB,
} as const;

/* ────────────────────────── the price table ────────────────────────── */

/**
 * One region's list prices, in US DOLLARS, exactly as the public price lists
 * state them. Rupees happen once, at the end, through `usdToInr`.
 */
export interface RegionPrices {
  /** Firestore, in a REGIONAL location (asia-south1 is one; nam5/eur3 cost more). */
  firestore: {
    readPer100k: number;
    writePer100k: number;
    deletePer100k: number;
  };
  /** Cloud Run (a 2nd-gen function): CPU, memory and requests. */
  run: {
    vcpuSecond: number;
    gibSecond: number;
    perMillionRequests: number;
  };
  /** Realtime Database bills BANDWIDTH, not operations (§W, point 3). */
  rtdb: { downloadGib: number };
  /** Cloud Storage egress to the internet. */
  storage: { egressGib: number };
  /** Hosting transfer. */
  hosting: { egressGib: number };
}

/**
 * PRICES, typed in by hand on the date below. Re-check them when they look
 * wrong; nothing in the code notices that they have gone stale.
 *
 * Sources (public list prices, no committed-use or promotional discount):
 *   Firestore — regional location tier
 *   Cloud Run — Tier 1 regions (asia-south1 and us-central1 are both Tier 1)
 *   Realtime Database, Cloud Storage egress, Hosting transfer — flat
 */
export const PRICES_ASOF = '2026-09-01';

export const PRICES_USD: Record<string, RegionPrices> = {
  /** Mumbai — where this project runs (infra/, firebase.deploy.json). */
  'asia-south1': {
    firestore: { readPer100k: 0.03, writePer100k: 0.09, deletePer100k: 0.01 },
    run: { vcpuSecond: 0.000024, gibSecond: 0.0000025, perMillionRequests: 0.4 },
    rtdb: { downloadGib: 1.0 },
    storage: { egressGib: 0.12 },
    hosting: { egressGib: 0.15 },
  },
  /** The emulator's default region, and the fallback when a region is unknown. */
  'us-central1': {
    firestore: { readPer100k: 0.03, writePer100k: 0.09, deletePer100k: 0.01 },
    run: { vcpuSecond: 0.000024, gibSecond: 0.0000025, perMillionRequests: 0.4 },
    rtdb: { downloadGib: 1.0 },
    storage: { egressGib: 0.12 },
    hosting: { egressGib: 0.15 },
  },
};

export const DEFAULT_USAGE_REGION = 'asia-south1';

/**
 * ₹ per $1, on the date above. A fixed rate on purpose: the panel must not
 * make a network call to a currency service to tell you what you are spending,
 * and a bill that moves 2% with the rupee is not information.
 */
export const USD_TO_INR = 88;

/** The table actually used, with the rupee rate folded in. */
export interface PriceTable extends RegionPrices {
  region: string;
  asOf: string;
  usdToInr: number;
}

export function pricesFor(region?: string | null, usdToInr: number = USD_TO_INR): PriceTable {
  const key = region && PRICES_USD[region] ? region : DEFAULT_USAGE_REGION;
  return { ...PRICES_USD[key]!, region: key, asOf: PRICES_ASOF, usdToInr };
}

/* ────────────────────────── what was measured ────────────────────────── */

/**
 * One quota day's counters, as Cloud Monitoring gave them. A metric that has
 * no time series (nothing used it yet, or the name moved) is a 0 — never a
 * gap, so the arithmetic below never has to think about holes.
 */
export const UsageDaySchema = z.object({
  /** The quota day, 'YYYY-MM-DD' in America/Los_Angeles. */
  day: z.string(),
  firestoreReads: z.number(),
  firestoreWrites: z.number(),
  firestoreDeletes: z.number(),
  runRequests: z.number(),
  /** vCPU-seconds (Cloud Run bills the WHOLE request, I/O wait included — §W). */
  vcpuSeconds: z.number(),
  /** GiB-seconds of memory. */
  gibSeconds: z.number(),
  rtdbDownloadBytes: z.number(),
  storageEgressBytes: z.number(),
  hostingEgressBytes: z.number(),
});
export type UsageDay = z.infer<typeof UsageDaySchema>;

export type UsageCounter = Exclude<keyof UsageDay, 'day'>;

export const USAGE_COUNTERS: readonly UsageCounter[] = [
  'firestoreReads',
  'firestoreWrites',
  'firestoreDeletes',
  'runRequests',
  'vcpuSeconds',
  'gibSeconds',
  'rtdbDownloadBytes',
  'storageEgressBytes',
  'hostingEgressBytes',
];

export const emptyUsageDay = (day: string): UsageDay => ({
  day,
  firestoreReads: 0,
  firestoreWrites: 0,
  firestoreDeletes: 0,
  runRequests: 0,
  vcpuSeconds: 0,
  gibSeconds: 0,
  rtdbDownloadBytes: 0,
  storageEgressBytes: 0,
  hostingEgressBytes: 0,
});

/* ────────────────────────── the estimate ────────────────────────── */

export const UsageServiceIdSchema = z.enum([
  'firestore',
  'functions',
  'rtdb',
  'storage',
  'hosting',
]);
export type UsageServiceId = z.infer<typeof UsageServiceIdSchema>;

export const SERVICE_LABELS: Record<UsageServiceId, string> = {
  firestore: 'Firestore',
  functions: 'Functions',
  rtdb: 'Realtime Database',
  storage: 'Storage',
  hosting: 'Hosting',
};

export const UsageLineSchema = z.object({
  id: z.string(),
  service: UsageServiceIdSchema,
  label: z.string(),
  /** How `used` / `free` / `billable` should be read: 'count' | 'seconds' | 'bytes'. */
  unit: z.enum(['count', 'seconds', 'bytes']),
  /** How the allowance works — it decides how the free column is explained. */
  quota: z.enum(['daily', 'monthly', 'none']),
  /** This month so far, in `unit`. */
  used: z.number(),
  /** The free allowance actually ABSORBED this month (daily lines: summed per day). */
  free: z.number(),
  /** What is left to pay for. */
  billable: z.number(),
  /** ₹ for this line, rounded to paise. */
  inr: z.number(),
  /** '₹2.64 per 100k' — the rate, ready to show. */
  rate: z.string(),
  /** One value per quota day so far, oldest first. Free: it is what we summed. */
  series: z.array(z.number()),
});
export type UsageLine = z.infer<typeof UsageLineSchema>;

export const UsageEstimateSchema = z.object({
  lines: z.array(UsageLineSchema),
  /** ₹ per service, biggest first — the "broken down by service" view. */
  services: z.array(z.object({ id: UsageServiceIdSchema, label: z.string(), inr: z.number() })),
  totalInr: z.number(),
});
export type UsageEstimate = z.infer<typeof UsageEstimateSchema>;

/** Round to paise. Every line and the total agree because both are rounded here. */
export const paise = (n: number): number => Math.round(n * 100) / 100;

/** Sum of `max(0, day − allowance)` — the only correct way to bill a DAILY quota. */
export function billableDaily(series: readonly number[], freePerDay: number): number {
  return series.reduce((sum, v) => sum + Math.max(0, v - freePerDay), 0);
}

/** Free allowance actually absorbed by a daily-quota line. */
export function absorbedDaily(series: readonly number[], freePerDay: number): number {
  return series.reduce((sum, v) => sum + Math.min(Math.max(0, v), freePerDay), 0);
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** '₹2.64 per 100k' / '₹0.0021 per vCPU-second'. */
const rateLabel = (inr: number, per: string, digits = 2): string =>
  `₹${inr.toFixed(digits)} per ${per}`;

interface LineSpec {
  id: string;
  service: UsageServiceId;
  label: string;
  unit: UsageLine['unit'];
  quota: UsageLine['quota'];
  counter: UsageCounter;
  /** Free allowance, per DAY or per MONTH depending on `quota`. */
  free: number;
  /** ₹ per `per` units of the counter. */
  priceInr: (p: PriceTable) => number;
  /** How many counter-units one price covers (100_000 reads, 1 GiB, 1 s…). */
  per: number;
  rate: (inr: number) => string;
}

/**
 * EVERY LINE OF THE BILL, in one table so the arithmetic below is a loop and
 * not nine special cases. Adding a metric is adding a row here.
 */
const LINES: readonly LineSpec[] = [
  {
    id: 'firestoreReads',
    service: 'firestore',
    label: 'Document reads',
    unit: 'count',
    quota: 'daily',
    counter: 'firestoreReads',
    free: FREE_DAILY.firestoreReads,
    priceInr: (p) => p.firestore.readPer100k * p.usdToInr,
    per: 100_000,
    rate: (inr) => rateLabel(inr, '100k'),
  },
  {
    id: 'firestoreWrites',
    service: 'firestore',
    label: 'Document writes',
    unit: 'count',
    quota: 'daily',
    counter: 'firestoreWrites',
    free: FREE_DAILY.firestoreWrites,
    priceInr: (p) => p.firestore.writePer100k * p.usdToInr,
    per: 100_000,
    rate: (inr) => rateLabel(inr, '100k'),
  },
  {
    id: 'firestoreDeletes',
    service: 'firestore',
    label: 'Document deletes',
    unit: 'count',
    quota: 'daily',
    counter: 'firestoreDeletes',
    free: FREE_DAILY.firestoreDeletes,
    priceInr: (p) => p.firestore.deletePer100k * p.usdToInr,
    per: 100_000,
    rate: (inr) => rateLabel(inr, '100k'),
  },
  {
    id: 'runRequests',
    service: 'functions',
    label: 'Invocations',
    unit: 'count',
    quota: 'monthly',
    counter: 'runRequests',
    free: FREE_MONTHLY.runRequests,
    priceInr: (p) => p.run.perMillionRequests * p.usdToInr,
    per: 1_000_000,
    rate: (inr) => rateLabel(inr, 'million'),
  },
  {
    id: 'vcpuSeconds',
    service: 'functions',
    label: 'vCPU-seconds',
    unit: 'seconds',
    quota: 'monthly',
    counter: 'vcpuSeconds',
    free: FREE_MONTHLY.vcpuSeconds,
    priceInr: (p) => p.run.vcpuSecond * p.usdToInr * 1000,
    per: 1000,
    rate: (inr) => rateLabel(inr, '1,000 vCPU-s'),
  },
  {
    id: 'gibSeconds',
    service: 'functions',
    label: 'Memory GiB-seconds',
    unit: 'seconds',
    quota: 'monthly',
    counter: 'gibSeconds',
    free: FREE_MONTHLY.gibSeconds,
    priceInr: (p) => p.run.gibSecond * p.usdToInr * 1000,
    per: 1000,
    rate: (inr) => rateLabel(inr, '1,000 GiB-s', 3),
  },
  {
    id: 'rtdbDownloadBytes',
    service: 'rtdb',
    label: 'Bandwidth out',
    unit: 'bytes',
    quota: 'monthly',
    counter: 'rtdbDownloadBytes',
    free: FREE_MONTHLY.rtdbDownloadBytes,
    priceInr: (p) => p.rtdb.downloadGib * p.usdToInr,
    per: GiB,
    rate: (inr) => rateLabel(inr, 'GiB'),
  },
  {
    id: 'storageEgressBytes',
    service: 'storage',
    label: 'Downloads',
    unit: 'bytes',
    quota: 'daily',
    counter: 'storageEgressBytes',
    free: FREE_DAILY.storageEgressBytes,
    priceInr: (p) => p.storage.egressGib * p.usdToInr,
    per: GiB,
    rate: (inr) => rateLabel(inr, 'GiB'),
  },
  {
    id: 'hostingEgressBytes',
    service: 'hosting',
    label: 'Transfer',
    unit: 'bytes',
    quota: 'monthly',
    counter: 'hostingEgressBytes',
    free: FREE_MONTHLY.hostingEgressBytes,
    priceInr: (p) => p.hosting.egressGib * p.usdToInr,
    per: GiB,
    rate: (inr) => rateLabel(inr, 'GiB'),
  },
];

/**
 * THE ARITHMETIC. Days in, rupees out — pure, so a test can check it and the
 * panel never has to do sums of its own.
 *
 * Daily lines bill per day (see the header); monthly lines bill the month's
 * total against one monthly allowance. Lines that cost nothing still come
 * back, because "0 of 50,000 reads used" is the most useful row on the page.
 */
export function estimate(days: readonly UsageDay[], prices: PriceTable): UsageEstimate {
  const lines: UsageLine[] = LINES.map((spec) => {
    const series = days.map((d) => d[spec.counter]);
    const used = sum(series);
    const billable =
      spec.quota === 'daily'
        ? billableDaily(series, spec.free)
        : spec.quota === 'monthly'
          ? Math.max(0, used - spec.free)
          : used;
    const free =
      spec.quota === 'daily'
        ? absorbedDaily(series, spec.free)
        : spec.quota === 'monthly'
          ? Math.min(used, spec.free)
          : 0;
    const priceInr = spec.priceInr(prices);
    return {
      id: spec.id,
      service: spec.service,
      label: spec.label,
      unit: spec.unit,
      quota: spec.quota,
      used,
      free,
      billable,
      inr: paise((billable / spec.per) * priceInr),
      rate: spec.rate(priceInr),
      series,
    };
  });

  const byService = new Map<UsageServiceId, number>();
  for (const l of lines) byService.set(l.service, paise((byService.get(l.service) ?? 0) + l.inr));
  const services = [...byService.entries()]
    .map(([id, inr]) => ({ id, label: SERVICE_LABELS[id], inr }))
    .sort((a, b) => b.inr - a.inr || a.label.localeCompare(b.label));

  return { lines, services, totalInr: paise(sum(lines.map((l) => l.inr))) };
}

/* ────────────────────────── today, against the quota ────────────────────────── */

/**
 * The number that decides whether the month costs ₹0 or ₹600 (§X, last
 * bullet). Everything else on the page is history; this one is actionable.
 */
export const UsageTodaySchema = z.object({
  /** The quota day, 'YYYY-MM-DD' Pacific. */
  day: z.string(),
  reads: z.number(),
  writes: z.number(),
  readsFree: z.number(),
  writesFree: z.number(),
  /** Epoch ms when this allowance resets (next Pacific midnight). */
  resetsAt: z.number(),
});
export type UsageToday = z.infer<typeof UsageTodaySchema>;

/** 0…1+ — over 1 means the day has gone past the free allowance. */
export const quotaFraction = (used: number, free: number): number => (free > 0 ? used / free : 0);

/* ────────────────────────── the answer ────────────────────────── */

/**
 * WHY A STATUS AND NOT AN ERROR. The Monitoring grant is a one-line console
 * step that has to happen after the first deploy (infra/monitoring-role.md),
 * and a page that 500s until somebody remembers is a bad way to be told. So
 * every way this can fail comes back as a NORMAL answer with a `status` and a
 * sentence the admin can act on:
 *
 *   ok          measured
 *   notGranted  the service account lacks roles/monitoring.viewer — run the
 *               command in `message`
 *   local       the emulators / a demo project: there is nothing to measure
 *   unavailable Monitoring could not be reached; `stale` numbers may still be
 *               shown from the cache
 */
export const UsageStatusSchema = z.enum(['ok', 'notGranted', 'local', 'unavailable']);
export type UsageStatus = z.infer<typeof UsageStatusSchema>;

export const UsageResSchema = z.object({
  status: UsageStatusSchema,
  /** Plain English when status is not 'ok'; null when it is. */
  message: z.string().nullable(),
  /** The billing month these numbers cover, 'YYYY-MM' (Pacific). */
  month: z.string(),
  /** Quota days included, oldest first — the sparkline's x axis. */
  days: z.array(z.string()),
  today: UsageTodaySchema,
  estimate: UsageEstimateSchema,
  prices: z.object({
    region: z.string(),
    asOf: z.string(),
    usdToInr: z.number(),
  }),
  /** When these numbers were fetched from Monitoring. */
  measuredAt: z.number(),
  /** When this answer stops being served from the cache. */
  freshUntil: z.number(),
  /** True when the cache was served past its hour because a refresh failed. */
  stale: z.boolean(),
  /** True when this response came from Firestore rather than Monitoring. */
  cached: z.boolean(),
});
export type UsageRes = z.infer<typeof UsageResSchema>;

/** The cache document at `_config/usage`. */
export const UsageCacheSchema = z.object({
  at: z.number(),
  res: UsageResSchema,
});
export type UsageCache = z.infer<typeof UsageCacheSchema>;

/**
 * What the panel says it does NOT count, shown under the total so the number
 * is never mistaken for the invoice.
 */
export const USAGE_CAVEAT =
  'An estimate from list prices, not a bill: stored data, taxes and any credits are not counted, ' +
  'and the rupee rate is fixed. The Firebase console is the invoice.';
