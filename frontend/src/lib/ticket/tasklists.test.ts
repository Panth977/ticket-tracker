// @vitest-environment jsdom
/**
 * Task lists people write (§N2): the right pane's editing, through the
 * outbox. One item's status is tasklistItemUpdate; anything structural is a
 * whole-list tasklistSet; and what a person may not do is not drawn at all.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { readable } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tasklist } from '@tm/shared';

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

const NOW = Date.UTC(2026, 8, 23, 10, 0);
const list: Tasklist & { id: string } = {
  id: 'L1',
  title: 'Plan: add CSV export',
  owner: 'u1',
  items: [
    { id: 'a', title: 'Read the spec', status: 'done', updatedAt: NOW },
    { id: 'b', title: 'Write it', status: 'todo', updatedAt: NOW },
  ],
  position: 0,
  createdAt: NOW,
  updatedAt: NOW,
  closedAt: null,
};
vi.mock('./data', () => ({
  ticketTasklists: () => readable({ loading: false, error: null, data: [list], fromCache: false }),
}));

// jsdom has no dialog implementation; the two dialogs here only need open/close.
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

const call = (n: number) => queue.mock.calls[n] as [string, Record<string, unknown>, unknown];

describe('what the pane shows', () => {
  it('draws the list, its progress and its items', () => {
    render(Harness);
    expect(screen.getByText('Plan: add CSV export')).toBeTruthy();
    expect(screen.getByText('1 / 2')).toBeTruthy();
    expect(screen.getByText('Write it')).toBeTruthy();
  });

  it('offers + New list to an editor', () => {
    render(Harness);
    expect(screen.getByRole('button', { name: 'New list' })).toBeTruthy();
  });

  it('hides every control from a viewer (§N2: read-only)', () => {
    render(Harness, { props: { me: 'u1', role: 'viewer' } });
    expect(screen.queryByRole('button', { name: 'New list' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add an item' })).toBeNull();
    expect(screen.queryByRole('button', { name: /change status/ })).toBeNull();
    // ...but the list itself is still readable.
    expect(screen.getByText('Write it')).toBeTruthy();
  });

  it('lets a commenter who owns the list edit it, and not start another', () => {
    render(Harness, { props: { me: 'u1', role: 'commenter' } });
    expect(screen.queryByRole('button', { name: 'New list' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add an item' })).toBeTruthy();
  });
});

describe('editing, through the outbox', () => {
  it('clicking a status walks todo → doing (tasklistItemUpdate, no thread line)', async () => {
    render(Harness);
    await fireEvent.click(screen.getByRole('button', { name: /Write it — change status/ }));
    expect(call(0)[0]).toBe('tasklistItemUpdate');
    expect(call(0)[1]).toMatchObject({ listId: 'L1', itemId: 'b', status: 'doing' });
  });

  it('clicking a done item starts the walk again', async () => {
    render(Harness);
    await fireEvent.click(screen.getByRole('button', { name: /Read the spec — change status/ }));
    expect(call(0)[1]).toMatchObject({ itemId: 'a', status: 'todo' });
  });

  it('moving an item down rewrites the whole list, in the new order', async () => {
    render(Harness);
    await fireEvent.click(screen.getByRole('button', { name: /Move .Read the spec. down/ }));
    expect(call(0)[0]).toBe('tasklistSet');
    expect((call(0)[1].items as { id: string }[]).map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('adds an item at the end, keeping the ids of the ones already there', async () => {
    render(Harness);
    await fireEvent.click(screen.getByRole('button', { name: 'Add an item' }));
    const input = screen.getByLabelText('New item') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '- Test it' } });
    await fireEvent.submit(input.closest('form')!);
    expect(call(0)[0]).toBe('tasklistSet');
    const items = call(0)[1].items as { id?: string; title: string }[];
    // The bullet a paste carries in is stripped, and the new item has no id yet.
    expect(items.map((i) => i.title)).toEqual(['Read the spec', 'Write it', 'Test it']);
    expect(items.map((i) => i.id)).toEqual(['a', 'b', undefined]);
  });

  it('editing an item in place renames just that item', async () => {
    render(Harness);
    await fireEvent.click(screen.getByRole('button', { name: 'Write it' }));
    const input = screen.getByLabelText('Item text') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'Write the exporter' } });
    await fireEvent.blur(input);
    expect((call(0)[1].items as { title: string }[]).map((i) => i.title)).toEqual([
      'Read the spec',
      'Write the exporter',
    ]);
  });

  it('a blank rename is ignored rather than written', async () => {
    render(Harness);
    await fireEvent.click(screen.getByRole('button', { name: 'Write it' }));
    const input = screen.getByLabelText('Item text') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '   ' } });
    await fireEvent.blur(input);
    expect(queue).not.toHaveBeenCalled();
  });

  it('+ New list sends the title and one item per pasted line', async () => {
    render(Harness);
    await fireEvent.click(screen.getByRole('button', { name: 'New list' }));
    await fireEvent.input(screen.getByLabelText('Title'), { target: { value: 'Plan' } });
    await fireEvent.input(screen.getByLabelText('Items'), { target: { value: '- One\n- Two' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add list' }));
    expect(call(0)[0]).toBe('tasklistSet');
    expect(call(0)[1]).toMatchObject({
      title: 'Plan',
      items: [{ title: 'One' }, { title: 'Two' }],
    });
    // A client-chosen id, so the stand-in and the stored list share a key.
    expect(typeof call(0)[1].listId).toBe('string');
  });
});
