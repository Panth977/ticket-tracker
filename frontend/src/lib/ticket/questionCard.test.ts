// @vitest-environment jsdom
/**
 * The question card as a person meets it (§N1 / §N3): the builder's live
 * preview draws the real card and does nothing, and a person's own question
 * can be taken back by them or by a board admin — exactly like an agent's.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Question } from '@tm/shared';

const queue = vi.fn();
vi.mock('$lib/api', () => ({ outbox: { queue: (...a: unknown[]) => queue(...a) } }));
vi.mock('$lib/editor', async () => ({
  RichView: (await import('./IconStub.test.svelte')).default,
}));
vi.mock('$lib/layout/routes', () => ({ routes: { ticket: (k: string) => `/t/${k}` } }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
// lucide-svelte ships Svelte 4 components; this project compiles in runes mode.
vi.mock('lucide-svelte', async () => {
  const Stub = (await import('./IconStub.test.svelte')).default;
  const names = ['Ban', 'CircleCheckBig', 'CircleHelp', 'ChevronDown', 'Clock', 'Loader2', 'X'];
  return Object.fromEntries(names.map((n) => [n, Stub]));
});

const { default: Harness } = await import('./QuestionCardHarness.test.svelte');

const question = (over: Partial<Question> = {}): Question => ({
  title: 'Which database?',
  body: null,
  fields: [
    {
      id: 'db',
      label: 'Database',
      type: 'single',
      options: [
        { id: 'pg', label: 'Postgres' },
        { id: 'sq', label: 'SQLite' },
      ],
      required: true,
    },
  ],
  allowComment: false,
  to: null,
  blocking: true,
  status: 'open',
  expiresAt: null,
  answer: null,
  cancelledAt: null,
  ...over,
});

afterEach(() => {
  cleanup();
  queue.mockReset();
});

describe('the builder’s live preview (§N1)', () => {
  it('draws the card the thread will render — title, options, Submit', () => {
    render(Harness, { props: { question: question(), preview: true } });
    expect(screen.getByText('Which database?')).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByText('Postgres')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy();
  });

  it('is scenery: submitting it writes nothing', async () => {
    render(Harness, { props: { question: question(), preview: true } });
    await fireEvent.click(screen.getAllByRole('radio')[0]!);
    await fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(queue).not.toHaveBeenCalled();
  });

  it('shows an expiry and whom it waits for, as the real card does', () => {
    render(Harness, { props: { question: question({ to: ['u2'] }), preview: true } });
    expect(screen.getByText(/Waiting for Priya/)).toBeTruthy();
  });
});

describe('a person’s question behaves like an agent’s (§N1)', () => {
  it('the asker can take it back', async () => {
    render(Harness, { props: { question: question(), me: 'u1', askedBy: 'u1' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel question' }));
    expect(queue).toHaveBeenCalledWith(
      'questionCancel',
      expect.objectContaining({ boardId: 'b1', ticketId: 't1', messageId: 'm1' }),
      expect.anything(),
    );
  });

  it('someone else who may only answer cannot', () => {
    render(Harness, { props: { question: question(), me: 'u2', askedBy: 'u1' } });
    expect(screen.queryByRole('button', { name: 'Cancel question' })).toBeNull();
  });

  it('a board admin can, even though they did not ask', () => {
    render(Harness, { props: { question: question(), me: 'ad', askedBy: 'u1', role: 'admin' } });
    expect(screen.getByRole('button', { name: 'Cancel question' })).toBeTruthy();
  });

  it('answering goes through the outbox with the chosen values', async () => {
    render(Harness, { props: { question: question(), me: 'u2', askedBy: 'u1' } });
    await fireEvent.click(screen.getAllByRole('radio')[1]!);
    await fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(queue).toHaveBeenCalledWith(
      'questionAnswer',
      expect.objectContaining({ values: { db: 'sq' } }),
      expect.anything(),
    );
  });

  it('a cancelled question a person asked does not blame an agent', () => {
    render(Harness, { props: { question: question({ status: 'cancelled' }), askedBy: 'u1' } });
    expect(screen.getByText('This question was taken back.')).toBeTruthy();
  });

  it('a cancelled question an agent asked still says so', () => {
    render(Harness, {
      props: { question: question({ status: 'cancelled' }), askedBy: 'ag_0000000000000001' },
    });
    expect(screen.getByText('The agent took this question back.')).toBeTruthy();
  });
});
