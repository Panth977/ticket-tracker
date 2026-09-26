/** Time-zone choices for Welcome and Account › Profile. */
import { browserTimeZone } from '$lib/ui/calendar';

const FALLBACK = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Africa/Johannesburg',
];

/** Every IANA zone the browser knows (sorted), always including `current`. */
export function timeZones(current?: string | null): string[] {
  let list: string[];
  try {
    list =
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
        'timeZone',
      ) ?? FALLBACK;
  } catch {
    list = FALLBACK;
  }
  const set = new Set(list);
  set.add('UTC');
  if (current) set.add(current);
  return [...set].sort();
}

/** 'Asia/Kolkata (GMT+5:30)'. */
export function zoneLabel(tz: string, at = Date.now()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    return part ? `${tz.replace(/_/g, ' ')} (${part})` : tz;
  } catch {
    return tz;
  }
}

export { browserTimeZone };
