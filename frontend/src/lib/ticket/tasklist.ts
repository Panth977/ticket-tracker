/**
 * Phase 3 — TASK LISTS on a ticket (docs/plan/agents.html §L2), the parts with
 * no Svelte in them.
 *
 * An agent publishes its plan as a checklist and ticks it off as it works;
 * `tasklistProgress` (shared) does the counting, so the progress bar, the
 * drawer and the card's '4/7' chip can never disagree. What lives here is how
 * the LIST reads on screen: who may tick an item by hand, what a hand tick
 * means, and how the bar is labelled.
 */
import {
  canEditTasklist,
  MAX_TASKLIST_ITEMS,
  TASK_ITEM_TITLE_MAX,
  TASKLIST_TITLE_MAX,
  tasklistComplete,
  tasklistProgress,
  type TaskItem,
  type TaskItemInput,
  type TaskItemStatus,
  type Tasklist,
} from '@tm/shared';
import type { CanBoard, CanCtx } from '@tm/shared/logic/can';

export { tasklistProgress, tasklistComplete };

/**
 * May I tick items here (§L2: 'the owner — through its token — and editors can
 * change a list; people may also tick items by hand')? In the browser the
 * actor is always a person, so this is the editor half of canEditTasklist,
 * plus the ticket being open.
 */
export function canTick(
  ctx: CanCtx,
  board: CanBoard,
  list: Pick<Tasklist, 'owner'>,
  closed: boolean,
): boolean {
  return !closed && canEditTasklist(ctx, board, list);
}

/**
 * What a hand tick does. A person clicking the box means 'this is done' or
 * 'no, it isn't' — the agent's own doing / failed / skipped states are never
 * produced by a click, but clicking one of them still clears it to done.
 */
export function tickedStatus(current: TaskItemStatus): TaskItemStatus {
  return current === 'done' ? 'todo' : 'done';
}

/** Is the checkbox drawn as ticked? ('skipped' is settled, but not a tick.) */
export const isTicked = (status: TaskItemStatus): boolean => status === 'done';

export interface ItemLook {
  /** Tailwind classes for the item's text. */
  text: string;
  /** Screen-reader / tooltip wording for the status. */
  label: string;
}

/** How one item reads (§L2: doing is highlighted with a spinner, failed is red). */
export function itemLook(status: TaskItemStatus): ItemLook {
  switch (status) {
    case 'doing':
      return { text: 'font-medium text-text', label: 'In progress' };
    // §P1: 'struck through but still readable — dimmed text, not a grey blur',
    // so the strike is thin and half-tone while the words keep their contrast.
    case 'done':
      return { text: 'text-muted line-through decoration-muted/50 decoration-1', label: 'Done' };
    case 'skipped':
      return {
        text: 'text-subtle line-through decoration-subtle/50 decoration-1',
        label: 'Skipped',
      };
    case 'failed':
      return { text: 'text-danger', label: 'Failed' };
    case 'todo':
      return { text: 'text-text', label: 'To do' };
  }
}

/** '4/7' — the ticket card's compact chip (§L2). */
export function chipLabel(list: Pick<Tasklist, 'items'>): string {
  const p = tasklistProgress(list);
  return `${p.settled}/${p.total}`;
}

/**
 * The one line a collapsed list shows: what is being worked on, what went
 * wrong, or that it is finished.
 */
export function summaryLine(list: Pick<Tasklist, 'items' | 'closedAt'>): string | null {
  const p = tasklistProgress(list);
  if (p.current) return p.current.title;
  if (p.failed > 0) return `${p.failed} failed`;
  if (list.closedAt != null) return 'Finished';
  return null;
}

/** Lists with anything left first; finished ones sink. Ties keep `position`. */
export function sortLists<T extends Pick<Tasklist, 'items' | 'position' | 'closedAt'>>(
  lists: readonly T[],
): T[] {
  return [...lists].sort((a, b) => {
    const ac = a.closedAt != null || tasklistComplete(a);
    const bc = b.closedAt != null || tasklistComplete(b);
    if (ac !== bc) return ac ? 1 : -1;
    return a.position - b.position;
  });
}

