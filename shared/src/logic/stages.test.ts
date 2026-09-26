import { describe, expect, it } from 'vitest';
import { firstStage, orderedStages } from './stages.js';

const board = {
  stages: [
    { id: 'st_done', name: 'Done', color: 'green', category: 'done' as const, position: 4 },
    { id: 'st_todo', name: 'To do', color: 'slate', category: 'todo' as const, position: 1 },
    { id: 'st_backlog', name: 'Backlog', color: 'gray', category: 'backlog' as const, position: 0 },
    {
      id: 'st_doing',
      name: 'In progress',
      color: 'blue',
      category: 'active' as const,
      position: 2,
    },
  ],
};

describe('stages', () => {
  it('orders by position, whatever order they are stored in', () => {
    expect(orderedStages(board).map((s) => s.id)).toEqual([
      'st_backlog',
      'st_todo',
      'st_doing',
      'st_done',
    ]);
  });

  it('§Q3: a ticket with no stage starts in the first stage BY POSITION, not the first "todo" one', () => {
    expect(firstStage(board).id).toBe('st_backlog');
    expect(firstStage(board).category).toBe('backlog');
  });

  it('a one-stage board answers with that stage', () => {
    const one = {
      stages: [
        { id: 'st_only', name: 'Only', color: 'slate', category: 'todo' as const, position: 7 },
      ],
    };
    expect(firstStage(one).id).toBe('st_only');
  });
});
