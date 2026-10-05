import { describe, expect, it } from 'vitest';
import { fixtures, UID_ASHA, UID_PRIYA } from '../schema/fixtures.js';
import type { TicketWithId } from '../schema/ticket.js';
import {
  applyTicketPlan,
  boardKeyOfTicketKey,
  planTicketQuery,
  ticketInputToCommand,
  toDriverBoard,
  toDriverPerson,
  toDriverTicket,
} from './tickets.js';

const board = { ...fixtures.boards, id: 'b1' };
const members = [
  { uid: UID_ASHA, kind: 'user' as const, name: 'Asha', email: 'asha@example.com' },
  { uid: UID_PRIYA, kind: 'user' as const, name: 'Priya', email: 'priya@example.com' },
];
const people = new Map(members.map((m) => [m.uid, toDriverPerson(m)]));
const ticket = (o: Partial<TicketWithId> = {}): TicketWithId => ({
  ...fixtures.tickets,
  id: 't1',
  boardId: 'b1',
  fields: { f_client: 'o_acme', f_soluti: 'Use a cookie' },
  ...o,
});

describe('§K tickets as an artifact sees them', () => {
  it('a board: names in order, the grant, and whether this viewer may write', () => {
    const b = toDriverBoard(board, 'write', true, members);
    expect(b.stages.map((s) => s.name)).toEqual(['To do', 'In review', 'Done']);
    expect(b.fields.find((f) => f.name === 'Client')!.options).toEqual(['Acme']);
    expect(b.canWrite).toBe(true);
    // A read grant never writes, whatever the viewer's role.
    expect(toDriverBoard(board, 'read', true, members).canWrite).toBe(false);
    expect(toDriverBoard(board, 'write', false, members).canWrite).toBe(false);
  });

  it('a ticket: names not ids, Markdown, select options by name, a link into the app', () => {
    const t = toDriverTicket(board, ticket(), people, 'https://app.example');
    expect(t).toMatchObject({
      key: 'ENG-1',
      board: 'ENG',
      url: 'https://app.example/t/ENG-1',
      stage: { id: 'st_todo', name: 'To do' },
      priority: { id: 'p_high', name: 'High' },
      tags: ['bug'],
      assignees: [{ id: UID_PRIYA, name: 'Priya', email: 'priya@example.com' }],
      fields: { Client: 'Acme', Solution: 'Use a cookie' },
    });
    expect(typeof t.description).toBe('string');
  });

  it('input: names → ids, me → the viewer, dates parsed, unknown names refused with the choices', () => {
    const out = ticketInputToCommand(
      board,
      members,
      {
        title: ' Ship it ',
        stage: 'in review',
        priority: 'High',
        tags: ['bug'],
        assignees: ['me', 'priya@example.com'],
        dueAt: '2026-10-10',
        fields: { Client: 'Acme' },
        description: 'Hello **there**',
      },
      UID_ASHA,
    );
    expect(out).toMatchObject({
      title: 'Ship it',
      stageId: 'st_rev',
      priorityId: 'p_high',
      tagIds: ['tg_bug'],
      assigneeUids: [UID_ASHA, UID_PRIYA],
      dueAt: Date.parse('2026-10-10'),
      fields: { f_client: 'o_acme' },
    });
    expect(out.description?.type).toBe('doc');
    expect(() => ticketInputToCommand(board, members, { stage: 'Nope' }, UID_ASHA)).toThrow(
      /Unknown stage "Nope" \(have: To do, In review, Done\)/,
    );
    expect(() => ticketInputToCommand(board, members, { assignees: ['x@y.z'] }, UID_ASHA)).toThrow(
      /not on this board/,
    );
    expect(() => ticketInputToCommand(board, members, { dueAt: 'soon' }, UID_ASHA)).toThrow(
      /dueAt/,
    );
    // An update patches only what it names; null clears.
    expect(ticketInputToCommand(board, members, { priority: null }, UID_ASHA)).toEqual({
      priorityId: null,
    });
  });

  it('queries: resolve, filter, sort, cap', () => {
    const plan = planTicketQuery(board, members, { assignee: 'me', orderBy: 'due' }, UID_PRIYA);
    expect(plan).toMatchObject({ state: 'active', assignee: UID_PRIYA, limit: 200 });
    const ts = [
      ticket({ id: 'a', dueAt: 300, assigneeUids: [UID_PRIYA] }),
      ticket({ id: 'b', dueAt: 100, assigneeUids: [UID_PRIYA] }),
      ticket({ id: 'c', dueAt: 50, assigneeUids: [UID_ASHA] }),
      ticket({ id: 'd', dueAt: 10, assigneeUids: [UID_PRIYA], state: 'archived' }),
    ];
    expect(applyTicketPlan(ts, plan).map((t) => t.id)).toEqual(['b', 'a']);
    const unassigned = planTicketQuery(board, members, { assignee: null }, UID_PRIYA);
    expect(applyTicketPlan([ticket({ assigneeUids: [] }), ...ts], unassigned)).toHaveLength(1);
    expect(planTicketQuery(board, members, { limit: 10_000 }, UID_ASHA).limit).toBe(500);
    expect(() => planTicketQuery(board, members, { orderBy: 'x' as never }, UID_ASHA)).toThrow();
  });

  it('a ticket key names its board', () => {
    expect(boardKeyOfTicketKey('ENG-42')).toBe('ENG');
    expect(boardKeyOfTicketKey('#eng-7')).toBe('ENG');
    expect(boardKeyOfTicketKey('nope')).toBeNull();
  });
});
