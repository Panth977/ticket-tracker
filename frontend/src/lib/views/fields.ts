/**
 * The field catalogue a board offers to its views: every built-in the view
 * engine understands (@tm/shared logic/view › accessor) plus the board's own
 * custom fields, each with what the UI may do with it (filter / sort / group /
 * show as a column / plot on a calendar).
 *
 * Keys are the engine's keys: 'stage', 'due', … and `fields.${FieldDef.id}`.
 */
import type { Board, Cmp, FieldDef, FieldType, Option } from '@tm/shared';

/** How a field's values behave in the UI (editors, filter operands, grouping). */
export type FieldKind =
  | 'stage'
  | 'priority'
  | 'tags'
  | 'assignees'
  | 'select'
  | 'multiSelect'
  | 'person'
  | 'people'
  | 'date'
  | 'number'
  | 'text'
  | 'checkbox'
  | 'state'
  | 'relation'
  | 'readonly';

export interface FieldInfo {
  /** The engine key ('stage', 'fields.f_abc123'). */
  key: string;
  label: string;
  kind: FieldKind;
  /** Custom fields only. */
  def?: FieldDef;
  /** Option-valued fields, in board order. */
  options?: Option[];
  filterable: boolean;
  sortable: boolean;
  /** Kanban columns / swimlanes: select or person-like fields (spec: "any select / person field"). */
  groupable: boolean;
  /** Calendar / timeline anchor. */
  dateLike: boolean;
  /** Table column. */
  column: boolean;
  /** Editable inline (table cell, requires prompt). */
  editable: boolean;
}

type BoardShape = Pick<Board, 'stages' | 'priorities' | 'tags' | 'fields'>;

const byPos = <X extends { position: number }>(xs: readonly X[]) =>
  [...xs].sort((a, b) => a.position - b.position);

const base = (over: Partial<FieldInfo> & Pick<FieldInfo, 'key' | 'label' | 'kind'>): FieldInfo => ({
  filterable: true,
  sortable: true,
  groupable: false,
  dateLike: false,
  column: true,
  editable: false,
  ...over,
});

const KIND_OF_TYPE: Record<FieldType, FieldKind> = {
  text: 'text',
  longText: 'text',
  url: 'text',
  email: 'text',
  phone: 'text',
  number: 'number',
  currency: 'number',
  percent: 'number',
  rating: 'number',
  formula: 'readonly',
  select: 'select',
  multiSelect: 'multiSelect',
  checkbox: 'checkbox',
  date: 'date',
  dateRange: 'date',
  person: 'person',
  people: 'people',
  ticketRelation: 'relation',
};

export function customFieldInfo(def: FieldDef): FieldInfo {
  const kind = KIND_OF_TYPE[def.type];
  return base({
    key: `fields.${def.id}`,
    label: def.name,
    kind,
    def,
    options: def.options ? byPos(def.options) : undefined,
    groupable:
      kind === 'select' ||
      kind === 'multiSelect' ||
      kind === 'person' ||
      kind === 'people' ||
      kind === 'checkbox',
    dateLike: kind === 'date',
    sortable: kind !== 'relation',
    editable: kind !== 'readonly' && kind !== 'relation',
  });
}

