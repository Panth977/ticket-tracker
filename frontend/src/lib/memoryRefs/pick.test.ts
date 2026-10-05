import { describe, expect, it } from 'vitest';
import type { MemoryNodeOut } from '@tm/shared';
import { mergePicks, pickAttachment, pickerRows, toggleNode, toMemoryRefs, toPicks } from './pick';

const folder = (id: string, path: string, parentId: string | null): MemoryNodeOut => ({
  id,
  kind: 'folder',
  parentId,
  name: path.split('/').pop()!,
  path,
  file: null,
  updatedAt: 1,
});
const file = (id: string, path: string, parentId: string | null): MemoryNodeOut => ({
  id,
  kind: 'file',
  parentId,
  name: path.split('/').pop()!,
  path,
  file: { fileId: `f_${id}`, mime: 'image/png', size: 10 },
  updatedAt: 1,
});
const NODES = [
  file('n_readme', 'README.md', null),
  folder('n_docs', 'docs', null),
  file('n_logo', 'docs/logo.png', 'n_docs'),
  folder('n_old', 'docs/old', 'n_docs'),
  file('n_v1', 'docs/old/v1.png', 'n_old'),
];

describe('pickerRows', () => {
  it('folders first, then files; children only under open folders', () => {
    expect(pickerRows(NODES, new Set()).map((r) => r.node.path)).toEqual(['docs', 'README.md']);
    expect(
      pickerRows(NODES, new Set(['n_docs'])).map((r) => [r.node.path, r.depth, r.open]),
    ).toEqual([
      ['docs', 0, true],
      ['docs/old', 1, false],
      ['docs/logo.png', 1, false],
      ['README.md', 0, false],
    ]);
  });
  it('a filter shows matching files with their folders, unfolded', () => {
    expect(pickerRows(NODES, new Set(), 'V1').map((r) => r.node.path)).toEqual([
      'docs',
      'docs/old',
      'docs/old/v1.png',
    ]);
    expect(pickerRows(NODES, new Set(), 'nothing')).toEqual([]);
  });
});

describe('selection → what is sent', () => {
  it('only files toggle, up to the room left', () => {
    let s = toggleNode(new Set(), NODES[1]!, 5);
    expect(s.size).toBe(0);
    s = toggleNode(s, NODES[0]!, 1);
    s = toggleNode(s, NODES[2]!, 1);
    expect([...s]).toEqual(['n_readme']);
    expect([...toggleNode(s, NODES[0]!, 1)]).toEqual([]);
  });
  it('picks in path order, refs and the optimistic row use the virtual path', () => {
    const picks = toPicks({ id: 'mem001', name: 'Brand' }, NODES, new Set(['n_v1', 'n_logo']));
    expect(picks.map((p) => p.path)).toEqual(['docs/logo.png', 'docs/old/v1.png']);
    expect(picks[0]).toMatchObject({ memoryName: 'Brand', name: 'logo.png', mime: 'image/png' });
    expect(toMemoryRefs(picks)).toEqual([
      { memoryId: 'mem001', nodeId: 'n_logo' },
      { memoryId: 'mem001', nodeId: 'n_v1' },
    ]);
    expect(pickAttachment(picks[0]!)).toEqual({
      path: 'memories/mem001/nodes/n_logo',
      name: 'logo.png',
      size: 10,
      mime: 'image/png',
    });
    expect(mergePicks(picks, [...picks, picks[0]!], 3)).toHaveLength(2);
    expect(mergePicks([], picks, 1)).toHaveLength(1);
  });
});