/** The items array with one item's status / note replaced — the optimistic patch. */
export function withItem(
  items: readonly TaskItem[],
  itemId: string,
  patch: { status?: TaskItemStatus; note?: string | null },
  now: number,
): TaskItem[] {
  return items.map((i) =>
    i.id === itemId
      ? {
          ...i,
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.note !== undefined
            ? patch.note === null
              ? { note: undefined }
              : { note: patch.note }
            : {}),
          updatedAt: now,
        }
      : i,
  );
}

// ───────────────── Phase 5 — LISTS PEOPLE WRITE (§N2) ──────────────────────
/*
 * '+ New list: a title and the items. Paste several lines and each becomes an
 * item — the fastest way to turn a plan into a checklist.' Everything below is
 * the editing half: what a paste means, what clicking a status does, and how a
 * list of items becomes the whole-list write `tasklistSet` takes.
 */

/** Bullet / numbering / checkbox noise a paste from a doc carries in. */
const LEAD = /^\s*(?:[-*•–—]|\[[ xX]?\]|\d+[.)])\s+/;

/**
 * Lines pasted (or typed) into the items box, as item titles: bullets and
 * numbering stripped, blanks dropped, trimmed to the item limit. One line with
 * no newlines is simply one item, which is what typing gives you.
 */
export function parseItems(text: string, max = MAX_TASKLIST_ITEMS): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(LEAD, '').trim().slice(0, TASK_ITEM_TITLE_MAX))
    .filter((l) => l !== '')
    .slice(0, max);
}

/**
 * Clicking the status walks the three states a person means by hand
 * (§N2: 'todo → doing → done'); skipped and failed are deliberate choices from
 * the menu, so clicking one of those starts the walk again.
 */
export function cycleStatus(current: TaskItemStatus): TaskItemStatus {
  switch (current) {
    case 'todo':
      return 'doing';
    case 'doing':
      return 'done';
    default:
      return 'todo';
  }
}

/** The statuses the item's menu offers, in its order. */
export const ITEM_MENU_STATUSES: readonly TaskItemStatus[] = [
  'todo',
  'doing',
  'done',
  'skipped',
  'failed',
];

/** Setting this status asks for a short note first (§N2: 'failed asks for a note'). */
export const statusNeedsNote = (status: TaskItemStatus): boolean => status === 'failed';

/** One item as the editor holds it (an unsaved new item has no id yet). */
export interface ItemDraft {
  id?: string;
  title: string;
  /** Absent on a brand-new item, which starts as 'todo'. */
  status?: TaskItemStatus;
  note?: string;
}

/** A stored list's items as drafts, ready to rename / reorder / remove. */
export const toDrafts = (items: readonly TaskItem[]): ItemDraft[] =>
  items.map((i) => ({
    id: i.id,
    title: i.title,
    status: i.status,
    ...(i.note ? { note: i.note } : {}),
  }));

/**
 * What `tasklistSet` takes: ids kept (so an untouched item keeps its
 * updatedAt), blank titles dropped, the item cap applied.
 */
export function toItemInputs(
  items: readonly ItemDraft[],
  max = MAX_TASKLIST_ITEMS,
): TaskItemInput[] {
  return items
    .filter((i) => i.title.trim() !== '')
    .slice(0, max)
    .map((i) => ({
      ...(i.id ? { id: i.id } : {}),
      title: i.title.trim(),
      status: i.status ?? 'todo',
      ...(i.note ? { note: i.note } : {}),
    }));
}

/** The optimistic items for a whole-list write — what the pane shows at once. */
export function optimisticItems(
  items: readonly ItemDraft[],
  now: number,
  newId: () => string,
): TaskItem[] {
  return toItemInputs(items).map((i) => ({
    id: i.id ?? newId(),
    title: i.title,
    status: i.status ?? 'todo',
    ...(i.note ? { note: i.note } : {}),
    updatedAt: now,
  }));
}

