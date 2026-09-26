import { describe, expect, it } from 'vitest';
import {
  agentToPerson,
  matchPrincipals,
  memberToPerson,
  principalDetail,
  principalLabel,
  sortPrincipals,
  unknownAgent,
} from './principal';

const AG = 'ag_AAAAAAAAAAAAAAAA';
const AG2 = 'ag_BBBBBBBBBBBBBBBB';
const members = [
  {
    uid: AG,
    name: 'Builder',
    email: '',
    kind: 'agent' as const,
    description: 'Writes code',
    ownerUid: 'u1',
  },
  { uid: 'u2', name: 'Priya Shah', email: 'priya@acme.com', kind: 'user' as const },
  { uid: AG2, name: 'Auditor', email: '', description: null },
  { uid: 'u1', name: 'Anil Kumar', email: 'anil@acme.com' },
];

describe('principals', () => {
  it('carries an agent icon from the profile or the member row; never for people', () => {
    expect(
      agentToPerson(
        AG,
        { name: 'Builder', ownerUid: 'u1', description: null, icon: 'claude' },
        null,
      ).icon,
    ).toBe('claude');
    expect(
      agentToPerson(AG, { name: 'Builder', ownerUid: 'u1', description: null }, null).icon,
    ).toBeNull();
    expect(memberToPerson({ ...members[0]!, icon: 'gemini' }, null).icon).toBe('gemini');
    expect(memberToPerson(members[0]!, null).icon).toBeNull();
    expect(memberToPerson({ ...members[1]!, icon: 'gemini' }, null)).not.toHaveProperty('icon');
    expect(unknownAgent(AG).icon).toBeNull();
  });
  it('maps a member row, telling agents by kind or id prefix', () => {
    expect(memberToPerson(members[0]!, null)).toMatchObject({
      kind: 'agent',
      email: '',
      ownerUid: 'u1',
      description: 'Writes code',
    });
    expect(memberToPerson(members[2]!, null).kind).toBe('agent');
    expect(memberToPerson(members[1]!, 'x')).toMatchObject({
      kind: 'user',
      email: 'priya@acme.com',
      avatarUrl: 'x',
    });
  });
  it('maps an agent profile; archived reads as deleted', () => {
    const p = agentToPerson(
      AG,
      { name: 'Builder', ownerUid: 'u1', description: null, archivedAt: 5 },
      null,
    );
    expect(p).toMatchObject({ kind: 'agent', deleted: true, ownerUid: 'u1' });
    expect(unknownAgent(AG).name).toBe('Agent');
  });
  it('labels and details', () => {
    expect(principalLabel({ name: 'Builder', kind: 'agent' })).toBe('Builder (agent)');
    expect(principalLabel({ name: 'Priya', kind: 'user' })).toBe('Priya');
    expect(principalLabel(null)).toBe('Someone');
    expect(principalDetail({ kind: 'agent', email: '', description: 'Writes code' })).toBe(
      'Writes code',
    );
    expect(principalDetail({ kind: 'user', email: 'a@b.c' })).toBe('a@b.c');
  });
  it('sorts people first, then agents, by name', () => {
    expect(sortPrincipals(members).map((m) => m.name)).toEqual([
      'Anil Kumar',
      'Priya Shah',
      'Auditor',
      'Builder',
    ]);
  });
  it('matches people and agents', () => {
    expect(matchPrincipals('bu', members).map((m) => m.uid)).toEqual([AG]);
    expect(matchPrincipals('@shah', members).map((m) => m.uid)).toEqual(['u2']);
    expect(matchPrincipals('agent', members).map((m) => m.uid)).toEqual([AG2, AG]);
    expect(matchPrincipals('code', members).map((m) => m.uid)).toEqual([AG]);
    expect(matchPrincipals('', members)).toHaveLength(4);
  });
});
