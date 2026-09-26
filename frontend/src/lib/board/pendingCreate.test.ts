import { describe, expect, it } from 'vitest';
import type { OutboxEntry } from '$lib/api';
import { pendingCreates } from './pendingCreate';

const board = {
  id: 'b1',
  key: 'ENG',
  stages: [
    { id: 's0', name: 'Backlog', category: 'backlog', position: 0 },
    { id: 's1', name: 'To do', category: 'todo', position: 1 },
    { id: 's2', name: 'Doing', category: 'active', position: 2 },
  ],
} as never;

const create = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id: 'e1',
  uid: 'u1',
  command: 'ticketCreate',
  input: { boardId: 'b1', ticketId: 't-new', title: 'Fix login copy', stageId: 's2' },
  kind: 'ticketCreate',
  label: 'create “Fix login copy”',
  status: 'sending',
  attempts: 1,
  createdAt: 5,
  boardId: 'b1',
  persist: true,
  ...over,
});

describe('pending ticket cards', () => {
  it('a queued create shows as KEY-… in its stage, sending', () => {
    const { tickets, state } = pendingCreates([create()], board, 'u1', new Set());
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      id: 't-new',
      key: 'ENG-…',
      title: 'Fix login copy',
      stageId: 's2',
      stageCategory: 'active',
      state: 'active',
    });
    expect(state.get('t-new')).toEqual({ state: 'sending', entryId: 'e1' });
  });

  it('defaults to the first to-do stage', () => {
    const { tickets } = pendingCreates(
      [create({ input: { boardId: 'b1', ticketId: 't2', title: 'x' } })],
      board,
      'u1',
      new Set(),
    );
    expect(tickets[0]!.stageId).toBe('s1');
  });

  it('a failed create is marked failed (red edge)', () => {
    const { state } = pendingCreates([create({ status: 'failed' })], board, 'u1', new Set());
    expect(state.get('t-new')?.state).toBe('failed');
  });

  it('gives way to the real ticket once the listener delivers it', () => {
    const { tickets } = pendingCreates(
      [create({ status: 'sent' })],
      board,
      'u1',
      new Set(['t-new']),
    );
    expect(tickets).toHaveLength(0);
  });

  it('ignores other boards and other kinds', () => {
    const { tickets } = pendingCreates(
      [create({ boardId: 'b2' }), create({ id: 'e2', kind: 'message' })],
      board,
      'u1',
      new Set(),
    );
    expect(tickets).toHaveLength(0);
  });
});
