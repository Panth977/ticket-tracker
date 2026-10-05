import { describe, expect, it } from 'vitest';
import {
  boardsOfAgent,
  boardsToAddAgent,
  draftErrors,
  draftPatch,
  freshAgentId,
  sortAgents,
} from './agents';
import { agentRoutes } from './routes';
import type { Board } from '@tm/shared';

const AG = 'ag_AAAAAAAAAAAAAAAA';
const board = (
  id: string,
  name: string,
  access: Record<string, string>,
  archivedAt: number | null = null,
) => ({ id, name, access, archivedAt }) as unknown as Board & { id: string };

describe('agents', () => {
  it('mints valid ids', () => {
    expect(freshAgentId()).toMatch(/^ag_[A-Za-z0-9]{16}$/);
  });
  it('sorts active by name, archived last', () => {
    const list = [
      { name: 'Zed', archivedAt: null },
      { name: 'Old', archivedAt: 5 },
      { name: 'Amy', archivedAt: null },
      { name: 'Older', archivedAt: 1 },
    ];
    expect(sortAgents(list).map((a) => a.name)).toEqual(['Amy', 'Zed', 'Old', 'Older']);
  });
  it('finds the boards an agent is on and the ones I can add it to', () => {
    const boards = [
      board('b1', 'Eng', { me: 'admin', [AG]: 'editor' }),
      board('b2', 'Ops', { me: 'admin' }),
      board('b3', 'Mkt', { me: 'editor' }),
      board('b4', 'Old', { me: 'admin', [AG]: 'viewer' }, 9),
    ];
    expect(boardsOfAgent(boards, AG).map((r) => [r.board.id, r.role])).toEqual([['b1', 'editor']]);
    expect(boardsToAddAgent(boards, 'me', AG).map((b) => b.id)).toEqual(['b2']);
  });
  it('validates and diffs a draft', () => {
    expect(draftErrors({ name: ' ', description: '', systemPrompt: '' }).name).toBeTruthy();
    expect(
      draftErrors({ name: 'B', description: 'x'.repeat(201), systemPrompt: '' }).description,
    ).toBeTruthy();
    expect(
      draftErrors({ name: 'B', description: '', systemPrompt: 'x'.repeat(50_001) }).systemPrompt,
    ).toBeTruthy();
    expect(draftErrors({ name: 'B', description: '', systemPrompt: '' })).toEqual({});
    const saved = { name: 'Builder', description: null, systemPrompt: 'hi' };
    expect(draftPatch(saved, { name: 'Builder ', description: '', systemPrompt: 'hi' })).toEqual(
      {},
    );
    expect(
      draftPatch(saved, { name: 'B2', description: 'Writes code', systemPrompt: 'yo' }),
    ).toEqual({
      name: 'B2',
      description: 'Writes code',
      systemPrompt: 'yo',
    });
    expect(
      draftPatch(
        { ...saved, description: 'x' },
        { name: 'Builder', description: ' ', systemPrompt: 'hi' },
      ),
    ).toEqual({ description: null });
  });
  it('builds routes', () => {
    expect(agentRoutes.agent(AG)).toBe(`/agents/${AG}`);
  });
});
