/**
 * Activity rows store RAW IDS (shared logic/diff: "the UI resolves names").
 * humanize() turns one row into sentences using the board's CURRENT names:
 *   { stage: { from: 'st1', to: 'st2' } }  →  'moved this from Doing to QA'
 * Pure: the lookups are passed in, so it is unit-tested.
 */
import type { Activity, FieldDef, TicketLink, Via } from '@tm/shared';

export interface ActivityLookups {
  stage(id: string): string | undefined;
  priority(id: string): string | undefined;
  tag(id: string): string | undefined;
  person(uid: string): string | undefined;
  field(id: string): FieldDef | undefined;
  /** Ticket id → key, when known. */
  ticket(id: string): string | undefined;
  board(id: string): string | undefined;
  /** Millis → 'Fri 3 Oct' (all-day) or with a time. */
  date(ms: number, allDay: boolean): string;
}

const VIA_LABEL: Record<Via, string | null> = {
  app: null,
  api: 'via API',
  mcp: 'via MCP',
  email: 'via email',
  whatsapp: 'via WhatsApp',
  intake: 'via intake form',
  integration: 'via integration',
  system: 'automatically',
};
export const viaLabel = (via: Via | null | undefined) => (via ? VIA_LABEL[via] : null);

/** How a link reads from THIS ticket's side. */
export const LINK_LABEL: Record<TicketLink['type'], string> = {
  blocks: 'blocks',
  blockedBy: 'blocked by',
  relates: 'relates to',
  duplicates: 'duplicates',
};

const LINK_WORD: Record<TicketLink['type'], string> = {
  blocks: 'blocks',
  blockedBy: 'is blocked by',
  relates: 'relates to',
  duplicates: 'duplicates',
};

const list = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const q = (s: string) => `“${s}”`;

function added<T>(from: T[], to: T[], key: (x: T) => string = String) {
  const f = new Set(from.map(key));
  const t = new Set(to.map(key));
  return { add: to.filter((x) => !f.has(key(x))), rem: from.filter((x) => !t.has(key(x))) };
}

function fieldValue(def: FieldDef | undefined, v: unknown, L: ActivityLookups): string {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return 'empty';
  if (!def) return Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? 'a range' : String(v);
  const opt = (id: string) => def.options?.find((o) => o.id === id)?.name ?? 'a removed option';
  switch (def.type) {
    case 'select':
      return opt(String(v));
    case 'multiSelect':
      return arr(v).map(opt).join(', ');
    case 'person':
      return L.person(String(v)) ?? 'someone';
    case 'people':
      return arr(v)
        .map((u) => L.person(u) ?? 'someone')
        .join(', ');
    case 'ticketRelation':
      return arr(v)
        .map((id) => L.ticket(id) ?? 'a ticket')
        .join(', ');
    case 'checkbox':
      return v ? 'checked' : 'unchecked';
    case 'date':
      return typeof v === 'number' ? L.date(v, true) : String(v);
    case 'dateRange': {
      const r = v as { start?: number; end?: number };
      return typeof r.start === 'number' && typeof r.end === 'number'
        ? `${L.date(r.start, true)} – ${L.date(r.end, true)}`
        : 'a range';
    }
    case 'rating':
      return '★'.repeat(Math.max(0, Math.min(10, Number(v))));
    case 'percent':
      return `${v}%`;
    case 'currency':
      return def.config?.currency ? `${def.config.currency} ${v}` : String(v);
    case 'longText':
      return 'new text';
    default:
      return String(v);
  }
}