/** Move an item to another index (drag, or ↑/↓); out of range is a no-op. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const out = [...items];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x!);
  return out;
}

/** Why this list cannot be saved, or null. Titles and items are both bounded. */
export function listIssue(title: string, items: readonly ItemDraft[]): string | null {
  const t = title.trim();
  if (!t) return 'A list needs a title';
  if (t.length > TASKLIST_TITLE_MAX) return `A title is at most ${TASKLIST_TITLE_MAX} characters`;
  if (toItemInputs(items).length > MAX_TASKLIST_ITEMS)
    return `A list holds at most ${MAX_TASKLIST_ITEMS} items`;
  return null;
}

/**
 * A list queued but not yet stored — the stand-in the right pane shows while
 * '+ New list' is in the outbox (overlays can only patch documents that
 * already exist, so a brand-new list needs its own row).
 */
export interface PendingList {
  list: TasklistLike;
  /** 'sending' dims it; 'failed' gives it a red edge (its toast offers Resend). */
  state: 'sending' | 'failed';
}
type TasklistLike = Tasklist & { id: string };

/** The outbox fields this reads — the entry type without importing $lib/api. */
export interface ListEntry {
  id: string;
  command: string;
  kind: string;
  ticketId?: string;
  status: string;
  createdAt: number;
  input: Record<string, unknown>;
}

/** The kind queued list writes carry, so they can be found again. */
export const TASKLIST_KIND = 'tasklist';

/**
 * Stand-ins for this ticket's queued list creations whose document has not
 * arrived yet. `known` are the ids the listener has already delivered.
 */
export function pendingLists(
  entries: readonly ListEntry[],
  ticketId: string,
  me: string,
  known: ReadonlySet<string>,
): PendingList[] {
  const out: PendingList[] = [];
  for (const e of entries) {
    if (e.kind !== TASKLIST_KIND || e.command !== 'tasklistSet' || e.ticketId !== ticketId)
      continue;
    const listId = typeof e.input.listId === 'string' ? e.input.listId : null;
    if (!listId || known.has(listId)) continue;
    const items = Array.isArray(e.input.items) ? (e.input.items as TaskItemInput[]) : [];
    out.push({
      state: e.status === 'failed' ? 'failed' : 'sending',
      list: {
        id: listId,
        title: typeof e.input.title === 'string' ? e.input.title : '…',
        owner: me,
        items: items.map((i, n) => ({
          id: i.id ?? `${listId}-${n}`,
          title: i.title,
          status: i.status ?? 'todo',
          ...(i.note ? { note: i.note } : {}),
          updatedAt: e.createdAt,
        })),
        position: Number.MAX_SAFE_INTEGER,
        createdAt: e.createdAt,
        updatedAt: e.createdAt,
        closedAt: null,
      },
    });
  }
  return out;
}

/**
 * A client-chosen list / item id (7 chars of base36, like the server's
 * shortId). Choosing it here is what lets the optimistic stand-in and the
 * stored list share a key, so the new list never flickers.
 */
export function localListId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

// ───────── Phase 11 (§11B) — TASK LISTS COLLAPSE LIKE THE CLAUDE CODE TUI ────
/*
 * A 20-item plan is a wall. The TUI's answer is to show only what is happening
 * now — the item being worked on and the next few to-dos — and to fold the
 * rest into chips ('+3 pending  +6 done') that expand on click. The maths is
 * here, as a pure function, so the rows on screen and the chips under them can
 * never disagree (and so they can be tested without a DOM).
 *
 * Rules, in the order they decide:
 *   1. Expanded (the person clicked) — everything, always.
 *   2. Finished (every item settled) — no rows at all, one '8 done' chip; the
 *      title above it is the whole list (t3).
 *   3. Six items or fewer — everything; there is nothing to save.
 *   4. Otherwise ~4 rows: every 'doing' item, the newest failed ones (a failure
 *      is never folded away), then the next to-dos in list order. Done and
 *      skipped items never take a row — they are behind us, and the bar
 *      already counts them.
 */

