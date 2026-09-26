/**
 * Display helpers shared by every view: dates in the viewer's zone, a field
 * value as text, and a group's label (the engine leaves people and checkbox
 * labels to the UI).
 */
import type { Board, FieldValue, Millis, TicketWithId } from '@tm/shared';
import { addDaysTz, isOverdue, sameDayTz } from '@tm/shared/logic/time';
import { ALL_KEY, NONE_KEY, type ViewGroup } from '@tm/shared/logic/view';
import { fieldInfo, STATE_OPTIONS } from './fields';

type BoardShape = Pick<Board, 'stages' | 'priorities' | 'tags' | 'fields'>;

export function formatDate(
  ms: Millis | null | undefined,
  tz: string,
  opts: { allDay?: boolean; now?: Millis } = {},
): string {
  if (ms == null) return '';
  const now = opts.now ?? Date.now();
  if (sameDayTz(ms, now, tz))
    return opts.allDay === false ? `Today ${formatTime(ms, tz)}` : 'Today';
  if (sameDayTz(ms, addDaysTz(now, 1, tz), tz))
    return opts.allDay === false ? `Tomorrow ${formatTime(ms, tz)}` : 'Tomorrow';
  if (sameDayTz(ms, addDaysTz(now, -1, tz), tz)) return 'Yesterday';
  const sameYear =
    new Intl.DateTimeFormat('en', { timeZone: tz, year: 'numeric' }).format(ms) ===
    new Intl.DateTimeFormat('en', { timeZone: tz, year: 'numeric' }).format(now);
  const d = new Intl.DateTimeFormat('en', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(ms);
  return opts.allDay === false ? `${d} ${formatTime(ms, tz)}` : d;
}

export function formatTime(ms: Millis, tz: string): string {
  return new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(
    ms,
  );
}

/** Due-date tone for chips: overdue (danger), today (warning), else neutral. */
export function dueTone(
  t: Pick<TicketWithId, 'dueAt' | 'dueAllDay' | 'stageCategory'>,
  tz: string,
  now: Millis = Date.now(),
): 'danger' | 'warning' | 'neutral' {
  if (t.dueAt == null || t.stageCategory === 'done' || t.stageCategory === 'cancelled')
    return 'neutral';
  if (isOverdue(t.dueAt, now, { allDay: t.dueAllDay, tz })) return 'danger';
  if (sameDayTz(t.dueAt, now, tz)) return 'warning';
  return 'neutral';
}

export function formatNumber(
  v: number,
  def?: { type: string; config?: { currency?: string; precision?: number } },
): string {
  const precision = def?.config?.precision;
  if (def?.type === 'currency') {
    try {
      return new Intl.NumberFormat('en', {
        style: 'currency',
        currency: def.config?.currency ?? 'USD',
        ...(precision != null
          ? { minimumFractionDigits: precision, maximumFractionDigits: precision }
          : {}),
      }).format(v);
    } catch {
      return String(v);
    }
  }
  if (def?.type === 'percent') return `${v}%`;
  if (def?.type === 'rating') return '★'.repeat(Math.max(0, Math.round(v)));
  return precision != null ? v.toFixed(precision) : String(v);
}

/**
 * A custom field's value as plain text (people are uids here — callers that can
 * render PersonChips do so instead).
 */
export function fieldText(
  board: BoardShape,
  fieldId: string,
  v: FieldValue | undefined,
  tz: string,
): string {
  const def = board.fields.find((f) => f.id === fieldId);
  if (!def || v == null || v === '') return '';
  const opt = (id: string) => def.options?.find((o) => o.id === id)?.name ?? '';
  switch (def.type) {
    case 'select':
      return typeof v === 'string' ? opt(v) : '';
    case 'multiSelect':
      return Array.isArray(v) ? v.map(opt).filter(Boolean).join(', ') : '';
    case 'checkbox':
      return v === true ? 'Yes' : '';
    case 'date':
      return typeof v === 'number' ? formatDate(v, tz) : '';
    case 'dateRange':
      return v && typeof v === 'object' && !Array.isArray(v)
        ? `${formatDate(v.start, tz)} → ${formatDate(v.end, tz)}`
        : '';
    case 'number':
    case 'currency':
    case 'percent':
    case 'rating':
    case 'formula':
      return typeof v === 'number' ? formatNumber(v, def) : String(v);
    case 'people':
    case 'ticketRelation':
      return Array.isArray(v) ? `${v.length}` : '';
    default:
      return String(v);
  }
}

/** Is this group a people group (label = a person, drawn with PersonChip)? */
export function isPeopleGroup(board: BoardShape, by: string | null): boolean {
  if (!by) return false;
  if (by === 'assignee' || by === 'createdBy') return true;
  const k = fieldInfo(board, by)?.kind;
  return k === 'person' || k === 'people';
}

/** A group's heading text (people groups return the uid; render a PersonChip for those). */
export function groupLabel<T>(board: BoardShape, g: ViewGroup<T>): string {
  if (g.key === ALL_KEY) return 'All tickets';
  if (g.key === NONE_KEY) {
    switch (g.by) {
      case 'assignee':
        return 'Unassigned';
      case 'priority':
        return 'No priority';
      case 'tag':
        return 'No tags';
      case 'stage':
        return 'No stage';
      default:
        return `No ${fieldInfo(board, g.by)?.label.toLowerCase() ?? 'value'}`;
    }
  }
  if (g.label) return g.label;
  if (g.by === 'state') return STATE_OPTIONS.find((s) => s.id === g.key)?.name ?? g.key;
  const info = fieldInfo(board, g.by);
  if (info?.kind === 'checkbox')
    return g.key === 'true' ? info.label : `Not ${info.label.toLowerCase()}`;
  if (info?.kind === 'date' && typeof g.value === 'number') return formatDate(g.value, 'UTC');
  return String(g.value ?? g.key);
}
