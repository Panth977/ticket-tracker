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

/** Filter values: plain JSON the page keeps per person and board. */
export const ScriptFiltersSchema = z.record(z.string().max(80), z.unknown());
export type ScriptFilters = z.infer<typeof ScriptFiltersSchema>;

// ───────────────────────── the default script ─────────────────────────

/** What every new board starts with (boardCreate saves it): Assignees, and an "Only mine" filter. */
export const DEFAULT_BOARD_SCRIPT = `// The board script: this board's ticket fields and filters.
// Stage is drawn by the app above these fields. Every hook and every ui.* / this.api.*
// call takes ONE object of named arguments. Docs: /integrate#10-board-script
export default class BoardScript {
  // The filter values a person starts with.
  filters() {
    return { mine: false, assignee: [] };
  }

  // The controls above the board. Changing one calls onFilter for every ticket again.
  filterRender({ filters }) {
    return [
      ui.toggle({ id: 'mine', label: 'Only mine', value: filters.mine }),
      ui.people({ id: 'assignee', label: 'Assignee', value: filters.assignee }),
    ];
  }

  // Runs for every ticket, even when no filter is set: true = show it.
  onFilter({ ticket, filters, me }) {
    if (filters.mine && !ticket.assigneeUids.includes(me.id)) return false;
    if (filters.assignee.length && !filters.assignee.some((u) => ticket.assigneeUids.includes(u)))
      return false;
    return true;
  }

  // The ticket's fields, under Stage.
  fieldRender({ ticket }) {
    return [
      ui.people({ id: 'assignees', label: 'Assignees', value: ticket.assigneeUids, commitments: true }),
    ];
  }

  // One field changed (text: on blur or Enter). Return the ticket patch to write.
  onFieldChange({ id, value }) {
    if (id === 'assignees') return { assigneeUids: value };
  }
}
`;

// ───────────────────────── a script for an existing board ─────────────────────────

/** The board settings a generated script needs (a Board satisfies it). */
export interface ScriptBoardShape {
  priorities: readonly { id: string }[];
  tags: readonly { id: string }[];
  fields: readonly {
    id: string;
    name: string;
    type: string;
    archived?: boolean;
    required?: boolean;
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

const js = (s: string) => JSON.stringify(s);

/**
 * The script for a board that existed before board scripts: the same fields
 * its Details pane showed (priority, assignees with commitments, start, due,
 * estimate, tags, its settings-defined fields), and filters for the same
 * things. Options are read from the board at run time, so renaming a
 * priority or adding a tag needs no code change.
 */
export function generateBoardScript(board: ScriptBoardShape): string {
  const custom = board.fields.filter((f) => !f.archived && CONTROL_OF[f.type]);
  const skipped = board.fields.filter((f) => !f.archived && !CONTROL_OF[f.type]);
  const fieldLines = custom.map((f) => {
    const c = CONTROL_OF[f.type]!;
    const base = `id: ${js(f.id)}, label: ${js(f.name)}, value: ticket.fields[${js(f.id)}]${f.required ? ', required: true' : ''}`;
    switch (c) {
      case 'select':
        return `      ui.select({ ${base}, options: optionsOf({ board, id: ${js(f.id)} }), clearable: true }),`;
      case 'multiSelect':
        return `      ui.multiSelect({ ${base}, options: optionsOf({ board, id: ${js(f.id)} }) }),`;
      case 'person':
        return `      ui.people({ ${base}, multiple: false }),`;
      case 'people':
        return `      ui.people({ ${base} }),`;
      default:
        return `      ui.${c}({ ${base} }),`;
    }
  });
  const hasPriorities = board.priorities.length > 0;
  const hasTags = board.tags.length > 0;
  return `// The board script: this board's ticket fields and filters.
// Generated from the board's settings when board scripts arrived (ORCH-35), so the
// ticket shows what it showed before. Edit freely: delete what this board does not use.
// Stage is drawn by the app above these fields. Every hook and every ui.* / this.api.*
// call takes ONE object of named arguments. Docs: /integrate#10-board-script

/** A settings-defined field's options, as ui.select / ui.multiSelect take them. */
const optionsOf = ({ board, id }) =>
  (board.fields.find((f) => f.id === id)?.options ?? []).map((o) => ({ value: o.id, label: o.name, color: o.color }));
const named = (list) => list.map((x) => ({ value: x.id, label: x.name, color: x.color }));

export default class BoardScript {
  filters() {
    return { mine: false, assignee: [], priority: null, tags: [] };
  }

  filterRender({ filters, board }) {
    return [
      ui.toggle({ id: 'mine', label: 'Only mine', value: filters.mine }),
      ui.people({ id: 'assignee', label: 'Assignee', value: filters.assignee }),
${hasPriorities ? "      ui.select({ id: 'priority', label: 'Priority', value: filters.priority, options: named(board.priorities), clearable: true }),\n" : ''}${hasTags ? "      ui.multiSelect({ id: 'tags', label: 'Tags', value: filters.tags, options: named(board.tags) }),\n" : ''}    ];
  }

  onFilter({ ticket, filters, me }) {
    if (filters.mine && !ticket.assigneeUids.includes(me.id)) return false;
    if (filters.assignee.length && !filters.assignee.some((u) => ticket.assigneeUids.includes(u)))
      return false;
    if (filters.priority && ticket.priorityId !== filters.priority) return false;
    if (filters.tags.length && !filters.tags.some((t) => ticket.tagIds.includes(t))) return false;
    return true;
  }

  fieldRender({ ticket, board }) {
    return [
${hasPriorities ? "      ui.select({ id: 'priority', label: 'Priority', value: ticket.priorityId, options: named(board.priorities), clearable: true }),\n" : ''}      ui.people({ id: 'assignees', label: 'Assignees', value: ticket.assigneeUids, commitments: true }),
      ui.date({ id: 'start', label: 'Start', value: ticket.startAt }),
      ui.date({ id: 'due', label: 'Due', value: ticket.dueAt, withTime: true, allDay: ticket.dueAllDay }),
      ui.number({ id: 'estimate', label: 'Estimate', value: ticket.estimate, min: 0 }),
${hasTags ? "      ui.multiSelect({ id: 'tags', label: 'Tags', value: ticket.tagIds, options: named(board.tags) }),\n" : ''}${fieldLines.length ? fieldLines.join('\n') + '\n' : ''}${skipped.length ? `      // Not drawn (no ui control for their type): ${skipped.map((f) => `${f.name} (${f.type})`).join(', ')}\n` : ''}    ];
  }

  onFieldChange({ id, value, allDay }) {
    switch (id) {
      case 'priority': return { priorityId: value };
      case 'assignees': return { assigneeUids: value };
      case 'start': return { startAt: value };
      case 'due': return { dueAt: value, dueAllDay: allDay };
      case 'estimate': return { estimate: value };
      case 'tags': return { tagIds: value };
      default: return { fields: { [id]: value } };
    }
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
