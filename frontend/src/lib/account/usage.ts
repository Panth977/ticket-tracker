/**
 * WHAT IT COSTS, IN THE APP (docs/plan/agents.html §X) — the panel's data and
 * its formatting.
 *
 * One GET, admin only. The server does every sum (shared/src/api/usage.ts) and
 * caches the answer for an hour, so this module never computes a bill: it
 * fetches one and writes the numbers down in a way a person can read at a
 * glance — ₹, 95k, 1.4 GiB, and a sparkline drawn from the daily series that
 * came along for free in the same response.
 */
import { AppError, codeForStatus, fromProblem } from '@tm/shared';
import { USAGE_ROUTE, quotaFraction, type UsageLine, type UsageRes } from '@tm/shared/api/usage';
import { auth } from '$lib/firebase/auth.svelte';

export type { UsageLine, UsageRes };
export { quotaFraction };

/**
 * This month's usage. `refresh` skips the hourly cache — the one action here
 * that actually costs a Cloud Monitoring query, so it is a button and never
 * automatic.
 */
export async function fetchUsage(
  refresh = false,
  fetcher: typeof fetch = fetch,
): Promise<UsageRes> {
  const token = await auth.idToken();
  if (!token) throw new AppError('unauthenticated');
  let res: Response;
  try {
    res = await fetcher(`${USAGE_ROUTE}${refresh ? '?refresh=1' : ''}`, {
      headers: {
        accept: 'application/json, application/problem+json',
        authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw new AppError('unavailable', 'Could not reach the server — check your connection.');
  }
  if (!res.ok) {
    try {
      const err = fromProblem(await res.json());
      if (err.code !== 'internal' || res.status >= 500) throw err;
    } catch (e) {
      if (e instanceof AppError) throw e;
    }
    throw new AppError(codeForStatus(res.status));
  }
  return (await res.json()) as UsageRes;
}

/* ────────────────────────── writing numbers down ────────────────────────── */

/** '₹0', '₹38.95', '₹1,204.50' — paise only when there are any worth showing. */
export function rupees(n: number): string {
  if (!Number.isFinite(n)) return '₹0';
  if (n === 0) return '₹0';
  if (n < 0.01) return '< ₹0.01';
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** '950', '95k', '1.2M' — the shape of the number matters, not its last digit. */
export function compact(n: number): string {
  const v = Math.round(n);
  if (Math.abs(v) < 1_000) return String(v);
  if (Math.abs(v) < 1_000_000) return `${trim(v / 1_000)}k`;
  if (Math.abs(v) < 1_000_000_000) return `${trim(v / 1_000_000)}M`;
  return `${trim(v / 1_000_000_000)}B`;
}

const trim = (n: number): string =>
  Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, '');

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

/** '0 B', '412 KiB', '1.4 GiB'. */
export function bytes(n: number): string {
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(v) : trim(v)} ${UNITS[i]}`;
}

/** '4,120 s' / '11,963 vCPU-s' — seconds are counted, never converted to hours. */
export const seconds = (n: number): string => `${Math.round(n).toLocaleString('en-IN')} s`;

/** One line's `used` / `free` / `billable`, in the unit that line is counted in. */
export function amount(value: number, unit: UsageLine['unit']): string {
  return unit === 'bytes' ? bytes(value) : unit === 'seconds' ? seconds(value) : compact(value);
}

/* ────────────────────────── the sparkline ────────────────────────── */

/**
 * A polyline for one line's daily series, in a 100 × 24 box. Free: the series
 * is already in the response (it is what the month's total was summed from),
 * so drawing it costs no extra request, no extra read and no library.
 *
 * Scaled to the series' own maximum — the question a sparkline answers is
 * "was today like the other days?", not "how does Firestore compare to RTDB".
 */
export function sparkline(series: readonly number[], width = 100, height = 24): string {
  if (series.length === 0) return '';
  const max = Math.max(...series, 0);
  const step = series.length > 1 ? width / (series.length - 1) : 0;
  return series
    .map((v, i) => {
      const x = series.length > 1 ? i * step : width / 2;
      const y = height - (max > 0 ? (v / max) * (height - 2) : 0) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** Does this line have anything to draw? (All-zero months should stay blank.) */
export const hasShape = (series: readonly number[]): boolean => series.some((v) => v > 0);

/* ────────────────────────── today, against the quota ────────────────────────── */

/**
 * How a quota bar should feel. Under half is not worth a colour; past the
 * allowance is the only state that costs money, so it is the only red.
 */
export function quotaTone(used: number, free: number): 'ok' | 'warn' | 'over' {
  const f = quotaFraction(used, free);
  return f >= 1 ? 'over' : f >= 0.7 ? 'warn' : 'ok';
}

/** 'Resets in 4 hours' — the allowance is daily, so when matters. */
export function resetsIn(resetsAt: number, now = Date.now()): string {
  const ms = resetsAt - now;
  if (ms <= 0) return 'Resetting now';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  if (hours <= 0) return `Resets in ${minutes} min`;
  return `Resets in ${hours} h${minutes ? ` ${minutes} min` : ''}`;
}
