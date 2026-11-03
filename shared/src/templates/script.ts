/**
 * THE BOARD SCRIPT (docs/plan/board-script.html) — a board's own code for its
 * ticket fields, its filters and (optionally) its sort. Stage is never in it:
 * the app draws Stage itself, above whatever the script draws.
 *
 *   export default class BoardScript {
 *     filters()                                → the filter values a person starts with
 *     filterRender({ filters, me, board })     → controls above the board (ui.*)
 *     onFilter({ ticket, filters, me, board }) → true = show (runs with no filter set, too)
 *     onSort({ a, b, filters, me, board })     → a number, like Array.sort (optional)
 *     fieldRender({ ticket, me, board })       → the ticket's controls (ui.*)
 *     onFieldChange({ ticket, id, value, allDay, me, board }) → a ticket patch, or nothing
 *   }
 *
 * Every hook takes ONE object of named arguments; so does every `ui.*` control
 * and every `this.api.*` call. It runs in the template worker (§B of
 * templates.html): an opaque-origin Worker, as the person looking. It runs in
 * the BROWSER only — the REST API, MCP agents and the orch write tickets
 * without it (Panth, 2026-11-03: browser only for v1; per-ticket visibility later).
 *
 * This file is the wire shapes (checked in the page before anything is drawn
 * or written), the default script a new board is created with, and the script generated
 * for a board that existed before scripts did (its priority, dates, estimate,
 * tags and settings-defined fields, so nothing it showed disappears).
 */
import { z } from 'zod';
import { FieldValueSchema } from '../types/board.js';

// ───────────────────────── controls ─────────────────────────

export const SCRIPT_CONTROL_TYPES = [
  'text',
  'longText',
  'number',
  'toggle',
  'select',
  'multiSelect',
  'people',
  'date',
  'dateRange',
  'note',
] as const;
export type ScriptControlType = (typeof SCRIPT_CONTROL_TYPES)[number];

export const ScriptOptionSchema = z.object({
  value: z.string().max(200),
  label: z.string().max(200),
  color: z.string().max(40).nullable().optional(),
});
export type ScriptOption = z.infer<typeof ScriptOptionSchema>;

/** One control as `ui.*` builds it. The app draws it; the script never touches the DOM. */
export const ScriptControlSchema = z.object({
  type: z.enum(SCRIPT_CONTROL_TYPES),
  /** What onFieldChange / filters get it back as. Absent only on a note. */
  id: z.string().min(1).max(80).optional(),
  label: z.string().max(200).optional(),
  value: z.unknown().optional(),
  disabled: z.boolean().optional(),
  hidden: z.boolean().optional(),
  required: z.boolean().optional(),
  help: z.string().max(500).optional(),
  placeholder: z.string().max(200).optional(),
  /** select / multiSelect; people: the uids to offer (default: the board's members). */
  options: z.array(ScriptOptionSchema).max(500).optional(),
  people: z.array(z.string().max(80)).max(500).optional(),
  /** people: several (default) or one. */
  multiple: z.boolean().optional(),
  /** select: offer "none". */
  clearable: z.boolean().optional(),
  /** people: each assignee's commitment date, edited in place (writes ticket.commitments). */
  commitments: z.boolean().optional(),
  /** date: with a time of day (default false); the all-day flag of a date with time. */
  withTime: z.boolean().optional(),
  allDay: z.boolean().optional(),
  /** number */
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  /** note: Markdown shown as is. */
  text: z.string().max(5000).optional(),
  tone: z.enum(['default', 'subtle', 'warning', 'danger', 'success']).optional(),
});
export type ScriptControl = z.infer<typeof ScriptControlSchema>;
export const ScriptControlsSchema = z.array(ScriptControlSchema).max(100);

// ───────────────────────── what onFieldChange returns ─────────────────────────

/**
 * A ticket patch: the ticketUpdate fields a script may write. `fields` holds
 * settings-defined fields by id (`f_xxxxxx`) and the script's own values by a
 * key it chooses (SCRIPT_FIELD_KEY in types/board.ts).
 */
