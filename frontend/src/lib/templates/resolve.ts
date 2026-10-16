/**
 * A ticket template's answer → ticketCreate's input (docs/plan/templates.html
 * §D2). Templates name things the way people do — a stage 'In progress', a
 * tag 'bug', a person by email, a field by its name — and this turns those
 * names into the board's ids. Anything that names nothing is a PROBLEM the
 * dialog shows; nothing is guessed. A tag name the board lacks is the one
 * exception: it becomes a new tag, as in quick add.
 */
import {
  TicketTemplateResultSchema,
  MessageTemplateResultSchema,
  type Board,
  type FieldValue,
  type MessageTemplateResult,
  type TicketTemplateTicket,
} from '@tm/shared';
import { firstStage } from '@tm/shared/logic/stages';
import { parseDue } from '@tm/shared/logic/time';
import type { MemberInfo } from './info';

export interface ResolvedTicket {
  input: {
    title: string;
    stageId: string;
    priorityId: string | null;
    tagIds: string[];
    assigneeUids: string[];
    dueAt: number | null;
    dueAllDay: boolean;
    startAt: number | null;
    estimate: number | null;
    fields?: Record<string, FieldValue>;
  };
  /** Markdown, converted when sent. */
  description: string;
  /** Tag names to create first (quick add's ensureTags). */
  newTags: string[];
  problems: string[];
}

const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const byIdOrName = <T extends { id: string; name: string }>(xs: readonly T[], ref: string) =>
  xs.find((x) => x.id === ref) ?? xs.find((x) => eq(x.name, ref));

function memberOf(members: readonly MemberInfo[], ref: string): MemberInfo | string {
  const r = ref.trim().replace(/^@/, '');
  const hit =
    members.find((m) => m.id === r) ??
    members.find((m) => m.email && eq(m.email, r)) ??
    (() => {
      const named = members.filter((m) => eq(m.name, r));
      return named.length === 1 ? named[0] : undefined;
    })();
  return hit ?? `Nobody on this board is “${ref}”`;
}

function when(
  v: number | string | null | undefined,
  now: number,
  tz: string,
): { at: number | null; allDay?: boolean } | string | undefined {
  if (v === undefined) return undefined;
  if (v === null) return { at: null };
  if (typeof v === 'number') return Number.isFinite(v) ? { at: v } : `Not a date: ${v}`;
  const iso = /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : NaN;
  if (Number.isFinite(iso)) return { at: iso, allDay: false };
  const d = parseDue(v, now, tz);
  return d ? { at: d.at, allDay: d.allDay } : `Couldn't read “${v}” as a date`;
}

