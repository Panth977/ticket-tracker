import { describe, expect, it } from 'vitest';
import { defaultSnooze, snoozeOptions } from './snooze';

// Wednesday 2026-09-23 14:00 UTC
const WED = Date.UTC(2026, 8, 23, 14, 0);

describe('snooze presets', () => {
  it('lands at 09:00 local on the right days', () => {
    const o = snoozeOptions(WED, 'UTC');
    expect(o.map((x) => x.id)).toEqual(['later', 'tomorrow', 'weekend', 'nextWeek']);
    expect(o[1]!.until).toBe(Date.UTC(2026, 8, 24, 9, 0));
    expect(o[2]!.until).toBe(Date.UTC(2026, 8, 26, 9, 0));
    expect(o[3]!.until).toBe(Date.UTC(2026, 8, 28, 9, 0));
  });

  it('respects the time zone', () => {
    // 09:00 in Kolkata (UTC+5:30) is 03:30 UTC.
    expect(defaultSnooze(WED, 'Asia/Kolkata').until).toBe(Date.UTC(2026, 8, 24, 3, 30));
  });

  it('drops "this weekend" on a weekend and survives a bad zone', () => {
    const sat = Date.UTC(2026, 8, 26, 12);
    expect(snoozeOptions(sat, 'UTC').some((x) => x.id === 'weekend')).toBe(false);
    expect(snoozeOptions(sat, 'Not/AZone').length).toBeGreaterThan(0);
  });
});
