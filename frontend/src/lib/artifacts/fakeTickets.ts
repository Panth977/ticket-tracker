/**
 * TESTS ONLY — an in-memory TicketBackend (./brokerTickets) for broker.test.ts
 * and endToEnd.test.ts: the ENG board of the shared fixtures, its two people,
 * a few tickets, and a recording of every write. Board 'SEC' exists too but
 * the viewer is not on it (board() answers null, as the rules would make it).
 */
import { fixtures, UID_ASHA, UID_PRIYA } from '@tm/shared/schema/fixtures';
import type { AggStats, BoardMember, BoardWithId, StoredMessage, TicketWithId } from '@tm/shared';
import type { TicketBackend } from './brokerTickets';

export const ENG_ID = 'board_eng';
export const SEC_ID = 'board_sec';

export function fakeTickets(viewer = UID_ASHA) {
  const board: BoardWithId = {
    ...fixtures.boards,
    id: ENG_ID,
    access: { [UID_ASHA]: 'admin', [UID_PRIYA]: 'viewer' },
    aggFields: [
      { id: 'cost', label: 'Cost', unit: '$', period: 'daily', position: 0 },
      { id: 'a_hours1', label: 'Time', unit: 'h', period: 'weekly', position: 1 },
    ],
    aggs: { cost: { total: 3, count: 3 }, a_hours1: { total: 2, count: 1 } },
  };
  const members = [
    { ...fixtures.members, uid: UID_ASHA, name: 'Asha', email: 'asha@example.com', role: 'admin' },
    {
      ...fixtures.members,
      uid: UID_PRIYA,
      name: 'Priya',
      email: 'priya@example.com',
      role: 'viewer',
    },
  ] as BoardMember[];
  const t = (n: number, o: Partial<TicketWithId> = {}): TicketWithId => ({
    ...fixtures.tickets,
    id: `t${n}`,
    boardId: ENG_ID,
    key: `ENG-${n}`,
    number: n,
    rank: `a${n}`,
    ...o,
  });
  // ENG-1's thread: two messages inline, two in the frozen page data/000.
  const msg = (id: string, at: number, o: Partial<StoredMessage> = {}): StoredMessage => ({
    ...fixtures.messages,
    attachments: [],
    id,
    createdAt: at,
    markdown: `message ${id}`,
    ...o,
  });
  const pages: Record<string, StoredMessage[]> = {
    't1/0': [msg('m1', 1), msg('m2', 2)],
  };
  const attachment = { ...fixtures.messages.attachments[0]!, id: 'att_1' };
  const aggStats: (AggStats & { id: string })[] = [
    {
      id: 'daily:2026-10-01',
      period: 'daily',
      key: '2026-10-01',
      fields: { cost: { total: 1, count: 1, tickets: { 'ENG-1': { total: 1, count: 1 } } } },
      updatedAt: 1,
    },
    {
      id: 'daily:2026-10-02',
      period: 'daily',
      key: '2026-10-02',
      fields: { cost: { total: 2, count: 2, tickets: { 'ENG-2': { total: 2, count: 2 } } } },
      updatedAt: 2,
    },
    {
      id: 'weekly:2026-W40',
      period: 'weekly',
      key: '2026-W40',
      fields: { a_hours1: { total: 2, count: 1, tickets: { 'ENG-1': { total: 2, count: 1 } } } },
      updatedAt: 2,
    },
  ];
  const pageReads: string[] = [];
  const fileAsks: string[] = [];
  let tickets: TicketWithId[] = [
    t(1, {
      title: 'Mine',
      assigneeUids: [viewer],
      pageCount: 1,
      recentMessages: [
        msg('m3', 3, { attachments: [attachment] }),
        msg('m4', 4, { kind: 'agg', agg: { entries: [{ fieldId: 'a_hours1', value: 2 }] } }),
      ],
      files: [],
    }),
    t(2, { title: 'Theirs', assigneeUids: [UID_PRIYA], stageId: 'st_rev' }),
    t(3, { title: 'Old', state: 'archived' }),
  ];
  const writes: { op: string; args: unknown[] }[] = [];
  const watchers = new Set<() => void>();
  const changed = () => watchers.forEach((w) => w());

  const backend: TicketBackend = {
    board: async (id) => (id === ENG_ID ? board : null),
    members: async () => members,
    list: async (_b, state, stageId) =>
      tickets.filter((x) => x.state === state && (!stageId || x.stageId === stageId)),
    onList(_b, state, stageId, next) {
      const fire = () =>
        next(tickets.filter((x) => x.state === state && (!stageId || x.stageId === stageId)));
      watchers.add(fire);
      queueMicrotask(fire);
      return () => void watchers.delete(fire);
    },
    byKey: async (_b, key) => tickets.find((x) => x.key === key) ?? null,
    async create(input) {
      writes.push({ op: 'create', args: [input] });
      const n = tickets.length + 1;
      tickets = [...tickets, t(n, { title: input.title, assigneeUids: input.assigneeUids ?? [] })];
      changed();
      return { ticketId: `t${n}`, key: `ENG-${n}` };
    },
    async update(boardId, ticketId, patch) {
      writes.push({ op: 'update', args: [boardId, ticketId, patch] });
      tickets = tickets.map((x) => (x.id === ticketId ? { ...x, ...patch } : x));
      changed();
    },
    async comment(boardId, ticketId, body, markdown) {
      writes.push({ op: 'comment', args: [boardId, ticketId, body, markdown] });
      tickets = tickets.map((x) =>
        x.id === ticketId
          ? {
              ...x,
              recentMessages: [
                ...(x.recentMessages ?? []),
                msg(`c${writes.length}`, 100 + writes.length, { markdown }),
              ],
            }
          : x,
      );
      changed();
    },
    onTicket(_b, ticketId, next) {
      const fire = () => next(tickets.find((x) => x.id === ticketId) ?? null);
      watchers.add(fire);
      queueMicrotask(fire);
      return () => void watchers.delete(fire);
    },
    async page(_b, ticketId, n) {
      pageReads.push(`${ticketId}/${n}`);
      return pages[`${ticketId}/${n}`] ?? null;
    },
    onBoard(id, next) {
      const fire = () => next(id === ENG_ID ? board : null);
      queueMicrotask(fire);
      return () => {};
    },
    aggStats: async (_b, period, from, to) => statsIn(period, from, to),
    onAggStats(_b, period, from, to, next) {
      queueMicrotask(() => next(statsIn(period, from, to)));
      return () => {};
    },
    async fileAccess(path) {
      fileAsks.push(path);
      return { url: `/api/files/blob?path=${encodeURIComponent(path)}`, expiresAt: 99 };
    },
  };
  /** The doc-id range the real query asks for. */
  const statsIn = (period: string, from: string, to: string | null) =>
    aggStats
      .filter(
        (d) =>
          d.id >= `${period}:${from}` && (to ? d.id <= `${period}:${to}` : d.id < `${period};`),
      )
      .map(({ id: _id, ...d }) => d);
  return { backend, writes, board, pageReads, fileAsks, attachment };
}
