import { describe, expect, it } from 'vitest';
import { fixtures } from '@tm/shared/schema/fixtures';
import { ownerOrg, switcherItems } from './switcher';

const board = (id: string, key: string, name: string, ownerKey?: string, archived = false) =>
  ({ ...fixtures.boards, id, key, name, ownerKey, archivedAt: archived ? 1 : null }) as never;
const art = (id: string, name: string, ownerKey?: string) =>
  ({ ...fixtures.artifacts, id, name, ownerKey, archivedAt: null }) as never;
const boards = [
  board('b1', 'FL', 'FreeLance', 'org:o1'),
  board('b2', 'FR', 'Review', 'org:o1'),
  board('b3', 'HEA', 'Health', 'user:u1'),
];
const artifacts = [art('a1', 'FL Dash', 'org:o1'), art('a2', 'Health Dash', 'user:u1')];
const org = { id: 'o1', name: 'Freelance', handle: 'freelance' } as never;

describe('the title switcher (§AC)', () => {
  it('an item an org of mine owns: that org’s boards, then its artifacts', () => {
    const o = ownerOrg([org], { boards, artifacts }, { artifactId: 'a1' });
    expect(o).toBe(org);
    const items = switcherItems({ boards, artifacts, org: o, current: { artifactId: 'a1' } });
    expect(items.map((i) => i.label)).toEqual([
      'FL · FreeLance',
      'FR · Review',
      expect.stringContaining('FL Dash'),
    ]);
    expect(items[2]).toMatchObject({ disabled: true, separator: true });
  });
  it('a personal item: every board (or artifact), archived ones left out', () => {
    expect(ownerOrg([org], { boards, artifacts }, { boardId: 'b3' })).toBeNull();
    const items = switcherItems({
      boards: [...boards, board('b4', 'OLD', 'Old', 'user:u1', true)],
      artifacts,
      org: null,
      current: { boardId: 'b3' },
    });
    expect(items.map((i) => i.label)).toEqual(['FL · FreeLance', 'HEA · Health', 'FR · Review']);
  });
});
