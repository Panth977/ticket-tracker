/**
 * The unread number stays honest (notify/inboxClean.ts): rows about deleted or
 * archived tickets, rows read since, and moves stop counting; the conversation
 * a person has not read still does.
 */
import { describe, expect, it } from 'vitest';
import { paths, type InboxItem } from '@tm/shared';
import { fixtures } from '@tm/shared/schema/fixtures';
import { clearTicketInbox, reconcileInbox, staleReason } from '../../src/notify/inboxClean.js';
import { typedDoc } from '../../src/runtime/index.js';
import { setupEmulators } from '../harness/index.js';
import { seedBoard, seedTicket, seedUser, T, useFakes } from './_seed.js';

setupEmulators();

const row = (over: Partial<InboxItem>): InboxItem => ({
  ...fixtures.inbox,
  createdAt: T - 1000,
  readAt: null,
  ...over,
});
const readAtOf = async (uid: string, id: string) =>
  (await typedDoc('inbox', paths.inboxItem(uid, id)).get()).data()?.readAt;

describe('the unread number stays honest', () => {
  it('staleReason: silent events, gone or archived tickets, read since', () => {
    const r = row({});
    expect(staleReason({ ...r, event: 'stage' }, {}, { state: 'active' }, null)).toBe('silent');
    expect(staleReason(r, null, null, null)).toBe('board gone');
    expect(staleReason(r, { archivedAt: 1 }, null, null)).toBe('board archived');
    expect(staleReason(r, { archivedAt: null }, null, null)).toBe('ticket gone');
    expect(staleReason(r, { archivedAt: null }, { state: 'archived' }, null)).toBe(
      'ticket archived',
    );
    expect(staleReason(r, { archivedAt: null }, { state: 'active' }, T)).toBe('read since');
    expect(staleReason(r, { archivedAt: null }, { state: 'active' }, T - 5000)).toBeNull();
  });

  it('reconcileInbox marks the stale rows read and keeps the live one', async () => {
    useFakes();
    const u = await seedUser();
    const board = await seedBoard([u.uid]);
    const live = await seedTicket(board.id);
    const archived = await seedTicket(board.id, { state: 'archived' });
    const readSince = await seedTicket(board.id);
    await typedDoc('reads', paths.read(u.uid, readSince.id)).set({
      boardId: board.id,
      readAt: T,
    });
    const put = (id: string, r: Partial<InboxItem>) =>
      typedDoc('inbox', paths.inboxItem(u.uid, id)).set(row({ boardId: board.id, ...r }));
    await Promise.all([
      put('live', { ticketId: live.id }),
      put('moved', { ticketId: live.id, event: 'stage' }),
      put('archived', { ticketId: archived.id }),
      put('gone', { ticketId: 'no-such-ticket' }),
      put('read', { ticketId: readSince.id }),
    ]);
    expect(await reconcileInbox(T)).toBeGreaterThanOrEqual(4);
    expect(await readAtOf(u.uid, 'live')).toBeNull();
    for (const id of ['moved', 'archived', 'gone', 'read'])
      expect(await readAtOf(u.uid, id)).toBe(T);
  });

  it('clearTicketInbox: everyone on the board, only that ticket', async () => {
    useFakes();
    const [a, b] = await Promise.all([seedUser(), seedUser()]);
    const board = await seedBoard([a.uid, b.uid]);
    const t1 = await seedTicket(board.id);
    const t2 = await seedTicket(board.id);
    await Promise.all([
      typedDoc('inbox', paths.inboxItem(a.uid, 'x')).set(
        row({ boardId: board.id, ticketId: t1.id }),
      ),
      typedDoc('inbox', paths.inboxItem(b.uid, 'y')).set(
        row({ boardId: board.id, ticketId: t1.id }),
      ),
      typedDoc('inbox', paths.inboxItem(b.uid, 'z')).set(
        row({ boardId: board.id, ticketId: t2.id }),
      ),
    ]);
    expect(await clearTicketInbox(board.id, t1.id, T)).toBe(2);
    expect(await readAtOf(a.uid, 'x')).toBe(T);
    expect(await readAtOf(b.uid, 'y')).toBe(T);
    expect(await readAtOf(b.uid, 'z')).toBeNull();
  });
});
