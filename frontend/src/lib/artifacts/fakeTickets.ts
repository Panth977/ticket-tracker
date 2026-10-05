/**
 * TESTS ONLY — an in-memory TicketBackend (./brokerTickets) for broker.test.ts
 * and endToEnd.test.ts: the ENG board of the shared fixtures, its two people,
 * a few tickets, and a recording of every write. Board 'SEC' exists too but
 * the viewer is not on it (board() answers null, as the rules would make it).
 */
import { fixtures, UID_ASHA, UID_PRIYA } from '@tm/shared/schema/fixtures';
import type { BoardMember, BoardWithId, TicketWithId } from '@tm/shared';
import type { TicketBackend } from './brokerTickets';

export const ENG_ID = 'board_eng';
export const SEC_ID = 'board_sec';

export function fakeTickets(viewer = UID_ASHA) {
  const board: BoardWithId = {
    ...fixtures.boards,
    id: ENG_ID,
    access: { [UID_ASHA]: 'admin', [UID_PRIYA]: 'viewer' },
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
  let tickets: TicketWithId[] = [
    t(1, { title: 'Mine', assigneeUids: [viewer] }),
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
    },
  };
  return { backend, writes, board };
}
