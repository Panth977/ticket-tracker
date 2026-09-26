// @vitest-environment jsdom
/**
 * Phase 8 (§P1) — TASK LISTS USE THE PANE.
 *
 * "Today an item's text wraps into a narrow column while the right half of the
 * pane is empty." The fix is structural, so this tests the structure: the text
 * is the row's one flexible child, the controls are a floating toolbar rather
 * than columns of their own, the note sits UNDER the item at full width, and
 * the arrows have moved into the ⋯ menu ('Move up / Move down' for keyboards).
 *
 * The editing behaviour those controls drive is covered by ./tasklists.test.ts;
 * what is here is the layout contract and the look of an item's status.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { readable } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskItem, Tasklist } from '@tm/shared';
import {
  canTick,
  chipLabel,
  collapseView,
  COLLAPSE_OVER,
  COLLAPSE_ROWS,
  loadExpanded,
  saveExpanded,
  cycleStatus,
  isTicked,
  itemLook,
  listIssue,
  localListId,
  moveItem,
  optimisticItems,
  parseItems,
  pendingLists,
  sortLists,
  statusNeedsNote,
  summaryLine,
  TASKLIST_KIND,
  tickedStatus,
  toDrafts,
  toItemInputs,
  withItem,
} from './tasklist';

const queue = vi.fn();
vi.mock('$lib/api', () => ({ outbox: { queue: (...a: unknown[]) => queue(...a), entries: [] } }));
vi.mock('$lib/layout/routes', () => ({ routes: { ticket: (k: string) => `/t/${k}` } }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/people', async () => ({
  PrincipalAvatar: (await import('./IconStub.test.svelte')).default,
}));
vi.mock('lucide-svelte', async () => {
  const Stub = (await import('./IconStub.test.svelte')).default;
  const names = [
    'ArrowDown',
    'ArrowUp',
    'ChevronDown',
    'Circle',
    'CircleCheck',
    'CircleSlash',
    'CircleX',
    'GripVertical',
    'Loader2',
    'MoreHorizontal',
    'Pencil',
    'Plus',
    'Trash2',
    'X',
  ];
  return Object.fromEntries(names.map((n) => [n, Stub]));
});

const NOW = Date.UTC(2026, 8, 24, 10, 0);
const list: Tasklist & { id: string } = {
  id: 'L1',
  title: 'Plan: add CSV export',
  owner: 'u1',
  items: [
    { id: 'a', title: 'Read the spec', status: 'done', updatedAt: NOW },
    { id: 'b', title: 'Write it', status: 'todo', updatedAt: NOW },
    {
      id: 'c',
      title: 'Upload the report',
      status: 'failed',
      note: 'The export timed out on 40k rows.',
      updatedAt: NOW,
    },
  ],
  position: 0,
  createdAt: NOW,
  updatedAt: NOW,
  closedAt: null,
};
vi.mock('./data', () => ({
  ticketTasklists: () => readable({ loading: false, error: null, data: [list], fromCache: false }),
}));

// jsdom has no Web Animations API; svelte-dnd-action asks for it whenever the
// rows change, which the fold does every time it opens or closes.
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

Object.assign(HTMLDialogElement.prototype, {
  showModal(this: HTMLDialogElement) {
    this.open = true;
  },
  close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  },
});

const { default: Harness } = await import('./TasklistsHarness.test.svelte');

afterEach(() => {
  cleanup();
  queue.mockReset();
});

const row = (container: HTMLElement, id: string) => container.querySelector(`[data-item="${id}"]`)!;

describe('the row uses the width of the pane (§P1)', () => {
  it('gives the item text the row, and floats the controls over its right edge', () => {
    const { container } = render(Harness);
    const b = row(container, 'b');
    // The text is the one thing that grows; nothing else holds a column.
    const text = screen.getByRole('button', { name: 'Write it' });
    expect(text.className).toContain('flex-1');
    const toolbar = b.querySelector('[data-item-toolbar]')!;
    expect(toolbar.className).toContain('absolute');
    // Faded out until the row is hovered or something inside it takes focus.
    expect(toolbar.className).toContain('opacity-0');
    expect(toolbar.className).toContain('group-hover/item:opacity-100');
    expect(toolbar.className).toContain('focus-within:opacity-100');
    // On touch there is no hover, so it simply stays.
    expect(toolbar.className).toContain('[@media(hover:none)]:opacity-100');
  });

  it('keeps the status control on the left, outside the toolbar', () => {
    const { container } = render(Harness);
    const status = screen.getByRole('button', { name: /Write it — change status/ });
    expect(row(container, 'b').querySelector('[data-item-toolbar]')!.contains(status)).toBe(false);
  });

  it("puts a failed item's note under it, full width — not squeezed beside it", () => {
    const { container } = render(Harness);
    const c = row(container, 'c');
    const note = c.querySelector('[data-item-note]')!;
    expect(note.textContent).toContain('The export timed out on 40k rows.');
    // Its own block under the text, not a child of the text button.
    expect(note.tagName).toBe('P');
    expect(c.querySelector('button')!.contains(note)).toBe(false);
  });

  it('spans the bar across the pane and puts the count at its end', () => {
    const { container } = render(Harness);
    const bar = container.querySelector('[role=progressbar]')!;
    expect(bar.className).toContain('flex-1');
    const count = container.querySelector('[data-progress]')!;
    expect(count.textContent?.trim()).toBe('1 / 3');
    // The count follows the bar inside the same row.
    expect(bar.parentElement).toBe(count.parentElement);
    expect(bar.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the arrows moved into the ⋯ menu (§P1)', () => {
  it('offers Move up / Move down there, and moves the item', async () => {
    render(Harness);
    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Read the spec' }));
    expect(screen.getByRole('menuitem', { name: 'Move up' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Move down' }));
    expect(queue.mock.calls[0]?.[0]).toBe('tasklistSet');
    expect(
      (queue.mock.calls[0]?.[1] as { items: { id: string }[] }).items.map((i) => i.id),
    ).toEqual(['b', 'a', 'c']);
  });

  it('still offers the statuses a click does not reach', async () => {
    render(Harness);
    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Write it' }));
    expect(screen.getByRole('menuitem', { name: 'Skipped' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Failed' })).toBeTruthy();
  });
});

describe('how an item reads', () => {
  it('is struck through but still readable when done — dimmed, not a grey blur', () => {
    const look = itemLook('done');
    expect(look.text).toContain('line-through');
    expect(look.text).toContain('text-muted');
    // A half-tone hairline, so the words keep their contrast.
    expect(look.text).toContain('decoration-muted/50');
  });

  it('walks todo → doing → done on a click, and starts again from the others', () => {
    expect(cycleStatus('todo')).toBe('doing');
    expect(cycleStatus('doing')).toBe('done');
    expect(cycleStatus('done')).toBe('todo');
    expect(cycleStatus('failed')).toBe('todo');
    expect(cycleStatus('skipped')).toBe('todo');
  });

  it('a hand tick still means done / not done', () => {
    expect(tickedStatus('todo')).toBe('done');
    expect(tickedStatus('done')).toBe('todo');
  });
});

// ─────────────────────── the pure half of ./tasklist ───────────────────────
/*
 * What a task list means, with no Svelte in it: who may tick an item, what a
 * paste becomes, what the whole-list write carries, and the stand-in a
 * brand-new list shows while it is still in the outbox.
 */
