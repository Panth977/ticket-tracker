// @vitest-environment jsdom
/**
 * Phase 8 (§P2) — THE CARD, as a person sees it: which badges are up, which
 * are not drawn at all, and who is allowed to change the assignees from here.
 *
 * TicketSummary takes plain props (that is what lets the kanban, the table's
 * title cell and My work share it), so it renders with no board context. §W
 * left nothing live to stub for the unread count — it is counted from the
 * ticket's own `recentMessages` — so only the agent health dot, the avatars
 * and the icon set are faked.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Board, StoredMessage, TicketWithId } from '@tm/shared';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/agents/TicketAgentHealth.svelte', async () => ({
  default: (await import('../ticket/IconStub.test.svelte')).default,
}));
vi.mock('$lib/people', async () => ({
  PrincipalAvatar: (await import('../ticket/IconStub.test.svelte')).default,
}));
vi.mock('$lib/ui/PersonChip.svelte', async () => ({
  default: (await import('../ticket/IconStub.test.svelte')).default,
}));
vi.mock('lucide-svelte', async () => {
  const Stub = (await import('../ticket/IconStub.test.svelte')).default;
  const names = [
    'Ban',
    'Check',
    'ChevronDown',
    'Copy',
    'ListChecks',
    'Loader2',
    'MessageSquare',
    'Paperclip',
    'TriangleAlert',
    'UserPlus',
  ];
  return Object.fromEntries(names.map((n) => [n, Stub]));
});

const { default: TicketSummary } = await import('./TicketSummary.svelte');
const { default: Harness } = await import('./TicketSummaryHarness.test.svelte');

const NOW = Date.UTC(2026, 8, 24, 12, 0);
const board = {
  id: 'b1',
  stages: [{ id: 's1', name: 'To do', color: '#888', category: 'todo', position: 0 }],
  priorities: [{ id: 'p1', name: 'High', color: '#f00', position: 0 }],
  tags: [{ id: 'g1', name: 'bug', color: '#0f0', position: 0 }],
  fields: [],
} as unknown as Pick<Board, 'stages' | 'priorities' | 'tags' | 'fields'> & { id: string };

const ticket = (over: Partial<TicketWithId> = {}): TicketWithId =>
  ({
    id: 't1',
    boardId: 'b1',
    key: 'ENG-1',
    title: 'Fix the login redirect',
    state: 'active',
    stageId: 's1',
    stageCategory: 'todo',
    priorityId: null,
    tagIds: [],
    dueAt: null,
    dueAllDay: true,
    startAt: null,
    estimate: null,
    assigneeUids: [],
    watcherUids: [],
    counts: { messages: 0, files: 0, pinned: 0 },
    lastMessageAt: null,
    fields: {},
    links: [],
    recentMessages: [],
    ...over,
  }) as unknown as TicketWithId;

const base = {
  board,
  me: 'me',
  tz: 'UTC',
  now: NOW,
  fields: null,
};

// `base` is everything but the ticket, so the per-test props complete it —
// hence the cast: only the two together make a full set of card props.
const draw = (props: Record<string, unknown>) =>
  render(TicketSummary, { props: { ...base, ...props } as ComponentProps<typeof TicketSummary> });

/** A message in the ticket's inline thread — what §W counts unread from. */
const msg = (id: string, authorUid: string, createdAt = NOW): StoredMessage =>
  ({ id, authorUid, createdAt, kind: 'comment', deletedAt: null }) as unknown as StoredMessage;

afterEach(cleanup);

