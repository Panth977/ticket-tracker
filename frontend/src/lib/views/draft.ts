/**
 * View drafts — what the View bar edits before 'Save view'.
 *
 * A draft is a ViewInput (the View minus ownerUid, exactly what viewSave takes).
 * The board screen keeps one draft per open view; the ● on a tab means
 * `!sameView(draft, saved)`. Drafts survive switching tabs (module-level map)
 * but not a reload — an unsaved view is a scratchpad, not a document.
 */
import type { Board, View, ViewInput, ViewType } from '@tm/shared';
import { normalize } from './filter';

type ViewColumn = View['columns'][number];

export const VIEW_TYPE_LABEL: Record<ViewType, string> = {
  kanban: 'Board',
  table: 'Table',
  calendar: 'Calendar',
  timeline: 'Timeline',
};

/** The table's columns when a view has none saved yet. */
export const DEFAULT_COLUMNS: ViewColumn[] = [
  { field: 'key', width: 90 },
  { field: 'title', width: 320 },
  { field: 'stage', width: 140 },
  { field: 'priority', width: 110 },
  { field: 'assignee', width: 160 },
  { field: 'due', width: 120 },
];

/** Card fields shown by default on a kanban card. */
export const DEFAULT_CARD_FIELDS = ['priority', 'tag', 'assignee', 'due'];

/** Sensible defaults per view type — used for '+ View' and when switching a draft's type. */
export function defaultsFor(
  type: ViewType,
): Pick<ViewInput, 'groupBy' | 'subGroupBy' | 'dateField' | 'endDateField'> {
  switch (type) {
    case 'kanban':
      return { groupBy: 'stage', subGroupBy: null, dateField: null, endDateField: null };
    case 'table':
      return { groupBy: null, subGroupBy: null, dateField: null, endDateField: null };
    case 'calendar':
      return { groupBy: null, subGroupBy: null, dateField: 'due', endDateField: null };
    case 'timeline':
      return { groupBy: null, subGroupBy: null, dateField: 'start', endDateField: 'due' };
  }
}

export function newViewInput(
  type: ViewType,
  opts: { name?: string; scope?: 'shared' | 'personal'; position?: number } = {},
): ViewInput {
  return {
    name: opts.name ?? VIEW_TYPE_LABEL[type],
    type,
    scope: opts.scope ?? 'personal',
    position: opts.position ?? Date.now(),
    filter: null,
    sort: [],
    ...defaultsFor(type),
    columns: type === 'table' ? DEFAULT_COLUMNS.map((c) => ({ ...c })) : [],
    cardFields: [...DEFAULT_CARD_FIELDS],
    includeStates: ['active'],
  };
}

/** A stored View → the editable input (drops ownerUid / id, fills gaps from older docs). */
export function toInput(v: View | (View & { id: string })): ViewInput {
  return {
    name: v.name,
    type: v.type,
    scope: v.scope,
    position: v.position,
    filter: v.filter ?? null,
    sort: v.sort ?? [],
    groupBy: v.groupBy ?? null,
    subGroupBy: v.subGroupBy ?? null,
    columns: v.columns ?? [],
    dateField: v.dateField ?? null,
    endDateField: v.endDateField ?? null,
    cardFields: v.cardFields ?? [...DEFAULT_CARD_FIELDS],
    includeStates: v.includeStates?.length ? v.includeStates : ['active'],
  };
}

/** What a view looks like when the board has no saved views yet (brand-new board, or still loading). */
export function fallbackView(
  board: Pick<Board, 'defaultViewId'> | null,
): ViewInput & { id: string } {
  return {
    id: board?.defaultViewId ?? 'default',
    ...newViewInput('kanban', { name: 'Board', scope: 'shared', position: 0 }),
  };
}

/** Stable JSON: object keys sorted, so key order never makes a draft look dirty. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The parts of a view the ● compares (name / scope / position are edited through Save as…, not the bar). */
function comparable(v: ViewInput) {
  return {
    type: v.type,
    filter: normalize(v.filter),
    sort: v.sort,
    groupBy: v.groupBy ?? null,
    subGroupBy: v.subGroupBy ?? null,
    columns: v.columns,
    dateField: v.dateField ?? null,
    endDateField: v.endDateField ?? null,
    cardFields: v.cardFields,
    includeStates: [...v.includeStates].sort(),
  };
}

export function sameView(a: ViewInput, b: ViewInput): boolean {
  return stable(comparable(a)) === stable(comparable(b));
}

/** Drafts by `${boardId}/${viewId}` — kept while the SPA is open. */
const drafts = new Map<string, ViewInput>();
export const draftKey = (boardId: string, viewId: string) => `${boardId}/${viewId}`;
export const getDraft = (key: string) => drafts.get(key);
export const setDraft = (key: string, d: ViewInput) => void drafts.set(key, d);
export const clearDraft = (key: string) => void drafts.delete(key);

/** Switch a draft's type, keeping its filter / sort and adopting the new type's defaults for the rest. */
export function withType(d: ViewInput, type: ViewType): ViewInput {
  if (d.type === type) return d;
  const defs = defaultsFor(type);
  return {
    ...d,
    type,
    groupBy: type === 'kanban' ? (d.groupBy ?? defs.groupBy) : type === 'table' ? d.groupBy : null,
    subGroupBy: type === 'kanban' ? d.subGroupBy : null,
    dateField:
      type === 'calendar' || type === 'timeline' ? (d.dateField ?? defs.dateField) : d.dateField,
    endDateField: type === 'timeline' ? (d.endDateField ?? defs.endDateField) : d.endDateField,
    columns:
      type === 'table' && d.columns.length === 0
        ? DEFAULT_COLUMNS.map((c) => ({ ...c }))
        : d.columns,
  };
}

/** The table's visible columns (saved layout, or the defaults). */
export function visibleColumns(d: Pick<ViewInput, 'columns'>): ViewColumn[] {
  const cols = d.columns.length ? d.columns : DEFAULT_COLUMNS;
  return cols.filter((c) => !c.hidden);
}
