/**
 * §W — the drawer's data comes out of the ticket document, and a `data/{NNN}`
 * page is fetched ONLY when someone scrolls back past the inline window.
 *
 * The ticket document is a store this test drives by hand; Firestore is faked
 * down to `getDoc`, so what is asserted is which pages were asked for and in
 * what order the rows came out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';
import type { DocState } from '$lib/stores';
import { paths as P, type StoredMessage, type Ticket } from '@tm/shared';
import { patchDoc } from '$lib/stores/overlay';

/** Which page documents exist, by path, and which were fetched. */
let pages = new Map<string, unknown>();
let fetched: string[] = [];

vi.mock('$lib/firebase/client', () => ({ getDb: () => ({}) }));
vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, path: string) => ({ path }),
  getDoc: (ref: { path: string }) => {
    fetched.push(ref.path);
    const data = pages.get(ref.path);
    return Promise.resolve({ exists: () => data !== undefined, data: () => data });
  },
  collectionGroup: () => ({}),
  query: () => ({}),
  where: () => ({}),
  onSnapshot: () => () => {},
}));

const ticketState = writable<DocState<Ticket>>({
  loading: true,
  error: null,
  data: null,
  exists: false,
  fromCache: false,
});

vi.mock('$lib/stores', async () => {
  const { readable } = await import('svelte/store');
  return {
    docStore: () => ticketState,
    queryStore: () => readable({ loading: false, error: null, data: [], fromCache: false }),
  };
});

const data = await import('./data');
const { paths } = await import('@tm/shared');

const B = 'b1';
const T = 't1';

const msg = (n: number): StoredMessage =>
  ({
    id: `m${String(n).padStart(4, '0')}`,
    kind: 'comment',
    createdAt: 1_000 + n,
    authorUid: 'u1',
    authorName: 'Ada',
    pinnedAt: null,
    deletedAt: null,
    body: { doc: null, text: '' },
    attachments: [],
    reactions: {},
    replyTo: null,
    editedAt: null,
    via: 'app',
  }) as unknown as StoredMessage;

/** A ticket whose inline window holds `inline` messages, with `pageCount` pages behind it. */
function show(inline: StoredMessage[], pageCount = 0, over: Partial<Ticket> = {}) {
  ticketState.set({
    loading: false,
    error: null,
    exists: true,
    fromCache: false,
    data: {
      id: T,
      counts: { messages: 0, files: 0, pinned: 0 },
      recentMessages: inline,
      recentActivity: [],
      tasklists: [],
      files: [],
      pageCount,
      oldestInlineAt: inline[0]?.createdAt ?? null,
      ...over,
    } as unknown as DocState<Ticket>['data'] & Ticket,
  });
}

/** Let the store's page fetches settle. */
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

beforeEach(() => {
  pages = new Map();
  fetched = [];
  data.forgetTicketPages();
  ticketState.set({
    loading: true,
    error: null,
    data: null,
    exists: false,
    fromCache: false,
  });
});

describe('the thread', () => {
  it('reads the inline window and fetches nothing', async () => {
    const store = data.threadPage(B, T, 50);
    const off = store.subscribe(() => {});
    show([msg(1), msg(2), msg(3)]);
    await settle();
    // Newest first, and no page was ever asked for.
    expect(get(store).data.map((m) => m.id)).toEqual(['m0003', 'm0002', 'm0001']);
    expect(fetched).toEqual([]);
    expect(get(store).loading).toBe(false);
    off();
  });

  it('hands back only as many as were asked for', async () => {
    const store = data.threadPage(B, T, 2);
    const off = store.subscribe(() => {});
    show([msg(1), msg(2), msg(3)]);
    await settle();
    expect(get(store).data.map((m) => m.id)).toEqual(['m0003', 'm0002']);
    off();
  });

  it('pulls one data page — the newest — when someone scrolls past the window', async () => {
    pages.set(paths.ticketPage(B, T, 1), { page: 1, messages: [msg(3), msg(4)], activity: [] });
    pages.set(paths.ticketPage(B, T, 0), { page: 0, messages: [msg(1), msg(2)], activity: [] });
    const store = data.threadPage(B, T, 4);
    const off = store.subscribe(() => {});
    show([msg(5), msg(6)], 2);
    await settle();
    // Only page 001 was needed to reach four messages.
    expect(fetched).toEqual([paths.ticketPage(B, T, 1)]);
    expect(get(store).data.map((m) => m.id)).toEqual(['m0006', 'm0005', 'm0004', 'm0003']);
    off();
  });

  it('keeps pulling back, in order, until it has enough or the thread starts', async () => {
    pages.set(paths.ticketPage(B, T, 1), { page: 1, messages: [msg(3), msg(4)], activity: [] });
    pages.set(paths.ticketPage(B, T, 0), { page: 0, messages: [msg(1), msg(2)], activity: [] });
    const store = data.threadPage(B, T, 50);
    const off = store.subscribe(() => {});
    show([msg(5), msg(6)], 2);
    await settle();
    expect(fetched).toEqual([paths.ticketPage(B, T, 1), paths.ticketPage(B, T, 0)]);
    expect(get(store).data.map((m) => m.id)).toEqual([
      'm0006',
      'm0005',
      'm0004',
      'm0003',
      'm0002',
      'm0001',
    ]);
    // Everything is in: nothing is 'still loading', which is what tells the
    // thread it is at the start.
    expect(get(store).loading).toBe(false);
    off();
  });

  it('says it is still loading while a page it will ask for is missing', async () => {
    pages.set(paths.ticketPage(B, T, 0), { page: 0, messages: [msg(1)], activity: [] });
    const store = data.threadPage(B, T, 50);
    const seen: boolean[] = [];
    const off = store.subscribe((s) => seen.push(s.loading));
    show([msg(2)], 1);
    // Before the fetch resolves the store must not claim the thread starts here.
    expect(get(store).loading).toBe(true);
    await settle();
    expect(get(store).loading).toBe(false);
    expect(seen).toContain(true);
    off();
  });

  it('fetches each page once, however many times it is asked for', async () => {
    pages.set(paths.ticketPage(B, T, 0), { page: 0, messages: [msg(1)], activity: [] });
    const a = data.threadPage(B, T, 50);
    const offA = a.subscribe(() => {});
    show([msg(2)], 1);
    await settle();
    offA();
    const b = data.threadPage(B, T, 50);
    const offB = b.subscribe(() => {});
    show([msg(2)], 1);
    await settle();
    expect(fetched).toEqual([paths.ticketPage(B, T, 0)]);
    expect(get(b).data.length).toBe(2);
    offB();
  });
});

