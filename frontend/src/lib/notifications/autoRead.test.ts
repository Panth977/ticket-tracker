import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem } from '@tm/shared';
import type { WithId } from '$lib/stores';

const markRead = vi.fn(async () => true);
vi.mock('./actions', () => ({ markRead: (...a: unknown[]) => markRead(...(a as [])) }));

const { forgetSentNotifications, readTicketNotifications, ticketInboxIds } =
  await import('./autoRead');

const row = (id: string, ticketId: string | null, readAt: number | null = null) =>
  ({ id, ticketId, readAt, event: 'commented', boardId: 'b1' }) as unknown as WithId<InboxItem>;

describe('reading a ticket reads its notifications', () => {
  beforeEach(() => {
    markRead.mockClear();
    forgetSentNotifications();
  });

  it('picks the unread rows that point at this ticket, and nothing else', () => {
    const items = [row('a', 't1'), row('b', 't2'), row('c', 't1', 5), row('d', null)];
    expect(ticketInboxIds(items, 't1')).toEqual(['a']);
    expect(ticketInboxIds(items, 't2')).toEqual(['b']);
    expect(ticketInboxIds(items, null)).toEqual([]);
    expect(ticketInboxIds(undefined, 't1')).toEqual([]);
  });

  it('marks them read once, however often the ticket re-renders', async () => {
    const items = [row('a', 't1'), row('b', 't1')];
    expect(await readTicketNotifications('u1', 't1', items)).toEqual(['a', 'b']);
    expect(markRead).toHaveBeenCalledWith('u1', ['a', 'b']);
    // The snapshot has not come back yet — the same rows must not be written again.
    expect(await readTicketNotifications('u1', 't1', items)).toEqual([]);
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('clears a row that arrives while the ticket is open', async () => {
    await readTicketNotifications('u1', 't1', [row('a', 't1')]);
    expect(await readTicketNotifications('u1', 't1', [row('a', 't1'), row('late', 't1')])).toEqual([
      'late',
    ]);
  });

  it('lets a failed write be retried', async () => {
    markRead.mockResolvedValueOnce(false);
    expect(await readTicketNotifications('u1', 't1', [row('a', 't1')])).toEqual(['a']);
    expect(await readTicketNotifications('u1', 't1', [row('a', 't1')])).toEqual(['a']);
    expect(markRead).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a signed-in uid', async () => {
    expect(await readTicketNotifications(null, 't1', [row('a', 't1')])).toEqual([]);
    expect(markRead).not.toHaveBeenCalled();
  });
});
