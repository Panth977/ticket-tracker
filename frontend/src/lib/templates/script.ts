/**
 * THE BOARD SCRIPT, PAGE SIDE (docs/plan/board-script.html) — one worker per
 * board (per version of its code), shared by the board screen and every open
 * ticket of that board. It answers:
 *
 *   host.defaults()                         → the filter values a person starts with
 *   host.filterControls({ filters })        → the controls above the board
 *   host.apply({ tickets, filters })        → which tickets show, and their order (onSort)
 *   host.fields({ ticket })                 → the ticket's controls (under Stage)
 *   host.change({ ticket, id, value, allDay }) → the ticket patch to write
 *
 * Everything the worker answers is checked here (ScriptControlsSchema,
 * ScriptPatchSchema) before it is drawn or written. The script runs as the
 * person looking, in the template sandbox; the server still checks every
 * write (ticketUpdate) the way it always does.
 */
import { readable, type Readable } from 'svelte/store';
import {
  effectiveBoardScript,
  paths,
  SCRIPT_TEMPLATE_ID,
  ScriptControlsSchema,
  ScriptFiltersSchema,
  ScriptPatchSchema,
  ScriptBulkResultSchema,
  ScriptColumnsSchema,
  ScriptFormsSchema,
  SCRIPT_FORM_PREFIX,
  type Board,
  type ScriptBulkResult,
  type ScriptColumn,
  type ScriptForm,
  type ScriptControl,
  type ScriptFilters,
  type ScriptPatch,
  type TemplateWithId,
  type Ticket,
} from '@tm/shared';
import { docStore } from '$lib/stores';
import { contextFor, createBridge } from './bridge';
import { TemplateWorker, type TemplateLog, type TemplateProblem } from './host';
import type { MemberInfo, TicketInfo } from './info';
import type { ScriptEntry, VSlot } from './protocol';

export interface ScriptMe {
  id: string;
  name: string;
  email: string;
  role: string;
}

/** What a script's hooks get as `ticket`: the template TicketInfo, with the stored ids and values. */
export type ScriptTicket = Omit<TicketInfo, 'fields'> & {
  stageId: string;
  assigneeUids: string[];
  priorityId: string | null;
  tagIds: string[];
  commitments: Record<string, number | null>;
  /** As stored: settings-defined fields by id (f_xxxxxx), the script's own by its key. */
  fields: Record<string, unknown>;
  /** Settings-defined fields by NAME, readable (option and member names). */
  fieldsByName: Record<string, unknown>;
};

type Raw = Ticket & { id: string };

/** One card: the static tree previewTicketCard drew, or its error. */
export type CardTree = { tree?: VSlot[]; error?: string; line?: number };
/** One table cell, as the worker sends it. */
export type ScriptCell =
  | { kind: 'text'; text: string }
  | { kind: 'tree'; tree: VSlot[] }
  | { kind: 'control'; control: ScriptControl };
export interface ScriptTable {
  columns: ScriptColumn[];
  /** ticket id → column id → cell */
  rows: Map<string, Record<string, ScriptCell>>;
}
type Outcome<T> =
  | { value: T; error?: undefined; line?: undefined }
  | { value?: undefined; error: string; line?: number };

const zodMessage = (e: { issues: { path: PropertyKey[]; message: string }[] }) =>
  e.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');

export class BoardScriptHost {
  private worker: TemplateWorker;
  private bridge: ReturnType<typeof createBridge>;
  private start: Promise<void>;
  problem: TemplateProblem | null = null;
  refs = 0;
  private applySeq = 0;

  constructor(
    readonly code: string,
    board: Board & { id: string },
    me: ScriptMe,
    o: { onLog?: (l: TemplateLog) => void; onError?: (p: TemplateProblem) => void } = {},
  ) {
    this.bridge = createBridge({ board, me, templateId: SCRIPT_TEMPLATE_ID });
    let w!: TemplateWorker;
    this.start = contextFor(this.bridge, { kind: 'script' }).then((ctx) => {
      w = new TemplateWorker({
        code,
        kind: 'script',
        ctx,
        bridge: this.bridge,
        onError: (p) => {
          this.problem = p;
          o.onError?.(p);
        },
        onLog: o.onLog,
      });
      this.worker = w;
      return w.ready;
    });
    this.start.catch(() => {});
    // Assigned when the context is ready; nothing calls the worker before `start`.
    this.worker = null as unknown as TemplateWorker;
  }

