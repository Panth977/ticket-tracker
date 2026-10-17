import { describe, expect, it } from 'vitest';
import type { Org } from '@tm/shared';
import { ownerGroups } from './owners';

const org = (id: string, name: string, members: Org['members']): Org & { id: string } =>
  ({
    id,
    name,
    handle: name.toLowerCase(),
    members,
    memberUids: Object.keys(members),
    baseRole: 'editor',
  }) as unknown as Org & { id: string };
const thing = (id: string, ownerKey: string, ownerHandle?: string) => ({
  id,
  name: id,
  ownerKey,
  ownerHandle,
});

describe('ownerGroups (§AC: everything under its owner)', () => {
  it('me first, then the people who share with me; my orgs, then orgs I only reach a thing of', () => {
    const { orgs, users } = ownerGroups({
      me: 'u_me',
      myHandle: 'me',
      orgs: [org('o2', 'Zeta', { u_me: 'member' }), org('o1', 'Acme', { u_me: 'admin' })],
      boards: [
        thing('b1', 'user:u_me'),
        thing('b2', 'org:o1'),
        thing('b3', 'user:u_bo', 'bo'),
        thing('b4', 'org:o9', 'other'),
      ],
      artifacts: [thing('a1', 'user:u_al', 'al')],
      buckets: [thing('m1', 'org:o2')],
      dictionaries: [thing('d1', 'org:o1'), thing('d2', 'user:u_al', 'al')],
    });
    expect(users.map((g) => [g.key, g.handle, g.canCreate])).toEqual([
      ['user:u_me', 'me', true],
      ['user:u_al', 'al', false],
      ['user:u_bo', 'bo', false],
    ]);
    expect(users[0]!.boards.map((b) => b.id)).toEqual(['b1']);
    expect(orgs.map((g) => [g.key, g.name ?? g.handle, g.myRole, g.canCreate])).toEqual([
      ['org:o1', 'Acme', 'admin', true],
      ['org:o2', 'Zeta', 'member', false],
      ['org:o9', 'other', null, false],
    ]);
    expect(orgs[1]!.buckets.map((m) => m.id)).toEqual(['m1']);
    expect(orgs[0]!.dictionaries.map((d) => d.id)).toEqual(['d1']);
    expect(users[1]!.dictionaries.map((d) => d.id)).toEqual(['d2']);
  });

  it('an empty space still shows me; things from before owners count as their creator’s', () => {
    const { orgs, users } = ownerGroups({
      me: 'u_me',
      myHandle: null,
      orgs: [],
      boards: [{ id: 'old', name: 'Old', createdBy: 'u_me' }],
      artifacts: [],
      buckets: [],
    });
    expect(orgs).toEqual([]);
    expect(users).toHaveLength(1);
    expect(users[0]!.boards.map((b) => b.id)).toEqual(['old']);
  });
});
