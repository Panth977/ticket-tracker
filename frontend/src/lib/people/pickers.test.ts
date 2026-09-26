import { describe, expect, it, vi } from 'vitest';

vi.mock('./person', () => ({
  avatarUrl: async (p: string | null) => (p ? `https://img/${p}` : null),
}));
const { principalChoices, principalSuggestItems } = await import('./pickers');

const AG = 'ag_AAAAAAAAAAAAAAAA';
const members = [
  {
    uid: AG,
    name: 'Builder',
    email: '',
    kind: 'agent' as const,
    description: 'Writes code',
    avatarPath: 'a.webp',
    icon: 'claude' as const,
  },
  { uid: 'u1', name: 'Priya', email: 'priya@acme.com', avatarPath: null },
];

describe('principal pickers (agents.html §D)', () => {
  it('lists people then agents for the assignee picker', () => {
    expect(principalChoices(members)).toEqual([
      { id: 'u1', label: 'Priya', uid: 'u1', search: 'priya@acme.com', agent: false },
      { id: AG, label: 'Builder', uid: AG, search: 'agent bot Writes code', agent: true },
    ]);
  });
  it('feeds the @ menu, marking agents', async () => {
    const items = await principalSuggestItems(members, 'bui');
    expect(items).toEqual([
      {
        id: AG,
        kind: 'person',
        uid: AG,
        label: 'Builder',
        detail: 'Agent · Writes code',
        avatarUrl: 'https://img/a.webp',
        icon: 'claude',
        agent: true,
      },
    ]);
    expect((await principalSuggestItems(members, '')).map((i) => i.uid)).toEqual(['u1', AG]);
  });
});