  /** The ticket as a script sees it. */
  async ticketOf(t: Raw): Promise<ScriptTicket> {
    const info = await this.bridge.infoOf(t);
    const { fields: byName, ...rest } = info;
    return {
      ...rest,
      stageId: t.stageId,
      assigneeUids: [...t.assigneeUids],
      priorityId: t.priorityId ?? null,
      tagIds: [...t.tagIds],
      commitments: { ...(t.commitments ?? {}) },
      fields: { ...(t.fields ?? {}) },
      fieldsByName: byName,
    };
  }

  private async call<T>(
    op: Parameters<TemplateWorker['script']>[0],
    args: unknown,
  ): Promise<Outcome<T>> {
    try {
      await this.start;
    } catch (e) {
      const p = (e as TemplateProblem) ?? this.problem;
      return { error: p?.message ?? 'The board script did not load', line: p?.line };
    }
    const r = await this.worker.script(op, args);
    if (r.error !== undefined) return { error: r.error, line: r.line };
    return { value: r.value as T };
  }

  async defaults(): Promise<Outcome<ScriptFilters>> {
    const r = await this.call<unknown>('filters', {});
    if (r.error !== undefined) return r;
    const p = ScriptFiltersSchema.safeParse(r.value ?? {});
    return p.success ? { value: p.data } : { error: `filters(): ${zodMessage(p.error)}` };
  }

  async filterControls({ filters }: { filters: ScriptFilters }): Promise<Outcome<ScriptControl[]>> {
    return this.controls(await this.call<unknown>('filterRender', { filters }), 'filterRender');
  }

  async fields({ ticket }: { ticket: Raw }): Promise<Outcome<ScriptControl[]>> {
    return this.controls(
      await this.call<unknown>('fieldRender', { ticket: await this.ticketOf(ticket) }),
      'fieldRender',
    );
  }

  private controls(r: Outcome<unknown>, hook: string): Outcome<ScriptControl[]> {
    if (r.error !== undefined) return r;
    const p = ScriptControlsSchema.safeParse(r.value ?? []);
    if (!p.success) return { error: `${hook}: ${zodMessage(p.error)}` };
    const ids = new Set<string>();
    for (const c of p.data) {
      if (!c.id) continue;
      if (ids.has(c.id)) return { error: `${hook}: two controls have the id "${c.id}"` };
      ids.add(c.id);
    }
    return { value: p.data };
  }

  /** What onFieldChange wants written; null = nothing. */
  async change(a: {
    ticket: Raw;
    id: string;
    value: unknown;
    allDay?: boolean;
  }): Promise<Outcome<ScriptPatch | null>> {
    const r = await this.call<unknown>('change', {
      ticket: await this.ticketOf(a.ticket),
      id: a.id,
      value: a.value,
      allDay: a.allDay,
    });
    if (r.error !== undefined) return r;
    if (r.value === null || r.value === undefined) return { value: null };
    const p = ScriptPatchSchema.safeParse(r.value);
    if (!p.success) return { error: `onFieldChange: ${zodMessage(p.error)}` };
    return { value: Object.keys(p.data).length ? p.data : null };
  }

  /**
   * onFilter for every ticket (and onSort, when the script has it), in one
   * message. A newer call supersedes an older one: the older answers `stale`.
   */
  async apply(a: {
    tickets: readonly Raw[];
    filters: ScriptFilters;
  }): Promise<Outcome<{ keep: Set<string>; order: string[] | null }> | { stale: true }> {
    const seq = ++this.applySeq;
    const tickets = await Promise.all(a.tickets.map((t) => this.ticketOf(t)));
    if (seq !== this.applySeq) return { stale: true };
    const r = await this.call<{ keep: string[]; order: string[] | null }>('apply', {
      tickets,
      filters: a.filters,
    });
    if (seq !== this.applySeq) return { stale: true };
    if (r.error !== undefined) return r;
    const v = r.value;
    return { value: { keep: new Set(v?.keep ?? []), order: v?.order ?? null } };
  }

