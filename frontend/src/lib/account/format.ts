/** Small date formatting for the account screens (in the person's time zone). */

const rtf =
  typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

/** '3 minutes ago', 'yesterday', 'in 2 days'. */
export function relativeTime(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 86_400_000],
    ['month', 30 * 86_400_000],
    ['week', 7 * 86_400_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  for (const [unit, size] of units) {
    if (abs >= size) {
      const n = Math.round(diff / size);
      return rtf ? rtf.format(n, unit) : `${n} ${unit}`;
    }
  }
  return 'just now';
}

/** 'Sep 22, 2026, 14:05' in the given zone. */
export function dateTime(ms: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(ms);
  } catch {
    return new Date(ms).toLocaleString();
  }
}

export function dateOnly(ms: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone }).format(ms);
  } catch {
    return new Date(ms).toLocaleDateString();
  }
}