describe('who may change a list (§L2 · §N2)', () => {
  const board = {
    id: 'b1',
    access: { admin: 'admin', ed: 'editor', com: 'commenter', view: 'viewer' },
    stageGrants: {},
  };
  const owned = { owner: 'com' };

  it('lets editors and admins tick anything', () => {
    expect(canTick({ actor: 'ed' }, board as never, owned, false)).toBe(true);
    expect(canTick({ actor: 'admin' }, board as never, owned, false)).toBe(true);
  });

  it("lets the list's own owner keep it, whatever their role", () => {
    expect(canTick({ actor: 'com' }, board as never, owned, false)).toBe(true);
    expect(canTick({ actor: 'com' }, board as never, { owner: 'someone' }, false)).toBe(false);
  });

  it('gives a viewer nothing, and nobody anything on a closed ticket', () => {
    expect(canTick({ actor: 'view' }, board as never, { owner: 'view' }, false)).toBe(false);
    expect(canTick({ actor: 'ed' }, board as never, owned, true)).toBe(false);
  });
});

describe('a paste becomes items (§N2)', () => {
  it('strips bullets, numbering and checkboxes, and drops blank lines', () => {
    expect(parseItems('- One\n\n2) Two\n* Three\n[ ] Four\n[x] Five')).toEqual([
      'One',
      'Two',
      'Three',
      'Four',
      'Five',
    ]);
  });

  it('one typed line is simply one item', () => {
    expect(parseItems('Write the exporter')).toEqual(['Write the exporter']);
    expect(parseItems('   ')).toEqual([]);
  });

  it('stops at the list cap', () => {
    expect(parseItems(Array.from({ length: 10 }, (_, i) => `i${i}`).join('\n'), 3)).toEqual([
      'i0',
      'i1',
      'i2',
    ]);
  });
});