  private cardCache = new Map<string, { stamp: number; r: CardTree }>();
  /** previewTicketCard for many tickets (cached per ticket version); null = the script has none. */
  async cards({
    tickets,
  }: {
    tickets: readonly Raw[];
  }): Promise<Outcome<Map<string, CardTree> | null>> {
    const out = new Map<string, CardTree>();
    const todo = tickets.filter((t) => {
      const hit = this.cardCache.get(t.id);
      if (hit && hit.stamp === t.updatedAt) {
        out.set(t.id, hit.r);
        return false;
      }
      return true;
    });
    if (!todo.length) return { value: out };
    const r = await this.call<Record<string, CardTree> | null>('cards', {
      tickets: await Promise.all(todo.map((t) => this.ticketOf(t))),
    });
    if (r.error !== undefined) return r;
    if (r.value === null) return { value: null };
    for (const t of todo) {
      const c = r.value?.[t.id] ?? { error: 'No card for this ticket' };
      this.cardCache.set(t.id, { stamp: t.updatedAt, r: c });
      out.set(t.id, c);
    }
    return { value: out };
  }

  /** previewTicketTable; null = the script has none. Controls in cells are checked. */
  async table({ tickets }: { tickets: readonly Raw[] }): Promise<Outcome<ScriptTable | null>> {
    const r = await this.call<{
      columns: unknown;
      rows: { id: string; cells: Record<string, ScriptCell> }[];
    } | null>('table', { tickets: await Promise.all(tickets.map((t) => this.ticketOf(t))) });
    if (r.error !== undefined) return r;
    if (r.value === null) return { value: null };
    const cols = ScriptColumnsSchema.safeParse(r.value.columns);
    if (!cols.success) return { error: `previewTicketTable columns: ${zodMessage(cols.error)}` };
    const rows = new Map<string, Record<string, ScriptCell>>();
    for (const row of r.value.rows) {
      for (const [k, c] of Object.entries(row.cells)) {
        if (c.kind !== 'control') continue;
        const p = ScriptControlsSchema.safeParse([c.control]);
        if (!p.success) return { error: `previewTicketTable cell ${k}: ${zodMessage(p.error)}` };
      }
      rows.set(row.id, row.cells);
    }
    return { value: { columns: cols.data, rows } };
  }

  async bulkControls({ tickets }: { tickets: readonly Raw[] }): Promise<Outcome<ScriptControl[]>> {
    return this.controls(
      await this.call<unknown>('bulkRender', {
        tickets: await Promise.all(tickets.map((t) => this.ticketOf(t))),
      }),
      'bulkRender',
    );
  }

  /** onBulkChange → one patch per ticket id (null = nothing to write). */
  async bulkChange(a: {
    tickets: readonly Raw[];
    id: string;
    value: unknown;
    allDay?: boolean;
  }): Promise<Outcome<Map<string, ScriptPatch> | null>> {
    const r = await this.call<unknown>('bulkChange', {
      tickets: await Promise.all(a.tickets.map((t) => this.ticketOf(t))),
      id: a.id,
      value: a.value,
      allDay: a.allDay,
    });
    if (r.error !== undefined) return r;
    if (r.value === null || r.value === undefined) return { value: null };
    const p = ScriptBulkResultSchema.safeParse(r.value);
    if (!p.success) return { error: `onBulkChange: ${zodMessage(p.error)}` };
    const v = p.data as ScriptBulkResult;
    const out = new Map<string, ScriptPatch>();
    if ('patches' in v) {
      const ids = new Set(a.tickets.map((t) => t.id));
      for (const [id, patch] of Object.entries(v.patches)) if (ids.has(id)) out.set(id, patch);
    } else for (const t of a.tickets) out.set(t.id, v);
    return { value: out };
  }

  async forms(): Promise<Outcome<ScriptForm[]>> {
    const r = await this.call<unknown>('forms', {});
    if (r.error !== undefined) return r;
    const p = ScriptFormsSchema.safeParse(r.value ?? []);
    return p.success ? { value: p.data } : { error: `forms(): ${zodMessage(p.error)}` };
  }