export const ScriptPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    assigneeUids: z.array(z.string().min(1).max(80)).max(100).optional(),
    priorityId: z.string().max(80).nullable().optional(),
    tagIds: z.array(z.string().max(80)).max(50).optional(),
    startAt: z.number().int().nonnegative().nullable().optional(),
    dueAt: z.number().int().nonnegative().nullable().optional(),
    dueAllDay: z.boolean().optional(),
    estimate: z.number().nonnegative().nullable().optional(),
    commitments: z.record(z.string().max(80), z.number().int().nonnegative().nullable()).optional(),
    fields: z.record(z.string().min(1).max(80), FieldValueSchema).optional(),
  })
  .strict();
export type ScriptPatch = z.infer<typeof ScriptPatchSchema>;
export const SCRIPT_PATCH_KEYS = Object.keys(ScriptPatchSchema.shape) as (keyof ScriptPatch)[];

// ───────────────────────── cards, table, bulk, forms, previews ─────────────────────────

/** previewTicketTable's columns. `open: true` makes the cell open the ticket. */
export const ScriptColumnSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().max(120),
  width: z.number().int().min(40).max(1200).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  open: z.boolean().optional(),
});
export type ScriptColumn = z.infer<typeof ScriptColumnSchema>;
export const ScriptColumnsSchema = z.array(ScriptColumnSchema).min(1).max(40);

/** onBulkChange: one patch for every selected ticket, or one per ticket id. */
export const ScriptBulkResultSchema = z.union([
  ScriptPatchSchema,
  z.object({ patches: z.record(z.string().min(1).max(80), ScriptPatchSchema) }).strict(),
]);
export type ScriptBulkResult = z.infer<typeof ScriptBulkResultSchema>;

/** forms(): the board's forms — message forms in the composer, ticket forms in New ticket. */
export const ScriptFormSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'Form ids are letters, digits, _ and -'),
  kind: z.enum(['message', 'ticket']),
  name: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
});
export type ScriptForm = z.infer<typeof ScriptFormSchema>;
export const ScriptFormsSchema = z.array(ScriptFormSchema).max(50);

/** A message posted by a script form keeps `template.id` = this prefix + the form id. */
export const SCRIPT_FORM_PREFIX = 'script-';

/** Filter values: plain JSON the page keeps per person and board. */
export const ScriptFiltersSchema = z.record(z.string().max(80), z.unknown());
export type ScriptFilters = z.infer<typeof ScriptFiltersSchema>;

// ───────────────────────── the default script ─────────────────────────

/** What every new board starts with (boardCreate saves it): every hook, ready to change. */
export const DEFAULT_BOARD_SCRIPT = `// Board script: everything about this board's tickets except Stage, as code.
// Every hook, ui.* control, h.* node and this.api.* call takes one object of named arguments.
// Docs: /integrate#10-board-script

export default class BoardScript {
  // ── Filter menu ──
  filters() {
    return { mine: false, assignee: [] };
  }

  filterRender({ filters: f }) {
    return [
      ui.toggle({ id: 'mine', label: 'Only mine', value: f.mine }),
      ui.people({ id: 'assignee', label: 'Assignee', value: f.assignee }),
    ];
  }

  // Runs for every ticket, even with no filter set: true = show it.
  onFilter({ ticket: t, filters: f, me }) {
    return (
      (!f.mine || t.assigneeUids.includes(me.id)) &&
      (!f.assignee.length || f.assignee.some((u) => t.assigneeUids.includes(u)))
    );
  }

  // ── The ticket's fields (under Stage) ──
  fieldRender({ ticket: t }) {
    return [
      ui.people({ id: 'assignees', label: 'Assignees', value: t.assigneeUids, commitments: true }),
    ];
  }

  // A field changed (text: on blur or Enter). Return the ticket patch to write.
  onFieldChange({ id, value }) {
    if (id === 'assignees') return { assigneeUids: value };
  }

  // ── Board view: one card ──
  // Without this hook the Board draws the app's own card (unread, questions, task lists,
  // blocked, assignees you can change in place). Uncomment to draw your own instead:
  // previewTicketCard({ ticket: t }) {
  //   return h.col({ gap: 1.5 },
  //     h.text({ size: 'xs', tone: 'subtle', mono: true }, t.key),
  //     h.text({ weight: 'medium' }, t.title),
  //     h.row({ gap: 1 }, ...t.assigneeUids.map((id) => h.person({ id, key: id, showName: false }))),
  //   );
  // }

  // ── Table view: columns, and each row's cells (text, h.* or an editable ui.* control) ──
  previewTicketTable({ tickets }) {
    return {
      columns: [
        { id: 'key', label: 'Key', width: 96 },
        { id: 'title', label: 'Title', width: 380, open: true },
        { id: 'stage', label: 'Stage', width: 140 },
        { id: 'assignees', label: 'Assignees', width: 220 },
        { id: 'updated', label: 'Updated', width: 140 },
      ],
      rows: tickets.map((t) => ({
        id: t.id,
        cells: {
          key: t.key,
          title: t.title,
          stage: t.stage?.name ?? '',
          // An editable cell: its change goes through onFieldChange, like the Details pane.
          assignees: ui.people({ id: 'assignees', value: t.assigneeUids }),
          updated: dates.format({ ms: t.updatedAt }),
        },
      })),
    };
  }

  // ── Bulk bar (rows selected in the Table) ──
  bulkRender() {
    return [ui.people({ id: 'addAssignees', label: 'Add assignees', value: [] })];
  }

  // One patch for every ticket, or { patches: { [ticketId]: patch } }.
  onBulkChange({ tickets, id, value }) {
    if (id === 'addAssignees')
      return {
        patches: Object.fromEntries(
          tickets.map((t) => [t.id, { assigneeUids: [...new Set([...t.assigneeUids, ...value])] }]),
        ),
      };
  }

  // ── Your own views: each becomes a tab next to Board and Table ──
  previews() {
    return {
      Calendar: ({ tickets, openTicket }) =>
        h.calendar({
          // Any date of yours works here: a ui.date field kept in t.fields, a due date…
          items: tickets.map((t) => ({ id: t.id, title: t.title, start: t.createdAt })),
          onOpen: ({ id }) => openTicket({ id }),
        }),
    };
  }

  // ── Forms: message forms (the composer's 📋) and ticket forms (New ticket) ──
  forms() {
    return [];
    // e.g. return [{ id: 'bug', kind: 'ticket', name: 'Bug report' }];
    // with formState / formRender / formSubmit({ id, state, … }) — see the docs.
  }
}
`;