export function resolveTicket(
  t: TicketTemplateTicket,
  board: Pick<Board, 'stages' | 'priorities' | 'tags' | 'fields'>,
  members: readonly MemberInfo[],
  opts: { now: number; tz: string; defaults?: { stageId?: string } },
): ResolvedTicket {
  const problems: string[] = [];
  const stage = t.stage ? byIdOrName(board.stages, t.stage) : undefined;
  if (t.stage && !stage) problems.push(`No stage called “${t.stage}”`);
  let priorityId: string | null = null;
  if (t.priority) {
    const p = byIdOrName(board.priorities, t.priority);
    if (!p) problems.push(`No priority called “${t.priority}”`);
    else priorityId = p.id;
  }
  const tagIds: string[] = [];
  const newTags: string[] = [];
  for (const ref of t.tags ?? []) {
    const tag = byIdOrName(board.tags, ref);
    if (tag) tagIds.push(tag.id);
    else if (!newTags.some((n) => eq(n, ref))) newTags.push(ref.trim());
  }
  const assigneeUids: string[] = [];
  for (const ref of t.assignees ?? []) {
    const m = memberOf(members, ref);
    if (typeof m === 'string') problems.push(m);
    else if (!assigneeUids.includes(m.id)) assigneeUids.push(m.id);
  }
  const due = when(t.dueAt, opts.now, opts.tz);
  const start = when(t.startAt, opts.now, opts.tz);
  for (const w of [due, start]) if (typeof w === 'string') problems.push(w);

  const fields: Record<string, FieldValue> = {};
  for (const [ref, raw] of Object.entries(t.fields ?? {})) {
    const def = board.fields.find((f) => !f.archived && (f.id === ref || eq(f.name, ref)));
    if (!def) {
      problems.push(`No field called “${ref}”`);
      continue;
    }
    if (raw === undefined || raw === null || raw === '') continue;
    const optionId = (v: unknown) => {
      const o = def.options ? byIdOrName(def.options, String(v)) : undefined;
      if (!o) problems.push(`${def.name}: no option “${String(v)}”`);
      return o?.id;
    };
    const person = (v: unknown) => {
      const m = memberOf(members, String(v));
      if (typeof m === 'string') problems.push(`${def.name}: ${m}`);
      return typeof m === 'string' ? undefined : m.id;
    };
    const list = (v: unknown) => (Array.isArray(v) ? v : [v]);
    switch (def.type) {
      case 'select': {
        const id = optionId(raw);
        if (id) fields[def.id] = id;
        break;
      }
      case 'multiSelect':
        fields[def.id] = list(raw)
          .map(optionId)
          .filter((x): x is string => !!x);
        break;
      case 'person': {
        const id = person(raw);
        if (id) fields[def.id] = id;
        break;
      }
      case 'people':
        fields[def.id] = list(raw)
          .map(person)
          .filter((x): x is string => !!x);
        break;
      case 'date': {
        const w = when(raw as number | string, opts.now, opts.tz);
        if (typeof w === 'string') problems.push(`${def.name}: ${w}`);
        else if (w?.at != null) fields[def.id] = w.at;
        break;
      }
      case 'checkbox':
        fields[def.id] = !!raw;
        break;
      case 'number':
      case 'currency':
      case 'percent':
      case 'rating': {
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(n)) problems.push(`${def.name}: “${String(raw)}” is not a number`);
        else fields[def.id] = n;
        break;
      }
      case 'formula':
        problems.push(`${def.name} is computed — a template cannot set it`);
        break;
      default:
        if (
          typeof raw === 'string' ||
          typeof raw === 'number' ||
          typeof raw === 'boolean' ||
          (Array.isArray(raw) && raw.every((x) => typeof x === 'string'))
        )
          fields[def.id] = raw as FieldValue;
        else if (raw && typeof raw === 'object' && 'start' in raw && 'end' in raw)
          fields[def.id] = raw as FieldValue;
        else problems.push(`${def.name}: unsupported value`);
    }
  }

  const dueAt = due && typeof due !== 'string' ? due.at : null;
  return {
    input: {
      title: t.title.trim(),
      stageId: stage?.id ?? opts.defaults?.stageId ?? firstStage(board as Board).id,
      priorityId,
      tagIds,
      assigneeUids,
      dueAt,
      dueAllDay: t.dueAllDay ?? (due && typeof due !== 'string' ? (due.allDay ?? true) : true),
      startAt: start && typeof start !== 'string' ? start.at : null,
      estimate: t.estimate ?? null,
      ...(Object.keys(fields).length ? { fields } : {}),
    },
    description: t.description ?? '',
    newTags,
    problems,
  };
}

/** A submit's answer, checked: what it means, or why it can't be used. */
export type Checked<T> =
  | { kind: 'valid'; value: T }
  | { kind: 'invalid'; errMsg: string; errors: Record<string, string> }
  | { kind: 'broken'; message: string };

function invalid(r: { errMsg?: string; error?: unknown }) {
  const errors: Record<string, string> = {};
  if (r.error && typeof r.error === 'object' && !Array.isArray(r.error))
    for (const [k, v] of Object.entries(r.error as Record<string, unknown>))
      if (v !== undefined && v !== null && v !== false) errors[k] = String(v);
  const errMsg =
    r.errMsg ??
    (typeof r.error === 'string' ? r.error : Object.keys(errors).length ? '' : 'Not ready to send');
  return { kind: 'invalid' as const, errMsg, errors };
}

const shapeProblem = (issues: { path: (string | number)[]; message: string }[]) =>
  `submit answered something unexpected: ${issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'result'} — ${i.message}`)
    .join('; ')}`;

export function checkMessageResult(raw: unknown): Checked<{ msg: string; data?: unknown }> {
  const r = MessageTemplateResultSchema.safeParse(raw);
  if (!r.success) return { kind: 'broken', message: shapeProblem(r.error.issues) };
  const v: MessageTemplateResult = r.data;
  if (v.type === 'invalid') return invalid(v);
  return {
    kind: 'valid',
    value: { msg: v.msg, ...(v.data !== undefined ? { data: v.data } : {}) },
  };
}

export function checkTicketResult(raw: unknown): Checked<TicketTemplateTicket> {
  const r = TicketTemplateResultSchema.safeParse(raw);
  if (!r.success) return { kind: 'broken', message: shapeProblem(r.error.issues) };
  if (r.data.type === 'invalid') return invalid(r.data);
  return { kind: 'valid', value: r.data.ticket };
}
