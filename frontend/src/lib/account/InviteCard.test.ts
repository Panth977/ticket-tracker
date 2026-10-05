// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const command = vi.fn();
vi.mock('$lib/api', () => ({ command: (...a: unknown[]) => command(...a) }));
// lucide-svelte ships Svelte 4 components; this project compiles everything in runes mode.
// indicators.html: the entity mark pulls in lucide icons this test does not stub.
vi.mock('$lib/ui/indicatorIcons', () => ({
  INDICATOR_ICON_COMPONENTS: {},
  iconLabel: (s: string) => s,
}));
vi.mock('$lib/ui/Indicator.svelte', async () => ({
  default: (await import('./IconStub.test.svelte')).default,
}));
vi.mock('lucide-svelte', async () => {
  const Stub = (await import('./IconStub.test.svelte')).default;
  const names = [
    'CalendarDays',
    'Check',
    'ChevronLeft',
    'ChevronRight',
    'CircleAlert',
    'CircleCheck',
    'Info',
    'Mail',
    'X',
  ];
  return Object.fromEntries(names.map((n) => [n, Stub]));
});
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/ui/toast.svelte', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { default: InviteCard } = await import('./InviteCard.svelte');

const invite = {
  id: 'inv1',
  boardId: 'b1',
  boardName: 'Operations',
  boardKey: 'OPS',
  email: 'asha@x.com',
  role: 'commenter' as const,
  invitedBy: 'u-priya',
  invitedByName: 'Priya',
  message: 'Join us',
  tokenHash: 'h',
  status: 'pending' as const,
  expiresAt: Date.now() + 1e6,
  createdAt: Date.now() - 60_000,
};

afterEach(() => {
  cleanup();
  command.mockReset();
});

describe('InviteCard', () => {
  it('says who invited you to what, as which role', () => {
    render(InviteCard, { props: { invite } });
    expect(screen.getByText('Priya')).toBeTruthy();
    expect(screen.getByText('OPS')).toBeTruthy();
    expect(screen.getByText('Commenter')).toBeTruthy();
    expect(screen.getByText('“Join us”')).toBeTruthy();
  });
  it('accepts through inviteAccept and reports the board', async () => {
    command.mockResolvedValue({ boardId: 'b1', boardKey: 'OPS' });
    const onaccepted = vi.fn();
    render(InviteCard, { props: { invite, onaccepted } });
    await fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await vi.waitFor(() =>
      expect(onaccepted).toHaveBeenCalledWith({ boardId: 'b1', boardKey: 'OPS' }),
    );
    expect(command.mock.calls[0]![0]).toBe('inviteAccept');
    expect(command.mock.calls[0]![1]).toEqual({ inviteId: 'inv1', accept: true });
  });
  it('declines without calling onaccepted', async () => {
    command.mockResolvedValue({ boardId: 'b1', boardKey: 'OPS' });
    const onaccepted = vi.fn();
    render(InviteCard, { props: { invite, onaccepted } });
    await fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await vi.waitFor(() => expect(command).toHaveBeenCalled());
    expect(command.mock.calls[0]![1]).toEqual({ inviteId: 'inv1', accept: false });
    expect(onaccepted).not.toHaveBeenCalled();
  });
});