// ───────────────────────── a script for an existing board ─────────────────────────

interface ScriptOptionSource {
  id: string;
  name: string;
  color?: string | null;
  position?: number;
}

/** The board settings a generated script is written from (a Board satisfies it). */
export interface ScriptBoardShape {
  priorities: readonly ScriptOptionSource[];
  tags: readonly ScriptOptionSource[];
  fields: readonly {
    id: string;
    name: string;
    type: string;
    archived?: boolean;
    required?: boolean;
    position?: number;
    options?: readonly ScriptOptionSource[];
  }[];
}

const CONTROL_OF: Record<string, string> = {
  text: 'text',
  url: 'text',
  email: 'text',
  phone: 'text',
  longText: 'longText',
  number: 'number',
  currency: 'number',
  percent: 'number',
  rating: 'number',
  checkbox: 'toggle',
  select: 'select',
  multiSelect: 'multiSelect',
  date: 'date',
  dateRange: 'dateRange',
  person: 'person',
  people: 'people',
};

/** A JavaScript string literal, single-quoted like the rest of the generated code. */
const js = (v: string) =>
  `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
/** `t.fields.f_abc` (or `t.fields['odd key']`). */
const fieldRef = (id: string) =>
  /^[A-Za-z_$][\w$]*$/.test(id) ? `t.fields.${id}` : `t.fields[${js(id)}]`;
const byPosition = <T extends { position?: number }>(xs: readonly T[]) =>
  [...xs].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

/** `const NAME = [ { value, label, color }, … ];` — one option per line. */
function optionList(name: string, list: readonly ScriptOptionSource[]): string {
  const rows = byPosition(list).map(
    (o) =>
      `  { value: ${js(o.id)}, label: ${js(o.name)}${o.color ? `, color: ${js(o.color)}` : ''} },`,
  );
  return `const ${name} = [\n${rows.join('\n')}\n];`;
}

/** 'Contract value' → 'CONTRACT_VALUE', unique among `taken`. */
function constName(label: string, taken: Set<string>): string {
  let base = label
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (!base || /^[0-9]/.test(base)) base = `FIELD_${base}`;
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${base}_${i}`;
  taken.add(n);
  return n;
}

/**
 * The script for a board that existed before board scripts: the fields its
 * Details pane showed (priority, assignees with commitments, start, due,
 * estimate, tags, its settings-defined fields) and filters for them. The
 * option lists are written INTO the code (Panth: "all is done from code") —
 * there are no Priorities or Tags settings pages any more.
 */