/** Every field of this board, built-ins first, then custom fields by position (archived ones left out). */
export function boardFields(board: BoardShape): FieldInfo[] {
  const builtIn: FieldInfo[] = [
    base({ key: 'title', label: 'Title', kind: 'text', filterable: false, editable: true }),
    base({ key: 'key', label: 'Key', kind: 'readonly', filterable: false }),
    base({
      key: 'stage',
      label: 'Stage',
      kind: 'stage',
      options: byPos(board.stages),
      groupable: true,
      editable: true,
    }),
    base({
      key: 'priority',
      label: 'Priority',
      kind: 'priority',
      options: byPos(board.priorities),
      groupable: true,
      editable: true,
    }),
    base({
      key: 'assignee',
      label: 'Assignee',
      kind: 'assignees',
      groupable: true,
      editable: true,
    }),
    base({
      key: 'tag',
      label: 'Tags',
      kind: 'tags',
      options: byPos(board.tags),
      groupable: true,
      editable: true,
    }),
    base({ key: 'due', label: 'Due', kind: 'date', dateLike: true, editable: true }),
    base({
      key: 'start',
      label: 'Start',
      kind: 'date',
      dateLike: true,
      filterable: false,
      editable: true,
    }),
    base({ key: 'estimate', label: 'Estimate', kind: 'number', filterable: false, editable: true }),
    base({ key: 'createdBy', label: 'Created by', kind: 'person', groupable: true }),
    base({ key: 'createdAt', label: 'Created', kind: 'date', filterable: false }),
    base({ key: 'updatedAt', label: 'Updated', kind: 'date', filterable: false }),
    base({ key: 'state', label: 'State', kind: 'state', column: false, sortable: false }),
    base({ key: 'text', label: 'Text', kind: 'text', sortable: false, column: false }),
    base({ key: 'linked', label: 'Linked to', kind: 'relation', sortable: false, column: false }),
  ];
  const custom = byPos(board.fields.filter((f) => !f.archived)).map(customFieldInfo);
  return [...builtIn, ...custom];
}

export function fieldInfo(
  board: BoardShape,
  key: string | null | undefined,
): FieldInfo | undefined {
  if (!key) return undefined;
  if (key.startsWith('fields.')) {
    const def = board.fields.find((f) => `fields.${f.id}` === key);
    return def ? customFieldInfo(def) : undefined;
  }
  return boardFields(board).find((f) => f.key === key);
}

// ───────────────────────── filter operators ─────────────────────────

export const CMP_LABEL: Record<Cmp, string> = {
  is: 'is',
  isNot: 'is not',
  in: 'is any of',
  notIn: 'is none of',
  contains: 'contains',
  empty: 'is empty',
  notEmpty: 'is not empty',
  lt: 'less than',
  gt: 'greater than',
  between: 'between',
  before: 'before',
  after: 'after',
};

/** The comparators that make sense for a kind, the default first. */
export function cmpsFor(kind: FieldKind): Cmp[] {
  switch (kind) {
    case 'stage':
    case 'priority':
    case 'select':
    case 'state':
      return ['in', 'notIn', 'empty', 'notEmpty'];
    case 'tags':
    case 'multiSelect':
      return ['in', 'contains', 'notIn', 'empty', 'notEmpty'];
    case 'assignees':
    case 'people':
    case 'person':
      return ['in', 'notIn', 'empty', 'notEmpty'];
    case 'date':
      return ['is', 'before', 'after', 'between', 'empty', 'notEmpty'];
    case 'number':
    case 'readonly':
      return ['is', 'lt', 'gt', 'between', 'empty', 'notEmpty'];
    case 'checkbox':
      return ['notEmpty', 'empty'];
    case 'relation':
      return ['notEmpty', 'empty'];
    case 'text':
      return ['contains', 'is', 'isNot', 'empty', 'notEmpty'];
  }
}

/** Comparators that take no operand. */
export const NO_VALUE_CMPS: readonly Cmp[] = ['empty', 'notEmpty'];

/** A fresh operand for a comparator (so switching cmp never leaves a nonsense value). */
export function defaultValue(kind: FieldKind, cmp: Cmp): unknown {
  if (NO_VALUE_CMPS.includes(cmp)) return undefined;
  if (cmp === 'between') return kind === 'date' ? ['today', 'thisWeek'] : [0, 10];
  switch (kind) {
    case 'date':
      return 'today';
    case 'number':
    case 'readonly':
      return 0;
    case 'text':
      return '';
    case 'assignees':
    case 'people':
    case 'person':
      return ['me'];
    default:
      return [];
  }
}

export const STATE_OPTIONS: Option[] = [
  { id: 'active', name: 'Active', position: 0 },
  { id: 'archived', name: 'Archived', position: 1 },
];
