/** Date / time text for the drawer, in the viewer's zone. */

/** '10:42' today, 'Mon 10:42' this week, '3 Oct' this year, '3 Oct 2025' before. */
export function formatWhen(ms: number, tz?: string, now = Date.now()): string {
  const d = new Date(ms);
  const same = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...o }).format(d) ===
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...o }).format(new Date(now));
  const time = d.toLocaleTimeString(undefined, {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  });
  if (same({ year: 'numeric', month: '2-digit', day: '2-digit' })) return time;
  if (now - ms < 6 * 86_400_000 && now >= ms)
    return `${d.toLocaleDateString(undefined, { timeZone: tz, weekday: 'short' })} ${time}`;
  if (same({ year: 'numeric' }))
    return d.toLocaleDateString(undefined, { timeZone: tz, day: 'numeric', month: 'short' });
  return d.toLocaleDateString(undefined, {
    timeZone: tz,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** 'Fri 3 Oct' (all-day) or 'Fri 3 Oct, 17:00'. */
export function formatDay(ms: number, tz?: string, allDay = true): string {
  const o: Intl.DateTimeFormatOptions = {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  };
  if (!allDay) Object.assign(o, { hour: 'numeric', minute: '2-digit' });
  return new Date(ms).toLocaleString(undefined, o);
}

/** Full timestamp for tooltips. */
export function formatFull(ms: number, tz?: string): string {
  return new Date(ms).toLocaleString(undefined, {
    timeZone: tz,
    dateStyle: 'full',
    timeStyle: 'short',
  });
}