/** A list longer than this collapses ('more than ~6 items'). */
export const COLLAPSE_OVER = 6;
/** About this many rows survive the fold. */
export const COLLAPSE_ROWS = 4;
/** How many failed items stay in view (newest first) before they too fold. */
export const COLLAPSE_FAILED = 2;

export type ChipKey = 'pending' | 'done' | 'failed';

/** One fold chip: '+3 pending'. Clicking any of them expands the list. */
export interface CollapseChip {
  key: ChipKey;
  count: number;
  label: string;
}

export interface CollapseView {
  /** Are rows being hidden right now? */
  collapsed: boolean;
  /** Would this list fold if it were not expanded? (drives 'Show less'.) */
  collapsible: boolean;
  /** The items to draw, in list order. */
  rows: TaskItem[];
  /** The chips under the rows — empty while expanded. */
  chips: CollapseChip[];
  /** How many items the chips stand for. */
  hidden: number;
  /** Everything is settled: the list is one '8 done' row under its title. */
  finished: boolean;
}

const chip = (key: ChipKey, count: number, label: string): CollapseChip => ({ key, count, label });

/**
 * Which rows a list shows and what its chips say. `expanded` is the person's
 * click, remembered per list for the session (see loadExpanded).
 */
export function collapseView(
  list: Pick<Tasklist, 'items'>,
  expanded: boolean,
  rowBudget = COLLAPSE_ROWS,
): CollapseView {
  const items = list.items;
  const all = (): CollapseView => ({
    collapsed: false,
    collapsible: false,
    rows: [...items],
    chips: [],
    hidden: 0,
    finished: false,
  });
  if (items.length === 0) return all();

  // 2. Finished: the rows have nothing left to say, so the title carries it.
  if (tasklistComplete(list)) {
    const folded: CollapseView = {
      collapsed: true,
      collapsible: true,
      rows: [],
      chips: [chip('done', items.length, `${items.length} done`)],
      hidden: items.length,
      finished: true,
    };
    return expanded ? { ...all(), collapsible: true, finished: true } : folded;
  }

  // 3. Short enough to read at a glance.
  if (items.length <= COLLAPSE_OVER) return all();
  if (expanded) return { ...all(), collapsible: true };

  // 4. What is happening now: doing, the newest failures, then the next to-dos.
  const keep = new Set<string>();
  for (const i of items) if (i.status === 'doing') keep.add(i.id);
  for (const f of items
    .filter((i) => i.status === 'failed')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, COLLAPSE_FAILED))
    keep.add(f.id);
  for (const i of items) {
    if (keep.size >= rowBudget) break;
    if (i.status === 'todo') keep.add(i.id);
  }

  const rows = items.filter((i) => keep.has(i.id));
  const rest = items.filter((i) => !keep.has(i.id));
  const count = (p: (i: TaskItem) => boolean) => rest.filter(p).length;
  const pending = count((i) => i.status === 'todo' || i.status === 'doing');
  const done = count((i) => i.status === 'done' || i.status === 'skipped');
  const failed = count((i) => i.status === 'failed');
  const chips: CollapseChip[] = [];
  if (pending) chips.push(chip('pending', pending, `+${pending} pending`));
  if (done) chips.push(chip('done', done, `+${done} done`));
  if (failed) chips.push(chip('failed', failed, `+${failed} failed`));
  return {
    collapsed: rest.length > 0,
    collapsible: rest.length > 0,
    rows,
    chips,
    hidden: rest.length,
    finished: false,
  };
}

/*
 * Which lists the person has opened, remembered for the session only: it is a
 * reading preference, not a setting, so a new tab starts folded again. Every
 * access is guarded — a private window with storage blocked must not take the
 * pane down with it.
 */
const EXPANDED_KEY = 'tm.tasklists.expanded';

export function loadExpanded(): string[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(EXPANDED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveExpanded(ids: readonly string[]): void {
  try {
    globalThis.sessionStorage?.setItem(EXPANDED_KEY, JSON.stringify([...ids]));
  } catch {
    /* storage refused: the fold still works, it just forgets. */
  }
}
