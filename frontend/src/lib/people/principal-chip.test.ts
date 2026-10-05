// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/svelte';
import { readable } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

const AG = 'ag_AAAAAAAAAAAAAAAA';
const people: Record<string, unknown> = {
  u1: {
    uid: 'u1',
    kind: 'user',
    name: 'Priya Shah',
    email: 'priya@acme.com',
    avatarUrl: null,
    deleted: false,
  },
  [AG]: {
    uid: AG,
    kind: 'agent',
    name: 'Builder',
    email: '',
    avatarUrl: null,
    deleted: false,
    ownerUid: 'u1',
    description: 'Writes code',
  },
};

// indicators.html: the entity mark pulls in lucide icons this test does not stub.
vi.mock('$lib/ui/indicatorIcons', () => ({
  INDICATOR_ICON_COMPONENTS: {},
  iconLabel: (s: string) => s,
}));
vi.mock('$lib/ui/Indicator.svelte', async () => ({
  default: (await import('../account/IconStub.test.svelte')).default,
}));
vi.mock('lucide-svelte', async () => {
  const Stub = (await import('../account/IconStub.test.svelte')).default;
  return Object.fromEntries(['Bot', 'X', 'Check', 'Copy'].map((n) => [n, Stub]));
});
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/firebase/auth.svelte', () => ({ auth: { uid: 'me' } }));
vi.mock('./person', () => ({
  person: (id: string | null | undefined) =>
    readable({ loading: false, person: id ? (people[id] ?? null) : null, error: null }),
}));

const { default: Principal } = await import('./Principal.svelte');

afterEach(cleanup);

describe('Principal', () => {
  it('draws a person with their email and no badge', () => {
    const { container } = render(Principal, { id: 'u1' });
    expect(container.textContent).toContain('Priya Shah');
    expect(container.textContent).toContain('priya@acme.com');
    expect(container.querySelector('[data-agent-badge]')).toBeNull();
    expect(container.querySelector('[data-principal="user"]')).not.toBeNull();
  });
  it('draws an agent with the Agent badge, its description and owner', () => {
    const { container } = render(Principal, { id: AG, layout: 'stacked' });
    expect(container.textContent).toContain('Builder');
    expect(container.querySelector('[data-agent-badge]')).not.toBeNull();
    expect(container.querySelector('[data-agent-mark]')).not.toBeNull();
    expect(container.textContent).toContain('Writes code');
    expect(container.textContent).toContain('by Priya Shah');
  });
});