  async previewNames(): Promise<Outcome<string[]>> {
    const r = await this.call<string[]>('previewNames', {});
    if (r.error !== undefined) return r;
    return { value: (r.value ?? []).filter((n) => typeof n === 'string' && n.length <= 60) };
  }

  members(): Promise<MemberInfo[]> {
    return this.bridge.members() as Promise<MemberInfo[]>;
  }

  destroy() {
    this.worker?.destroy();
  }
}

// ── one host per board and code version, shared by the board screen and its tickets ──

const hosts = new Map<string, BoardScriptHost>();
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
};
const keyOf = (boardId: string, me: ScriptMe, code: string) =>
  `${boardId}:${me.id}:${me.role}:${hash(code)}`;

export function acquireScriptHost(
  code: string,
  board: Board & { id: string },
  me: ScriptMe,
): BoardScriptHost {
  const key = keyOf(board.id, me, code);
  let h = hosts.get(key);
  if (!h) {
    h = new BoardScriptHost(code, board, me);
    hosts.set(key, h);
  }
  h.refs += 1;
  return h;
}

export function releaseScriptHost(h: BoardScriptHost, boardId: string, me: ScriptMe) {
  h.refs -= 1;
  setTimeout(() => {
    if (h.refs > 0) return;
    const key = keyOf(boardId, me, h.code);
    if (hosts.get(key) === h) hosts.delete(key);
    h.destroy();
  }, 2000);
}

/** The board's saved script (boards/{b}/templates/script), live; data null when it has none. */
export function savedScript(
  boardId: string | null | undefined,
): Readable<{ loading: boolean; data: TemplateWithId | null }> {
  if (!boardId) return readable({ loading: false, data: null });
  return docStore<TemplateWithId>(paths.template(boardId, SCRIPT_TEMPLATE_ID)) as Readable<{
    loading: boolean;
    data: TemplateWithId | null;
  }>;
}

export { effectiveBoardScript };

// ── filter values: per person and board, in this browser ──

const filterKey = (boardId: string) => `tm:board-script-filters:${boardId}`;
export function loadFilters(boardId: string): ScriptFilters | null {
  try {
    const raw = localStorage.getItem(filterKey(boardId));
    if (!raw) return null;
    const p = ScriptFiltersSchema.safeParse(JSON.parse(raw));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}
export function saveFilters(boardId: string, f: ScriptFilters | null) {
  try {
    if (f) localStorage.setItem(filterKey(boardId), JSON.stringify(f));
    else localStorage.removeItem(filterKey(boardId));
  } catch {
    /* private mode */
  }
}

/** How many filter controls are not at their starting value (the Filter button's count). */
export function activeFilters(
  controls: readonly ScriptControl[],
  filters: ScriptFilters,
  defaults: ScriptFilters,
): number {
  let n = 0;
  for (const c of controls) {
    if (!c.id) continue;
    const v = filters[c.id];
    if (JSON.stringify(v ?? null) !== JSON.stringify(defaults[c.id] ?? null)) n++;
  }
  return n;
}

/** A board script form, ready for TemplateForm (template = { id, kind, code }, entry). */
export interface FormItem {
  /** What a posted message keeps as template.id: SCRIPT_FORM_PREFIX + the form's id. */
  id: string;
  name: string;
  description: string | null;
  kind: 'message' | 'ticket';
  code: string;
  entry: ScriptEntry;
}
/** The script's forms of one kind (none when the script has no forms() or it fails). */
export async function formItems(
  host: BoardScriptHost,
  kind: 'message' | 'ticket',
): Promise<FormItem[]> {
  const r = await host.forms();
  if (r.error !== undefined) return [];
  return r.value
    .filter((f) => f.kind === kind)
    .map((f) => ({
      id: `${SCRIPT_FORM_PREFIX}${f.id}`,
      name: f.name,
      description: f.description ?? null,
      kind,
      code: host.code,
      entry: { surface: 'form', id: f.id },
    }));
}