describe('the rest of the drawer', () => {
  it('floats pins out of the inline window, newest pin first', async () => {
    const a = { ...msg(1), pinnedAt: 10 } as StoredMessage;
    const b = { ...msg(2), pinnedAt: 20 } as StoredMessage;
    const store = data.pinnedMessages(B, T);
    const off = store.subscribe(() => {});
    show([a, msg(3), b]);
    expect(get(store).data.map((m) => m.id)).toEqual(['m0002', 'm0001']);
    expect(fetched).toEqual([]);
    off();
  });

  it('finds the question cards inline', async () => {
    const q = {
      ...msg(2),
      kind: 'question',
      question: { title: 'Which env?', status: 'open' },
    } as unknown as StoredMessage;
    const store = data.questionMessages(B, T);
    const off = store.subscribe(() => {});
    show([msg(1), q]);
    expect(get(store).data.map((m) => m.id)).toEqual(['m0002']);
    off();
  });

  it('reads the task lists in position order', async () => {
    const store = data.ticketTasklists(B, T);
    const off = store.subscribe(() => {});
    show([], 0, {
      tasklists: [
        { id: 'l2', position: 2, items: [], createdAt: 2 },
        { id: 'l1', position: 1, items: [], createdAt: 1 },
      ] as unknown as Ticket['tasklists'],
    });
    expect(get(store).data.map((l) => l.id)).toEqual(['l1', 'l2']);
    off();
  });

  it('renders a row’s optimistic overlay at once (a ticked item, a pin)', async () => {
    const lists = data.ticketTasklists(B, T);
    const pins = data.pinnedMessages(B, T);
    const offL = lists.subscribe(() => {});
    const offP = pins.subscribe(() => {});
    const item = { id: 'i1', title: 'Read', status: 'todo' };
    const rows = {
      tasklists: [
        { id: 'plan', position: 1, items: [item], createdAt: 1 },
      ] as unknown as Ticket['tasklists'],
    };
    show([msg(1)], 0, rows);
    // What outbox.queue does: a patch on the row's own path, not the ticket's.
    const undoItem = patchDoc(P.tasklist(B, T, 'plan'), {
      items: [{ ...item, status: 'doing' }],
    });
    const undoPin = patchDoc(P.message(B, T, 'm0001'), { pinnedAt: 5 });
    show([msg(1)], 0, rows); // the ticket store re-emits on every overlay change
    expect(get(lists).data[0]!.items[0]!.status).toBe('doing');
    expect(get(pins).data.map((m) => m.id)).toEqual(['m0001']);
    undoItem();
    undoPin();
    show([msg(1)], 0, rows);
    expect(get(lists).data[0]!.items[0]!.status).toBe('todo');
    expect(get(pins).data).toEqual([]);
    offL();
    offP();
  });

  it('reads every file row, newest first, tombstones included', async () => {
    const store = data.ticketFiles(B, T);
    const off = store.subscribe(() => {});
    show([], 0, {
      files: [
        { id: 'f1', createdAt: 1, deletedAt: null },
        { id: 'f2', createdAt: 2, deletedAt: 9 },
      ] as unknown as Ticket['files'],
    });
    expect(get(store).data.map((f) => f.id)).toEqual(['f2', 'f1']);
    off();
  });

  it('pages the activity feed the same way as the thread', async () => {
    pages.set(paths.ticketPage(B, T, 0), {
      page: 0,
      messages: [],
      activity: [
        { id: 'a1', createdAt: 1, action: 'create', changes: {}, actor: 'u1', via: 'app' },
      ],
    });
    const store = data.activityFeed(B, T, 50);
    const off = store.subscribe(() => {});
    show([], 1, {
      recentActivity: [
        { id: 'a2', createdAt: 2, action: 'update', changes: {}, actor: 'u1', via: 'app' },
      ] as unknown as Ticket['recentActivity'],
    });
    await settle();
    expect(get(store).data.map((a) => a.id)).toEqual(['a2', 'a1']);
    off();
  });
});
