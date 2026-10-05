import { describe, expect, it } from 'vitest';
import { fixtures } from '@tm/shared/schema/fixtures';
import { activeWorkspace, switcherItems } from './switcher';

const board = (id: string, key: string, name: string, archived = false) =>
  ({ ...fixtures.boards, id, key, name, archivedAt: archived ? 1 : null }) as never;
const art = (id: string, name: string) =>
  ({ ...fixtures.artifacts, id, name, archivedAt: null }) as never;
const boards = [
  board('b1', 'FL', 'FreeLance'),
  board('b2', 'FR', 'Review'),
  board('b3', 'HEA', 'Health'),
];
const artifacts = [art('a1', 'FL Dash'), art('a2', 'Health Dash')];
const ws = { ...fixtures.workspaces, id: 'w1', boardIds: ['b1', 'b2'], artifactIds: ['a1'] };
const leave = () => {};

describe('the title switcher (§AB3)', () => {
  it('in a workspace that holds the open item: its boards, its artifacts, then a way out', () => {
    const w = activeWorkspace([ws], 'w1', { artifactId: 'a1' });
    expect(w?.id).toBe('w1');
    const items = switcherItems({
      boards,
      artifacts,
      workspace: w,
      current: { artifactId: 'a1' },
      leave,
    });
    expect(items.map((i) => i.label)).toEqual([
      'FL · FreeLance',
      'FR · Review',
      expect.stringContaining('FL Dash'),
      'Show all artifacts',
    ]);
    expect(items[2]).toMatchObject({ disabled: true, separator: true });
  });
  it('a workspace that does not hold the open item is ignored', () => {
    expect(activeWorkspace([ws], 'w1', { artifactId: 'a2' })).toBeNull();
    expect(activeWorkspace([ws], null, { boardId: 'b1' })).toBeNull();
  });
  it('outside a workspace: every board on a board, every artifact on an artifact; archived left out', () => {
    const onBoard = switcherItems({
      boards: [...boards, board('b4', 'OLD', 'Old', true)],
      artifacts,
      workspace: null,
      current: { boardId: 'b3' },
      leave,
    });
    expect(onBoard.map((i) => i.label)).toEqual(['FL · FreeLance', 'HEA · Health', 'FR · Review']);
    const onArtifact = switcherItems({
      boards,
      artifacts,
      workspace: null,
      current: { artifactId: 'a2' },
      leave,
    });
    expect(onArtifact.map((i) => i.label)).toEqual([
      expect.stringContaining('FL Dash'),
      expect.stringContaining('Health Dash'),
    ]);
  });
});