export function generateBoardScript(board: ScriptBoardShape): string {
  const taken = new Set(['PRIORITIES', 'TAGS']);
  const hasPriorities = board.priorities.length > 0;
  const hasTags = board.tags.length > 0;
  const lists: string[] = [];
  if (hasPriorities) lists.push(optionList('PRIORITIES', board.priorities));
  if (hasTags) lists.push(optionList('TAGS', board.tags));

  const live = byPosition(board.fields.filter((f) => !f.archived));
  const custom = live.filter((f) => CONTROL_OF[f.type]);
  const skipped = live.filter((f) => !CONTROL_OF[f.type]);
  const fieldLines = custom.map((f) => {
    const c = CONTROL_OF[f.type]!;
    const value = `${fieldRef(f.id)}${c === 'multiSelect' || c === 'people' ? ' ?? []' : ' ?? null'}`;
    const base = `id: ${js(f.id)}, label: ${js(f.name)}, value: ${value}${f.required ? ', required: true' : ''}`;
    if (c === 'select' || c === 'multiSelect') {
      const name = constName(f.name, taken);
      lists.push(optionList(name, f.options ?? []));
      return `      ui.${c}({ ${base}, options: ${name} }),`;
    }
    if (c === 'person') return `      ui.people({ ${base}, multiple: false }),`;
    return `      ui.${c}({ ${base} }),`;
  });

  const filterDefaults = ['mine: false', 'assignee: []'];
  const filterControls = [
    "      ui.toggle({ id: 'mine', label: 'Only mine', value: f.mine }),",
    "      ui.people({ id: 'assignee', label: 'Assignee', value: f.assignee }),",
  ];
  const filterTests = [
    '(!f.mine || t.assigneeUids.includes(me.id))',
    '(!f.assignee.length || f.assignee.some((u) => t.assigneeUids.includes(u)))',
  ];
  if (hasPriorities) {
    filterDefaults.push('priority: null');
    filterControls.push(
      "      ui.select({ id: 'priority', label: 'Priority', value: f.priority, options: PRIORITIES }),",
    );
    filterTests.push('(!f.priority || t.priorityId === f.priority)');
  }
  if (hasTags) {
    filterDefaults.push('tags: []');
    filterControls.push(
      "      ui.multiSelect({ id: 'tags', label: 'Tags', value: f.tags, options: TAGS }),",
    );
    filterTests.push('(!f.tags.length || f.tags.some((x) => t.tagIds.includes(x)))');
  }

  const fields = [
    hasPriorities &&
      "      ui.select({ id: 'priority', label: 'Priority', value: t.priorityId, options: PRIORITIES }),",
    "      ui.people({ id: 'assignees', label: 'Assignees', value: t.assigneeUids, commitments: true }),",
    "      ui.date({ id: 'start', label: 'Start', value: t.startAt }),",
    "      ui.date({ id: 'due', label: 'Due', value: t.dueAt, withTime: true, allDay: t.dueAllDay }),",
    "      ui.number({ id: 'estimate', label: 'Estimate', value: t.estimate, min: 0 }),",
    hasTags &&
      "      ui.multiSelect({ id: 'tags', label: 'Tags', value: t.tagIds, options: TAGS }),",
    ...fieldLines,
  ].filter(Boolean);

  const writes = [
    hasPriorities && "      case 'priority': return { priorityId: value };",
    "      case 'assignees': return { assigneeUids: value };",
    "      case 'start': return { startAt: value };",
    "      case 'due': return { dueAt: value, dueAllDay: allDay };",
    "      case 'estimate': return { estimate: value };",
    hasTags && "      case 'tags': return { tagIds: value };",
    '      default: return { fields: { [id]: value } }; // the custom fields, by id',
  ].filter(Boolean);

  return `// Board script: everything about this board's tickets except Stage, as code.
// Written from this board's old settings so its tickets show what they showed before;
// delete what the board does not use. Every hook, ui.* control and this.api.* call takes
// one object of named arguments. Docs: /integrate#10-board-script
${
  hasPriorities || hasTags
    ? `//
// The option lists are code now. priorityId / tagIds only take the values already here;
// for a new list, keep the value in the ticket's own fields: { fields: { severity: value } }.
`
    : ''
}${skipped.length ? `//\n// Not drawn (no control for the type): ${skipped.map((f) => `${f.name} (${f.type})`).join(', ')}.\n` : ''}
${lists.length ? lists.join('\n\n') + '\n\n' : ''}export default class BoardScript {
  filters() {
    return { ${filterDefaults.join(', ')} };
  }

  filterRender({ filters: f }) {
    return [
${filterControls.join('\n')}
    ];
  }

  onFilter({ ticket: t, filters: f, me }) {
    return (
${filterTests.map((x) => `      ${x}`).join(' &&\n')}
    );
  }

  fieldRender({ ticket: t }) {
    return [
${fields.join('\n')}
    ];
  }

  onFieldChange({ id, value, allDay }) {
    switch (id) {
${writes.join('\n')}
    }
  }

  // The Board draws the app's own card; previewTicketCard({ ticket }) would draw yours instead.

  previewTicketTable({ tickets }) {
    return {
      columns: [
        { id: 'key', label: 'Key', width: 96 },
        { id: 'title', label: 'Title', width: 360, open: true },
        { id: 'stage', label: 'Stage', width: 140 },
${hasPriorities ? "        { id: 'priority', label: 'Priority', width: 140 },\n" : ''}        { id: 'assignees', label: 'Assignees', width: 200 },
        { id: 'due', label: 'Due', width: 150 },
      ],
      rows: tickets.map((t) => ({
        id: t.id,
        cells: {
          key: t.key,
          title: t.title,
          stage: t.stage?.name ?? '',
${hasPriorities ? "          priority: ui.select({ id: 'priority', value: t.priorityId, options: PRIORITIES }),\n" : ''}          assignees: ui.people({ id: 'assignees', value: t.assigneeUids }),
          due: ui.date({ id: 'due', value: t.dueAt, withTime: true, allDay: t.dueAllDay }),
        },
      })),
    };
  }

  bulkRender() {
    return [
${hasPriorities ? "      ui.select({ id: 'priority', label: 'Priority', value: null, options: PRIORITIES }),\n" : ''}${hasTags ? "      ui.multiSelect({ id: 'addTags', label: 'Add tags', value: [], options: TAGS }),\n" : ''}      ui.people({ id: 'addAssignees', label: 'Add assignees', value: [] }),
      ui.date({ id: 'due', label: 'Due', value: null }),
    ];
  }

  onBulkChange({ tickets, id, value, allDay }) {
    const each = (fn) => ({ patches: Object.fromEntries(tickets.map((t) => [t.id, fn(t)])) });
    switch (id) {
${hasPriorities ? "      case 'priority': return { priorityId: value };\n" : ''}${hasTags ? "      case 'addTags': return each((t) => ({ tagIds: [...new Set([...t.tagIds, ...value])] }));\n" : ''}      case 'addAssignees': return each((t) => ({ assigneeUids: [...new Set([...t.assigneeUids, ...value])] }));
      case 'due': return { dueAt: value, dueAllDay: allDay ?? true };
    }
  }

  previews() {
    return {
      Calendar: ({ tickets, openTicket, updateTicket }) =>
        h.calendar({
          items: tickets.filter((t) => t.dueAt).map((t) => ({ id: t.id, title: t.title, start: t.dueAt })),
          onOpen: ({ id }) => openTicket({ id }),
          onMove: ({ id, start }) => updateTicket({ id, patch: { dueAt: start } }),
        }),
      Timeline: ({ tickets, openTicket, updateTicket }) =>
        h.timeline({
          items: tickets
            .filter((t) => t.startAt || t.dueAt)
            .map((t) => ({ id: t.id, title: t.title, start: t.startAt ?? t.dueAt, end: t.dueAt, group: t.stage?.name })),
          onOpen: ({ id }) => openTicket({ id }),
          onMove: ({ id, start, end }) => updateTicket({ id, patch: { startAt: start, dueAt: end } }),
        }),
    };
  }

  forms() {
    return [];
  }
}
`;
}

/**
 * The code a board runs: its saved script, else the one generated from its
 * settings. Every board created since board scripts has one saved (boardCreate
 * saves DEFAULT_BOARD_SCRIPT), so "none saved" means a board from before them.
 */
export function effectiveBoardScript(
  board: ScriptBoardShape,
  saved: { code: string } | null | undefined,
): { code: string; source: 'saved' | 'generated' } {
  if (saved?.code) return { code: saved.code, source: 'saved' };
  return { code: generateBoardScript(board), source: 'generated' };
}