describe('a card with nothing to say', () => {
  it('draws the key and the title, and no meta row at all', () => {
    const { container } = draw({ ticket: ticket() });
    expect(screen.getByText('Fix the login redirect')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy ENG-1' })).toBeTruthy();
    expect(container.querySelector('[data-facts]')).toBeNull();
    // No 💬 on a ticket nobody has written on.
    expect(container.querySelector('[data-unread]')).toBeNull();
  });

  it('holds the title to two lines', () => {
    const { container } = draw({ ticket: ticket({ title: 'A very long title '.repeat(20) }) });
    expect(container.querySelector('.line-clamp-2')).not.toBeNull();
  });
});

describe('the badges on the top row', () => {
  it('shows the unread count in accent, from my read pointer', () => {
    const { container } = draw({
      ticket: ticket({
        counts: { messages: 7, files: 0, pinned: 0 },
        lastMessageAt: NOW,
        recentMessages: [
          msg('m0', 'me', NOW - 3),
          msg('m1', 'someone', NOW - 2),
          msg('m2', 'someone', NOW - 1),
        ],
        signals: { unreadFrom: NOW - 3, messageCount: 3 } as never,
      }),
      unread: true,
      since: NOW - 3,
    });
    const badge = container.querySelector('[data-unread]')!;
    expect(badge.getAttribute('data-unread')).toBe('2');
    expect(badge.className).toContain('text-accent');
  });

  it('never counts my own messages as unread', () => {
    const { container } = draw({
      ticket: ticket({
        counts: { messages: 4, files: 0, pinned: 0 },
        lastMessageAt: NOW,
        recentMessages: [msg('m1', 'me', NOW - 1)],
        signals: { unreadFrom: NOW - 1 } as never,
      }),
      unread: true,
      since: NOW - 3,
    });
    // Nothing new FOR ME: the muted total, not an accent count.
    expect(container.querySelector('[data-unread]')).toBeNull();
    expect(screen.getByLabelText('4 messages')).toBeTruthy();
  });

  it('is a muted total once everything is read', () => {
    const { container } = draw({
      ticket: ticket({ counts: { messages: 4, files: 0, pinned: 0 }, lastMessageAt: NOW }),
      unread: false,
      since: null,
    });
    expect(container.querySelector('[data-unread]')).toBeNull();
    expect(screen.getByLabelText('4 messages').className).toContain('text-subtle');
  });

  it('puts ⚠ up for a message of mine that has not gone out', () => {
    draw({ ticket: ticket(), unsent: true });
    expect(screen.getByLabelText('Unsent message')).toBeTruthy();
  });

  it('puts ❓ up only while a blocking question waits, and says whose it is', () => {
    const { container, unmount } = draw({
      ticket: ticket(),
      waiting: { waiting: 1, open: 1, title: 'Which env?' },
    });
    expect(container.querySelector('[data-waiting]')!.textContent).toContain('Waiting for you');
    unmount();
    const other = draw({ ticket: ticket(), waiting: { waiting: 0, open: 2, title: 'Which env?' } });
    expect(other.container.querySelector('[data-waiting]')!.textContent).toContain(
      'Waiting for an answer',
    );
  });

  it('draws no ❓ when nothing is open', () => {
    const { container } = draw({ ticket: ticket(), waiting: null });
    expect(container.querySelector('[data-waiting]')).toBeNull();
  });
});

describe('the meta row', () => {
  it('draws the facts the ticket has and nothing else', () => {
    const { container } = draw({
      ticket: ticket({
        priorityId: 'p1',
        tagIds: ['g1'],
        counts: { messages: 0, files: 2, pinned: 0 },
        links: [{ type: 'blockedBy', ticketId: 't9' }],
      }),
      blocked: true,
      tasks: { chip: '4/7', failed: 0, doing: null, settled: 4, total: 7 },
    });
    const kinds = [...container.querySelectorAll('[data-fact]')].map((e) =>
      e.getAttribute('data-fact'),
    );
    expect(kinds).toEqual(['priority', 'tag', 'tasks', 'files', 'blocked']);
    expect(container.querySelector('[data-tasks]')!.getAttribute('data-tasks')).toBe('4/7');
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByText('bug')).toBeTruthy();
  });
});

describe('assignees, editable in place (§P2)', () => {
  /** The row in the open picker — its button is what a click lands on. */
  const pick = (name: string) => screen.getByRole('option', { name }).querySelector('button')!;
  const choices = [
    { id: 'u2', label: 'Grace Hopper', uid: 'u2' },
    { id: 'ag_1', label: 'Builder', uid: 'ag_1', agent: true },
  ];

  it('offers the picker, and saves what I choose', async () => {
    const onchange = vi.fn();
    draw({ ticket: ticket(), assignees: { editable: true, choices, onchange } });
    const trigger = screen.getByRole('button', { name: 'Assignees on ENG-1' });
    await fireEvent.click(trigger);
    // People AND agents are on the list (agents.html §D).
    await fireEvent.click(pick('Builder'));
    expect(onchange).toHaveBeenCalledWith(['ag_1']);
  });

  it('removes someone already on it', async () => {
    const onchange = vi.fn();
    draw({
      ticket: ticket({ assigneeUids: ['u2'] }),
      assignees: { editable: true, choices, onchange },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Assignees on ENG-1' }));
    await fireEvent.click(pick('Grace Hopper'));
    expect(onchange).toHaveBeenCalledWith([]);
  });

  it('gives a viewer no picker and no + — just the avatars', () => {
    const { container } = draw({
      ticket: ticket({ assigneeUids: ['u2'] }),
      assignees: { editable: false, choices, onchange: vi.fn() },
    });
    expect(screen.queryByRole('button', { name: 'Assignees on ENG-1' })).toBeNull();
    expect(container.querySelector('[data-assignees]')).toBeNull();
  });

  it('draws nothing at all for a viewer when nobody is on it', () => {
    const { container } = draw({
      ticket: ticket(),
      assignees: { editable: false, choices, onchange: vi.fn() },
    });
    expect(container.textContent).not.toContain('Unassigned');
    expect(screen.queryByRole('button', { name: 'Assignees on ENG-1' })).toBeNull();
  });

  it('does not open the ticket when the picker is clicked', async () => {
    const oncard = vi.fn();
    render(Harness, {
      props: {
        ...base,
        ticket: ticket(),
        assignees: { editable: true, choices, onchange: vi.fn() },
        oncard,
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Assignees on ENG-1' }));
    expect(oncard).not.toHaveBeenCalled();
    // ...while the card itself still opens.
    await fireEvent.click(screen.getByText('Fix the login redirect'));
    expect(oncard).toHaveBeenCalledTimes(1);
  });
});
