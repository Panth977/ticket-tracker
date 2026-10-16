/** A ticket template's answer → ticketCreate (templates.html §D2). */
import { describe, expect, it } from 'vitest';
import type { Board } from '@tm/shared';
import { checkMessageResult, checkTicketResult, resolveTicket } from './resolve';
import type { MemberInfo } from './info';

const board = {
  stages: [
    { id: 's_todo', name: 'To do', color: '#000', category: 'todo', position: 0 },
    { id: 's_doing', name: 'In progress', color: '#000', category: 'active', position: 1 },
  ],
  priorities: [{ id: 'p_hi', name: 'High', position: 0 }],
  tags: [{ id: 't_bug', name: 'bug', position: 0 }],
  fields: [
    {
      id: 'f_area01',
      name: 'Area',
      type: 'select',
      options: [{ id: 'o_fe', name: 'Frontend', position: 0 }],
      position: 0,
    },
    { id: 'f_pts001', name: 'Points', type: 'number', position: 1 },
    { id: 'f_owner1', name: 'Owner', type: 'person', position: 2 },
  ],
} as unknown as Pick<Board, 'stages' | 'priorities' | 'tags' | 'fields'>;
const members: MemberInfo[] = [
  { id: 'u_priya', kind: 'user', name: 'Priya', email: 'priya@example.com', role: 'editor' },
  { id: 'ag_bot', kind: 'agent', name: 'Builder', email: '', role: 'editor' },
];
const opts = { now: Date.UTC(2026, 9, 16, 12), tz: 'UTC' };

describe('resolveTicket', () => {
  it('names → ids, new tags, dates', () => {
    const r = resolveTicket(
      {
        title: ' Fix login ',
        stage: 'in progress',
        priority: 'High',
        tags: ['bug', 'Auth'],
        assignees: ['priya@example.com', 'Builder'],
        dueAt: '2026-10-20',
        fields: { Area: 'Frontend', Points: '3', f_owner1: 'Priya' },
      },
      board,
      members,
      opts,
    );
    expect(r.problems).toEqual([]);
    expect(r.newTags).toEqual(['Auth']);
    expect(r.input).toMatchObject({
      title: 'Fix login',
      stageId: 's_doing',
      priorityId: 'p_hi',
      tagIds: ['t_bug'],
      assigneeUids: ['u_priya', 'ag_bot'],
      dueAt: Date.UTC(2026, 9, 20),
      dueAllDay: true,
      fields: { f_area01: 'o_fe', f_pts001: 3, f_owner1: 'u_priya' },
    });
  });

  it('defaults to the first stage; names that name nothing are problems', () => {
    const r = resolveTicket(
      {
        title: 'x',
        stage: 'Nope',
        assignees: ['ghost@example.com'],
        fields: { Area: 'Mars', Size: 1 },
      },
      board,
      members,
      opts,
    );
    expect(r.input.stageId).toBe('s_todo');
    expect(r.problems).toEqual([
      'No stage called “Nope”',
      'Nobody on this board is “ghost@example.com”',
      'Area: no option “Mars”',
      'No field called “Size”',
    ]);
  });
});

describe('submit results', () => {
  it('message: valid, invalid with field errors, and broken shapes', () => {
    expect(checkMessageResult({ type: 'valid', msg: 'Hi', data: { a: 1 } })).toEqual({
      kind: 'valid',
      value: { msg: 'Hi', data: { a: 1 } },
    });
    expect(checkMessageResult({ type: 'invalid', error: { steps: 'Required' } })).toEqual({
      kind: 'invalid',
      errMsg: '',
      errors: { steps: 'Required' },
    });
    expect(checkMessageResult({ type: 'invalid', errMsg: 'No' })).toMatchObject({ errMsg: 'No' });
    expect(checkMessageResult({ type: 'valid' }).kind).toBe('broken');
    expect(checkMessageResult('nope').kind).toBe('broken');
  });

  it('ticket: the ticket object, strictly', () => {
    expect(checkTicketResult({ type: 'valid', ticket: { title: 'T' } })).toEqual({
      kind: 'valid',
      value: { title: 'T' },
    });
    expect(checkTicketResult({ type: 'valid', ticket: { title: 'T', colour: 'red' } }).kind).toBe(
      'broken',
    );
  });
});
