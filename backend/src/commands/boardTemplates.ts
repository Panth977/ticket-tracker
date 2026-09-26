/**
 * What a new board starts with (boardCreate). The chips on /new-board —
 * Blank · Kanban · Bug tracker · Support desk · Sprint · Copy a board — map
 * to BOARD_TEMPLATES; copying a board is handled in boardCreate itself.
 *
 * Stage names are the board's own words; the CATEGORY is what the system
 * reads (My Work, done counts, completedAt), so every template maps each
 * stage to one.
 */
import type {
  BoardSettings,
  FieldDef,
  FieldType,
  IdGen,
  Option,
  Stage,
  StageCategory,
  View,
} from '@tm/shared';

type Named = 'blank' | 'kanban' | 'bugs' | 'support' | 'sprint';

export interface BoardSeed {
  stages: Stage[];
  priorities: Option[];
  tags: Option[];
  fields: FieldDef[];
  settings: BoardSettings;
}

type StageSpec = [name: string, category: StageCategory, color: string];
type FieldSpec = [name: string, type: FieldType, options?: string[]];

const STAGES: Record<Named, StageSpec[]> = {
  blank: [
    ['To do', 'todo', 'slate'],
    ['In progress', 'active', 'blue'],
    ['Done', 'done', 'green'],
  ],
  kanban: [
    ['Backlog', 'backlog', 'gray'],
    ['To do', 'todo', 'slate'],
    ['In progress', 'active', 'blue'],
    ['Review', 'active', 'violet'],
    ['Done', 'done', 'green'],
  ],
  bugs: [
    ['Triage', 'backlog', 'gray'],
    ['Confirmed', 'todo', 'orange'],
    ['In progress', 'active', 'blue'],
    ['QA', 'active', 'violet'],
    ['Fixed', 'done', 'green'],
    ["Won't fix", 'cancelled', 'slate'],
  ],
  support: [
    ['New', 'todo', 'blue'],
    ['In progress', 'active', 'amber'],
    ['Waiting on customer', 'active', 'violet'],
    ['Resolved', 'done', 'green'],
    ['Closed', 'cancelled', 'slate'],
  ],
  sprint: [
    ['Backlog', 'backlog', 'gray'],
    ['Sprint', 'todo', 'slate'],
    ['In progress', 'active', 'blue'],
    ['Review', 'active', 'violet'],
    ['Done', 'done', 'green'],
  ],
};

const PRIORITIES: [string, string][] = [
  ['Urgent', 'red'],
  ['High', 'orange'],
  ['Medium', 'amber'],
  ['Low', 'slate'],
];

const TAGS: Record<Named, string[]> = {
  blank: [],
  kanban: [],
  bugs: ['bug', 'regression', 'crash'],
  support: ['question', 'billing', 'feature request'],
  sprint: ['feature', 'bug', 'chore'],
};

const FIELDS: Record<Named, FieldSpec[]> = {
  blank: [],
  kanban: [],
  bugs: [
    ['Severity', 'select', ['S1 — critical', 'S2 — major', 'S3 — minor', 'S4 — trivial']],
    ['Environment', 'select', ['Production', 'Staging', 'Local']],
    ['Version', 'text'],
  ],
  support: [
    ['Customer', 'text'],
    ['Customer email', 'email'],
    ['Channel', 'select', ['Email', 'Chat', 'Phone']],
  ],
  sprint: [['Story points', 'number']],
};

/** 'f_' + 6 chars of [a-z0-9] (FIELD_ID_RE). */
export function fieldId(ids: IdGen): string {
  const raw = (ids.shortId() + ids.shortId()).toLowerCase().replace(/[^a-z0-9]/g, '');
  return `f_${(raw + '000000').slice(0, 6)}`;
}

export const DEFAULT_SETTINGS: BoardSettings = {
  allowDelete: false,
  emailReplies: true,
  autoArchiveDoneAfterDays: null,
  editorsCanInvite: false,
};

export function seedFor(template: Named, ids: IdGen): BoardSeed {
  const opt = (name: string, position: number, color?: string): Option => ({
    id: ids.shortId(),
    name,
    position,
    ...(color ? { color } : {}),
  });
  return {
    stages: STAGES[template].map(([name, category, color], i) => ({
      id: ids.shortId(),
      name,
      category,
      color,
      position: i,
    })),
    priorities: PRIORITIES.map(([n, c], i) => opt(n, i, c)),
    tags: TAGS[template].map((n, i) => opt(n, i)),
    fields: FIELDS[template].map(([name, type, options], i) => ({
      id: fieldId(ids),
      name,
      type,
      position: i,
      ...(options ? { options: options.map((o, j) => opt(o, j)) } : {}),
    })),
    settings: { ...DEFAULT_SETTINGS },
  };
}

const baseView = (ownerUid: string): Omit<View, 'name' | 'type' | 'position'> => ({
  scope: 'shared',
  ownerUid,
  filter: null,
  sort: [],
  groupBy: null,
  subGroupBy: null,
  columns: [],
  dateField: null,
  endDateField: null,
  cardFields: ['priority', 'assignee', 'due'],
  includeStates: ['active'],
});

/**
 * Default views: Board (kanban by stage — the default), Table, Calendar, Mine.
 * `extraCardFields` are fields a template wants on its cards.
 */
export function defaultViews(ownerUid: string, fields: FieldDef[]): { key: string; view: View }[] {
  const b = baseView(ownerUid);
  const cols = [
    { field: 'key', width: 90 },
    { field: 'title', width: 360 },
    { field: 'stage', width: 140 },
    { field: 'priority', width: 110 },
    { field: 'assignee', width: 160 },
    { field: 'due', width: 120 },
    ...fields.filter((f) => !f.archived).map((f) => ({ field: `fields.${f.id}`, width: 140 })),
  ];
  return [
    {
      key: 'board',
      view: {
        ...b,
        name: 'Board',
        type: 'kanban',
        position: 0,
        groupBy: 'stage',
        sort: [{ field: 'rank', dir: 'asc' }],
      },
    },
    {
      key: 'table',
      view: {
        ...b,
        name: 'Table',
        type: 'table',
        position: 1,
        columns: cols,
        sort: [{ field: 'updatedAt', dir: 'desc' }],
      },
    },
    {
      key: 'calendar',
      view: { ...b, name: 'Calendar', type: 'calendar', position: 2, dateField: 'due' },
    },
    {
      key: 'mine',
      view: {
        ...b,
        name: 'Mine',
        type: 'kanban',
        position: 3,
        groupBy: 'stage',
        sort: [{ field: 'rank', dir: 'asc' }],
        filter: { field: 'assignee', cmp: 'is', value: 'me' },
      },
    },
  ];
}
