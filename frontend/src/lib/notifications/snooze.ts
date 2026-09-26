/**
 * Snooze presets, in the person's own time zone (users/{uid}.timezone):
 * 'Later today' is +3h, the others land at 09:00 local. `s` in the inbox
 * uses the first preset whose time is still ahead.
 */
import type { Millis } from '@tm/shared';
import { zonedParts, zonedTimeToMillis } from '@tm/shared/logic/time';

export interface SnoozeOption {
  id: 'later' | 'tomorrow' | 'weekend' | 'nextWeek';
  label: string;
  until: Millis;
}

const MORNING = 9;

export function snoozeOptions(now: Millis, tz: string): SnoozeOption[] {
  let p;
  try {
    p = zonedParts(now, tz);
  } catch {
    tz = 'UTC';
    p = zonedParts(now, tz);
  }
  const at = (dayOffset: number) =>
    zonedTimeToMillis(p.year, p.month, p.day + dayOffset, MORNING, 0, tz);
  // Days until next Saturday (6) and next Monday (1); never "today".
  const toSat = (6 - p.weekday + 7) % 7 || 7;
  const toMon = (1 - p.weekday + 7) % 7 || 7;
  const opts: SnoozeOption[] = [
    { id: 'later', label: 'Later today', until: now + 3 * 60 * 60 * 1000 },
    { id: 'tomorrow', label: 'Tomorrow', until: at(1) },
  ];
  // "This weekend" only makes sense on a weekday.
  if (p.weekday >= 1 && p.weekday <= 5)
    opts.push({ id: 'weekend', label: 'This weekend', until: at(toSat) });
  opts.push({ id: 'nextWeek', label: 'Next week', until: at(toMon) });
  return opts;
}

/** The `s` key: tomorrow morning. */
export function defaultSnooze(now: Millis, tz: string): SnoozeOption {
  return snoozeOptions(now, tz).find((o) => o.id === 'tomorrow')!;
}

/** 'Tue 09:00' style label for when a snoozed row comes back. */
export function formatWhen(at: Millis, tz: string, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(at));
  } catch {
    return new Date(at).toLocaleString(locale);
  }
}