/** One sentence per change, each starting with a verb ('set priority to High'). */
export function humanize(a: Pick<Activity, 'action' | 'changes'>, L: ActivityLookups): string[] {
  const c = a.changes ?? {};
  const out: string[] = [];
  const name = (f: (id: string) => string | undefined, id: unknown, fallback: string) =>
    id == null ? null : (f(String(id)) ?? fallback);

  switch (a.action) {
    case 'create':
      return ['created this ticket'];
    case 'referenced': {
      const src = c.referencedBy?.to;
      return [
        `mentioned this in ${src ? (L.ticket(String(src)) ?? 'another ticket') : 'another ticket'}`,
      ];
    }
    case 'state': {
      const to = String(c.state?.to ?? '');
      // History is history: rows written before phase 6 still say 'cancelled
      // this' (and may carry the reason that was recorded then). Nothing
      // writes either any more.
      const verb =
        to === 'archived'
          ? 'archived this'
          : to === 'cancelled'
            ? 'cancelled this'
            : 'restored this';
      const reason = c.reason?.to ? ` — ${String(c.reason.to)}` : '';
      return [verb + reason];
    }
  }

  for (const [key, ch] of Object.entries(c)) {
    const { from, to } = ch;
    if (key === 'title') out.push(`renamed this to ${q(String(to ?? ''))}`);
    else if (key === 'description')
      out.push(to ? 'edited the description' : 'cleared the description');
    else if (key === 'stage')
      out.push(
        from
          ? `moved this from ${name(L.stage, from, 'a removed stage')} to ${name(L.stage, to, 'a removed stage')}`
          : `moved this to ${name(L.stage, to, 'a removed stage')}`,
      );
    else if (key === 'priority')
      out.push(
        to
          ? `set priority to ${name(L.priority, to, 'a removed priority')}`
          : 'cleared the priority',
      );
    else if (key === 'tags') {
      const d = added(arr(from), arr(to));
      if (d.add.length)
        out.push(`added tag ${list(d.add.map((t) => L.tag(t) ?? 'a removed tag'))}`);
      if (d.rem.length)
        out.push(`removed tag ${list(d.rem.map((t) => L.tag(t) ?? 'a removed tag'))}`);
    } else if (key === 'assignees') {
      const d = added(arr(from), arr(to));
      if (d.add.length) out.push(`assigned ${list(d.add.map((u) => L.person(u) ?? 'someone'))}`);
      if (d.rem.length) out.push(`unassigned ${list(d.rem.map((u) => L.person(u) ?? 'someone'))}`);
    } else if (key === 'due') {
      const allDay = c.dueAllDay ? Boolean(c.dueAllDay.to) : true;
      out.push(
        typeof to === 'number' ? `set due to ${L.date(to, allDay)}` : 'removed the due date',
      );
    } else if (key === 'dueAllDay') {
      if (!c.due) out.push(to ? 'made the due date all-day' : 'gave the due date a time');
    } else if (key === 'start')
      out.push(
        typeof to === 'number' ? `set start to ${L.date(to, true)}` : 'removed the start date',
      );
    else if (key === 'estimate')
      out.push(to == null ? 'cleared the estimate' : `estimated ${String(to)}`);
    else if (key === 'links') {
      const d = added(
        (Array.isArray(from) ? from : []) as TicketLink[],
        (Array.isArray(to) ? to : []) as TicketLink[],
        (l) => `${l.type}:${l.ticketId}`,
      );
      for (const l of d.add)
        out.push(`linked: this ${LINK_WORD[l.type]} ${L.ticket(l.ticketId) ?? 'a ticket'}`);
      for (const l of d.rem) out.push(`unlinked ${L.ticket(l.ticketId) ?? 'a ticket'}`);
    } else if (key.startsWith('commitments.')) {
      const who = L.person(key.slice('commitments.'.length)) ?? 'someone';
      out.push(
        typeof to === 'number'
          ? `set ${who}'s commitment to ${L.date(to, true)}`
          : `cleared ${who}'s commitment`,
      );
    } else if (key.startsWith('fields.')) {
      const def = L.field(key.slice('fields.'.length));
      const label = def?.name ?? 'a removed field';
      out.push(
        to == null || (Array.isArray(to) && !to.length)
          ? `cleared ${label}`
          : `set ${label} to ${fieldValue(def, to, L)}`,
      );
    } else if (key === 'state') out.push(`changed state to ${String(to)}`);
  }
  return out.length ? out : ['updated this ticket'];
}