describe('the whole-list write', () => {
  const items = [
    { id: 'a', title: 'Read the spec', status: 'done' as const },
    { id: 'b', title: '  Write it  ', status: 'todo' as const, note: 'later' },
    { title: 'New one' },
  ];

  it('keeps the ids it has, trims titles, and defaults a new item to todo', () => {
    expect(toItemInputs(items)).toEqual([
      { id: 'a', title: 'Read the spec', status: 'done' },
      { id: 'b', title: 'Write it', status: 'todo', note: 'later' },
      { title: 'New one', status: 'todo' },
    ]);
  });

  it('drops blank titles rather than writing them', () => {
    expect(toItemInputs([{ title: '   ' }, { title: 'Kept' }]).map((i) => i.title)).toEqual([
      'Kept',
    ]);
  });

  it('turns a stored list back into drafts, note and all', () => {
    expect(
      toDrafts([{ id: 'a', title: 'A', status: 'failed', note: 'boom', updatedAt: 1 }]),
    ).toEqual([{ id: 'a', title: 'A', status: 'failed', note: 'boom' }]);
  });

  it('gives every optimistic item an id, so the pane never flickers', () => {
    const out = optimisticItems(
      [{ title: 'New' }, { id: 'a', title: 'Old', status: 'done' }],
      99,
      () => 'gen',
    );
    expect(out).toEqual([
      { id: 'gen', title: 'New', status: 'todo', updatedAt: 99 },
      { id: 'a', title: 'Old', status: 'done', updatedAt: 99 },
    ]);
  });

  it('refuses a list with no title, and one past the item cap', () => {
    expect(listIssue('  ', [])).toBe('A list needs a title');
    expect(listIssue('Plan', [{ title: 'x' }])).toBeNull();
    expect(listIssue('x'.repeat(500), [])).toContain('at most');
  });
});

