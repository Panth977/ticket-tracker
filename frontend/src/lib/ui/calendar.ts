/** Pure calendar maths for DatePicker (wall-clock dates, no zones). */
export interface CalDay {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  inMonth: boolean;
}

/** 6 weeks × 7 days covering `month`, weeks starting Monday by default. */
export function monthGrid(year: number, month: number, weekStartsOn = 1): CalDay[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const back = (first.getUTCDay() - weekStartsOn + 7) % 7;
  const out: CalDay[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(Date.UTC(year, month - 1, 1 - back + i));
    out.push({
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      inMonth: d.getUTCMonth() + 1 === month,
    });
  }
  return out;
}

export function addMonths(year: number, month: number, n: number): { year: number; month: number } {
  const d = new Date(Date.UTC(year, month - 1 + n, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
