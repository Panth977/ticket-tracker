/**
 * What a template SEES (docs/plan/templates.html §C2) — plain, named data
 * built from the board and its tickets: stages, priorities and tags by name,
 * people by name and email, custom fields by name. Pure functions, so the
 * shapes the docs promise are pinned by unit tests.
 */
import type { Board, BoardMember, FieldDef, FieldValue, Ticket } from '@tm/shared';

export interface OptionInfo {
  id: string;
  name: string;
  color: string | null;
}
export interface StageInfo extends OptionInfo {
  category: string;
  description: string | null;
}
export interface FieldInfo {
  id: string;
  name: string;
  type: string;
  required: boolean;
  options: OptionInfo[];
}
export interface MemberInfo {
  id: string;
  kind: 'user' | 'agent';
  name: string;
  email: string;
  role: string;
}
export interface BoardInfo {
  id: string;
  key: string;
  name: string;
  description: string | null;
  stages: StageInfo[];
  priorities: OptionInfo[];
  tags: OptionInfo[];
  fields: FieldInfo[];
}
export interface TicketInfo {
  id: string;
  key: string;
  title: string;
  /** Plain text of the description ('' when none). */
  description: string;
  stage: StageInfo | null;
  priority: OptionInfo | null;
  tags: OptionInfo[];
  assignees: MemberInfo[];
  reporter: { id: string | null; name: string };
  state: string;
  dueAt: number | null;
  dueAllDay: boolean;
  startAt: number | null;
  estimate: number | null;
  /** By field NAME: select → option name, multiSelect → names, person/people → names, else the value. */
  fields: Record<string, unknown>;
  /** By field ID: the stored value. */
  fieldValues: Record<string, FieldValue>;
  counts: { messages: number; files: number };
  /** '4/7' on the card: task-list items done / total, or null. */
  tasks: { done: number; total: number } | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

const opt = (o: { id: string; name: string; color?: string }): OptionInfo => ({
  id: o.id,
  name: o.name,
  color: o.color ?? null,
});
const byPos = <T extends { position: number }>(xs: readonly T[]) =>
  [...xs].sort((a, b) => a.position - b.position);

export function boardInfo(b: Board & { id: string }): BoardInfo {
  return {
    id: b.id,
    key: b.key,
    name: b.name,
    description: typeof b.description === 'string' ? b.description : null,
    stages: byPos(b.stages).map((s) => ({
      ...opt(s),
      category: s.category,
      description: s.description ?? null,
    })),
    priorities: byPos(b.priorities).map(opt),
    tags: byPos(b.tags).map(opt),
    fields: byPos(b.fields.filter((f) => !f.archived)).map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      required: !!f.required,
      options: byPos(f.options ?? []).map(opt),
    })),
  };
}

export function memberInfo(
  m: Pick<BoardMember, 'uid' | 'name' | 'email' | 'role'> & { kind?: string },
): MemberInfo {
  return {
    id: m.uid,
    kind: m.kind === 'agent' ? 'agent' : 'user',
    name: m.name || m.email,
    email: m.email,
    role: m.role,
  };
}

/** A custom field's value as people read it (option and member names). */
export function readableValue(
  def: FieldDef,
  v: FieldValue | undefined,
  members: ReadonlyMap<string, MemberInfo>,
): unknown {
  if (v === undefined || v === null) return null;
  const optName = (id: string) => def.options?.find((o) => o.id === id)?.name ?? id;
  switch (def.type) {
    case 'select':
      return typeof v === 'string' ? optName(v) : v;
    case 'multiSelect':
      return Array.isArray(v) ? v.map(optName) : v;
    case 'person':
      return typeof v === 'string' ? (members.get(v)?.name ?? v) : v;
    case 'people':
      return Array.isArray(v) ? v.map((id) => members.get(id)?.name ?? id) : v;
    default:
      return v;
  }
}

export function ticketInfo(
  t: Ticket & { id: string },
  board: Board,
  members: ReadonlyMap<string, MemberInfo>,
): TicketInfo {
  const stage = board.stages.find((s) => s.id === t.stageId);
  const pri = t.priorityId ? board.priorities.find((p) => p.id === t.priorityId) : null;
  const fields: Record<string, unknown> = {};
  for (const f of board.fields)
    if (!f.archived) fields[f.name] = readableValue(f, t.fields?.[f.id], members);
  const unknownMember = (id: string): MemberInfo => ({
    id,
    kind: id.startsWith('ag_') ? 'agent' : 'user',
    name: id,
    email: '',
    role: '',
  });
  return {
    id: t.id,
    key: t.key,
    title: t.title,
    description: t.description?.text ?? '',
    stage: stage
      ? { ...opt(stage), category: stage.category, description: stage.description ?? null }
      : null,
    priority: pri ? opt(pri) : null,
    tags: t.tagIds.flatMap((id) => {
      const tag = board.tags.find((x) => x.id === id);
      return tag ? [opt(tag)] : [];
    }),
    assignees: t.assigneeUids.map((id) => members.get(id) ?? unknownMember(id)),
    reporter: { id: t.reporter?.uid ?? null, name: t.reporter?.name ?? '' },
    state: t.state,
    dueAt: t.dueAt,
    dueAllDay: t.dueAllDay,
    startAt: t.startAt,
    estimate: t.estimate,
    fields,
    fieldValues: { ...(t.fields ?? {}) },
    counts: { messages: t.counts?.messages ?? 0, files: t.counts?.files ?? 0 },
    tasks: t.tasklistProgress ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    completedAt: t.completedAt,
  };
}