describe('moving and patching items', () => {
  const xs = ['a', 'b', 'c'];

  it('moves an item to another index', () => {
    expect(moveItem(xs, 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(xs, 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('leaves the list alone when the move goes nowhere', () => {
    expect(moveItem(xs, 1, 1)).toEqual(xs);
    expect(moveItem(xs, 0, -1)).toEqual(xs);
    expect(moveItem(xs, 5, 0)).toEqual(xs);
  });

  it('patches one item in place, and clears a note with null', () => {
    const items = [
      { id: 'a', title: 'A', status: 'todo' as const, updatedAt: 1 },
      { id: 'b', title: 'B', status: 'failed' as const, note: 'boom', updatedAt: 1 },
    ];
    expect(withItem(items, 'a', { status: 'doing' }, 9)[0]).toMatchObject({
      status: 'doing',
      updatedAt: 9,
    });
    expect(withItem(items, 'b', { status: 'todo', note: null }, 9)[1]).toMatchObject({
      status: 'todo',
      note: undefined,
    });
    // Everything else is untouched.
    expect(withItem(items, 'a', { status: 'doing' }, 9)[1]).toEqual(items[1]);
  });
});

describe('how a list reads at a glance', () => {
  const mk = (statuses: string[], closedAt: number | null = null) => ({
    items: statuses.map((s, i) => ({
      id: `i${i}`,
      title: `Item ${i}`,
      status: s as never,
      updatedAt: 1,
    })),
    position: 0,
    closedAt,
  });

  it("is the card's '4/7' chip", () => {
    expect(chipLabel(mk(['done', 'skipped', 'todo', 'todo']))).toBe('2/4');
    expect(chipLabel(mk([]))).toBe('0/0');
  });

  it('says what is running, what failed, or that it is finished', () => {
    expect(summaryLine(mk(['done', 'doing', 'todo']))).toBe('Item 1');
    expect(summaryLine(mk(['done', 'failed']))).toBe('1 failed');
    expect(summaryLine(mk(['done'], 5))).toBe('Finished');
    expect(summaryLine(mk(['todo']))).toBeNull();
  });

  it('sinks finished lists below the ones with work left, keeping position for ties', () => {
    const open = { ...mk(['todo']), position: 5 };
    const done = { ...mk(['done']), position: 0 };
    const closed = { ...mk(['todo'], 9), position: 1 };
    expect(sortLists([done, closed, open])).toEqual([open, done, closed]);
  });

  it('a tick is only a tick when it is done', () => {
    expect(isTicked('done')).toBe(true);
    expect(isTicked('skipped')).toBe(false);
    expect(isTicked('doing')).toBe(false);
  });

  it('only failed asks for a note', () => {
    expect(statusNeedsNote('failed')).toBe(true);
    expect(statusNeedsNote('skipped')).toBe(false);
  });
});

describe('a list still in the outbox', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    id: 'e1',
    command: 'tasklistSet',
    kind: TASKLIST_KIND,
    ticketId: 't1',
    status: 'sending',
    createdAt: 7,
    input: { listId: 'L9', title: 'Plan', items: [{ title: 'One' }] },
    ...over,
  });

  it('draws a stand-in for a list the listener has not delivered yet', () => {
    const [p] = pendingLists([entry()], 't1', 'u1', new Set());
    expect(p!.state).toBe('sending');
    expect(p!.list).toMatchObject({ id: 'L9', title: 'Plan', owner: 'u1' });
    expect(p!.list.items).toEqual([{ id: 'L9-0', title: 'One', status: 'todo', updatedAt: 7 }]);
  });

  it('stops drawing it the moment the real document arrives', () => {
    expect(pendingLists([entry()], 't1', 'u1', new Set(['L9']))).toEqual([]);
  });

  it('ignores other tickets, other commands and other kinds', () => {
    expect(pendingLists([entry({ ticketId: 't2' })], 't1', 'u1', new Set())).toEqual([]);
    expect(pendingLists([entry({ command: 'tasklistDelete' })], 't1', 'u1', new Set())).toEqual([]);
    expect(pendingLists([entry({ kind: 'ticket' })], 't1', 'u1', new Set())).toEqual([]);
  });

  it('a failed entry gets the red edge', () => {
    expect(pendingLists([entry({ status: 'failed' })], 't1', 'u1', new Set())[0]!.state).toBe(
      'failed',
    );
  });
});

describe('client-chosen ids', () => {
  it('are 7 base36 characters, so a stand-in and its document share a key', () => {
    const id = localListId();
    expect(id).toHaveLength(7);
    expect(id).toMatch(/^[0-9a-z]{7}$/);
    expect(localListId()).not.toBe(id);
  });
});

// ───────── Phase 11 (§11B) — the fold ────────────────────────────────────────
/**
 * "Show only what matters — the doing item and the next few to-dos — and fold
 * the rest into chips such as '+3 pending  +6 done' that expand on click."
 * The maths decides both halves at once, so it is tested on its own: which
 * rows survive, and what the chips under them say.
 */
describe('how a long list folds', () => {
  const at = (n: number) => NOW + n * 1000;
  let n = 0;
  const item = (status: TaskItem['status'], when = at(n)): TaskItem => ({
    id: `i${++n}`,
    title: `Step ${n}`,
    status,
    updatedAt: when,
  });
  const of = (...items: TaskItem[]) => ({ items });

  beforeEach(() => {
    n = 0;
  });

  it('leaves a short list alone — there is nothing to save', () => {
    const short = of(item('doing'), item('todo'), item('todo'));
    const v = collapseView(short, false);
    expect(v.collapsed).toBe(false);
    expect(v.collapsible).toBe(false);
    expect(v.rows).toHaveLength(3);
    expect(v.chips).toEqual([]);
  });

  it('keeps the doing item and the next to-dos, about four rows in all', () => {
    const long = of(
      item('done'),
      item('done'),
      item('done'),
      item('doing'),
      item('todo'),
      item('todo'),
      item('todo'),
      item('todo'),
      item('todo'),
      item('todo'),
    );
    const v = collapseView(long, false);
    expect(v.collapsed).toBe(true);
    expect(v.rows).toHaveLength(COLLAPSE_ROWS);
    // In list order, and what is behind us never takes a row.
    expect(v.rows.map((i) => i.status)).toEqual(['doing', 'todo', 'todo', 'todo']);
    expect(v.rows.map((i) => i.id)).toEqual(['i4', 'i5', 'i6', 'i7']);
    expect(v.hidden).toBe(6);
  });

  it('reads the chips off what it hid: +3 pending, +6 done, +1 failed', () => {
    const items = [
      item('doing'),
      item('failed', at(1)),
      item('failed', at(3)), // the two newest failures stay in view…
      item('failed', at(2)),
      item('todo'),
      item('todo'),
      item('todo'),
      item('todo'),
      ...Array.from({ length: 6 }, () => item('done')),
    ];
    const v = collapseView({ items }, false);
    expect(v.chips.map((c) => c.label)).toEqual(['+3 pending', '+6 done', '+1 failed']);
    expect(v.chips.map((c) => c.key)).toEqual(['pending', 'done', 'failed']);
    // …and the one that folded is the oldest of the three.
    expect(v.rows.filter((i) => i.status === 'failed').map((i) => i.id)).toEqual(['i3', 'i4']);
    expect(v.rows).toHaveLength(COLLAPSE_ROWS);
  });

  it('never folds a failure away while there is only one', () => {
    const items = [...Array.from({ length: 8 }, () => item('done')), item('failed'), item('todo')];
    const v = collapseView({ items }, false);
    expect(v.rows.map((i) => i.status)).toEqual(['failed', 'todo']);
    expect(v.chips.map((c) => c.label)).toEqual(['+8 done']);
  });

  it('shows everything again once the person expands it', () => {
    const items = Array.from({ length: COLLAPSE_OVER + 4 }, () => item('todo'));
    const v = collapseView({ items }, true);
    expect(v.collapsed).toBe(false);
    expect(v.collapsible).toBe(true); // …so the pane can offer 'Show less'
    expect(v.rows).toHaveLength(items.length);
    expect(v.chips).toEqual([]);
  });

  it('turns a finished list into one “8 done” row, however short it is', () => {
    const done8 = { items: Array.from({ length: 8 }, () => item('done')) };
    const v = collapseView(done8, false);
    expect(v.finished).toBe(true);
    expect(v.rows).toEqual([]);
    expect(v.chips.map((c) => c.label)).toEqual(['8 done']);
    // Skipped counts as settled — the list still has nothing left to do.
    expect(collapseView(of(item('done'), item('skipped')), false).chips[0]!.label).toBe('2 done');
    // A single failure is not 'finished': it is exactly what must stay visible.
    expect(collapseView(of(item('done'), item('failed')), false).finished).toBe(false);
  });

  it('an empty list has no fold at all', () => {
    expect(collapseView({ items: [] }, false)).toMatchObject({
      collapsed: false,
      collapsible: false,
      chips: [],
    });
  });
});

describe('which lists are open, for this session', () => {
  it('round-trips through sessionStorage and survives junk in it', () => {
    saveExpanded(['L1', 'L2']);
    expect(loadExpanded()).toEqual(['L1', 'L2']);
    sessionStorage.setItem('tm.tasklists.expanded', '{oops');
    expect(loadExpanded()).toEqual([]);
    sessionStorage.clear();
    expect(loadExpanded()).toEqual([]);
  });
});

describe('the fold on screen', () => {
  const original = list.items;
  const many: TaskItem[] = [
    { id: 'd1', title: 'Read the spec', status: 'done', updatedAt: NOW },
    { id: 'd2', title: 'Draw the plan', status: 'done', updatedAt: NOW },
    { id: 'd3', title: 'Agree the shape', status: 'done', updatedAt: NOW },
    { id: 'go', title: 'Write the exporter', status: 'doing', updatedAt: NOW },
    { id: 'p1', title: 'Wire the button', status: 'todo', updatedAt: NOW },
    { id: 'p2', title: 'Test it', status: 'todo', updatedAt: NOW },
    { id: 'p3', title: 'Ship it', status: 'todo', updatedAt: NOW },
    { id: 'p4', title: 'Tell the board', status: 'todo', updatedAt: NOW },
  ];

  beforeEach(() => {
    sessionStorage.clear();
    list.items = many;
  });
  afterEach(() => {
    list.items = original;
    sessionStorage.clear();
  });

  it('draws four rows and chips for the rest, with the bar still above them', async () => {
    render(Harness);
    expect(screen.getByText('Write the exporter')).toBeTruthy();
    expect(screen.getByText('Ship it')).toBeTruthy(); // the 4th row
    expect(screen.queryByText('Read the spec')).toBeNull(); // folded: it is behind us
    expect(screen.queryByText('Tell the board')).toBeNull(); // folded: one to-do too many
    expect(screen.getByText('+1 pending')).toBeTruthy();
    expect(screen.getByText('+3 done')).toBeTruthy();
    // §11B t3: the progress bar and its count never fold.
    expect(screen.getByText('3 / 8')).toBeTruthy();
  });

  it('opens the whole list when a chip is clicked, and folds again on Show less', async () => {
    render(Harness);
    await fireEvent.click(screen.getByText('+3 done'));
    expect(screen.getByText('Read the spec')).toBeTruthy();
    expect(screen.getByText('Tell the board')).toBeTruthy();
    expect(screen.queryByText('+3 done')).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: /Show less/ }));
    expect(screen.queryByText('Read the spec')).toBeNull();
  });

  it('remembers what was open for the session, per list', async () => {
    const first = render(Harness);
    await fireEvent.click(screen.getByRole('button', { name: /Show all 8 items/ }));
    expect(JSON.parse(sessionStorage.getItem('tm.tasklists.expanded')!)).toEqual(['L1']);
    first.unmount();
    // A second visit to the ticket in the same session opens it already unfolded.
    render(Harness);
    expect(screen.getByText('Read the spec')).toBeTruthy();
  });

  it('shows a finished list as one “8 done” row under its title', () => {
    list.items = many.map((i) => ({ ...i, status: 'done' as const }));
    render(Harness);
    expect(screen.getByText('Plan: add CSV export')).toBeTruthy();
    expect(screen.getByText('8 done')).toBeTruthy();
    expect(screen.queryByText('Write the exporter')).toBeNull();
  });
});
