/**
 * notify() end to end against the Firestore emulator: who gets an inbox row,
 * how rows collapse, and which deliver tasks are enqueued.
 */
import { describe, expect, it } from 'vitest';
import { paths, type InboxItem } from '@tm/shared';
import { notify, route } from '../../src/notify/index.js';
import { typedDoc } from '../../src/runtime/index.js';
import { setupEmulators } from '../harness/index.js';
import { ctxOf, seedBoard, seedPref, seedTicket, seedUser, T, useFakes } from './_seed.js';
import { putMessage } from '../tickets/store.js';

setupEmulators();

const inbox = async (uid: string, id: string) =>
  (await typedDoc('inbox', paths.inboxItem(uid, id)).get()).data() as InboxItem | undefined;

describe('notify() recipients and prefs', () => {
  it('board-wide event: mode all hears everything, mine only own tickets, muted nothing; actor never', async () => {
    const f = useFakes();
    const [actor, all, mine, mineAssignee, muted] = await Promise.all([
      seedUser(),
      seedUser(),
      seedUser(),
      seedUser(),
      seedUser(),
    ]);
    const board = await seedBoard([actor.uid, all.uid, mine.uid, mineAssignee.uid, muted.uid]);
    await Promise.all([
      seedPref(board.id, all.uid, { mode: 'all' }),
      seedPref(board.id, mine.uid, { mode: 'mine' }),
      seedPref(board.id, muted.uid, { mode: 'muted' }),
      seedPref(board.id, actor.uid, { mode: 'all' }),
      // mineAssignee has no prefs doc → the default ('mine')
    ]);
    const t = await seedTicket(board.id, {
      assigneeUids: [mineAssignee.uid, muted.uid],
      watcherUids: [actor.uid],
    });

    const r = await route('created', t, ctxOf(actor.uid));
    expect(Object.keys(r.inbox).sort()).toEqual([all.uid, mineAssignee.uid].sort());
    const row = await inbox(all.uid, `${t.id}:created`);
    expect(row).toMatchObject({
      event: 'created',
      boardId: board.id,
      ticketId: t.id,
      ticketKey: t.key,
      actor: actor.uid,
      via: 'app',
      count: 1,
      readAt: null,
      summary: `created “${t.title}”`,
    });
    // 'created' is in-app only by default → nothing enqueued.
    expect(f.queue.pending()).toHaveLength(0);
  });

  it('events and stageIds filter; watching overrides mode, events and stages', async () => {
    useFakes();
    const [actor, evOnly, stageOnly, watcher] = await Promise.all([
      seedUser(),
      seedUser(),
      seedUser(),
      seedUser(),
    ]);
    const board = await seedBoard([actor.uid, evOnly.uid, stageOnly.uid, watcher.uid]);
    const t = await seedTicket(board.id, { stageId: 'st_rev' });
    await Promise.all([
      seedPref(board.id, evOnly.uid, { mode: 'all', events: ['comment'] }),
      seedPref(board.id, stageOnly.uid, { mode: 'all', stageIds: ['st_done'] }),
      seedPref(board.id, watcher.uid, { mode: 'muted', events: ['comment'], watching: [t.id] }),
    ]);
    const r = await route('stage', t, ctxOf(actor.uid), {
      changes: { stageId: { from: 'st_todo', to: 'st_rev' } },
    });
    expect(Object.keys(r.inbox)).toEqual([watcher.uid]);
    expect((await inbox(watcher.uid, `${t.id}:stage`))!.summary).toBe('moved to In review');

    const r2 = await route('stage', { ...t, stageId: 'st_done' }, ctxOf(actor.uid), {
      changes: { stageId: { from: 'st_rev', to: 'st_done' } },
    });
    expect(Object.keys(r2.inbox).sort()).toEqual([stageOnly.uid, watcher.uid].sort());
  });

  it('mentioned is unconditional (even muted), limited to board readers, and excludes the actor', async () => {
    const f = useFakes();
    const [actor, muted, outsider] = await Promise.all([seedUser(), seedUser(), seedUser()]);
    const board = await seedBoard([actor.uid, muted.uid]);
    await seedPref(board.id, muted.uid, { mode: 'muted', events: [] });
    const t = await seedTicket(board.id);
    const r = await route('mentioned', t, ctxOf(actor.uid), {
      mentioned: [muted.uid, outsider.uid, actor.uid],
    });
    expect(Object.keys(r.inbox)).toEqual([muted.uid]);
    // mentioned → push + email by default
    expect(r.enqueued[muted.uid]).toEqual(['push', 'email']);
    const [task] = f.queue.pending();
    expect(task).toMatchObject({
      queue: 'deliver',
      payload: {
        uid: muted.uid,
        groupKey: `${t.id}:mentioned`,
        inboxIds: [`${t.id}:mentioned`],
        channels: ['push', 'email'],
      },
      opts: { name: `${muted.uid}:${t.id}:mentioned:${Math.floor(T / 60000)}` },
    });
    expect(task!.opts.delaySeconds).toBeGreaterThan(0);
  });

  it('explicit recipients and exclude; a deleted user or a missing profile gets nothing', async () => {
    useFakes();
    const [actor, a, b, gone] = await Promise.all([
      seedUser(),
      seedUser(),
      seedUser(),
      seedUser({ deletedAt: T - 1 }),
    ]);
    const board = await seedBoard([actor.uid, a.uid, b.uid, gone.uid, 'ghost']);
    const t = await seedTicket(board.id, { assigneeUids: [a.uid, b.uid, gone.uid, 'ghost'] });
    const r = await route('assigned', t, ctxOf(actor.uid), {
      recipients: [a.uid, b.uid, gone.uid, 'ghost'],
      exclude: [b.uid],
    });
    expect(Object.keys(r.inbox)).toEqual([a.uid]);
    expect((await inbox(a.uid, `${t.id}:assigned`))!.summary).toBe('assigned you');
  });

  it('collapses a burst into one row and one task per minute; a read row starts over', async () => {
    const f = useFakes();
    const [actor, u] = await Promise.all([seedUser(), seedUser()]);
    const board = await seedBoard([actor.uid, u.uid]);
    await seedPref(board.id, u.uid, { mode: 'all' });
    const t = await seedTicket(board.id);
    // make comments go to email for u
    const ch = { ...u.notify.channels, comment: ['inApp' as const, 'email' as const] };
    await typedDoc('users', paths.user(u.uid)).update({ 'notify.channels': ch });

    for (let i = 0; i < 5; i++) await route('comment', t, ctxOf(actor.uid, T + i * 1000));
    const row = await inbox(u.uid, `${t.id}:comment`);
    expect(row!.count).toBe(5);
    expect(f.queue.pending()).toHaveLength(1);

    // Next minute → a second task for the same row.
    await route('comment', t, ctxOf(actor.uid, T + 61_000));
    expect(f.queue.pending()).toHaveLength(2);
    expect((await inbox(u.uid, `${t.id}:comment`))!.count).toBe(6);

    // Read in the app → the next event is a fresh row.
    await typedDoc('inbox', paths.inboxItem(u.uid, `${t.id}:comment`)).update({
      readAt: T + 62_000,
    });
    await route('comment', t, ctxOf(actor.uid, T + 63_000));
    expect(await inbox(u.uid, `${t.id}:comment`)).toMatchObject({ count: 1, readAt: null });
  });

  it('comment summary quotes the message; invited reaches a non-member via extra.boardId', async () => {
    useFakes();
    const [actor, u, invitee] = await Promise.all([seedUser(), seedUser(), seedUser()]);
    const board = await seedBoard([actor.uid, u.uid], { name: 'Design' });
    await seedPref(board.id, u.uid, { mode: 'all' });
    const t = await seedTicket(board.id);
    // §W: the message is a row on the ticket document.
    await putMessage(board.id, t.id, 'm1', {
      kind: 'comment',
      body: {
        doc: { type: 'doc', content: [] },
        text: 'Looks   good to me',
        mentions: [],
        refs: [],
      },
      authorUid: actor.uid,
      authorName: 'A',
      via: 'app',
      replyTo: null,
      attachments: [],
      reactions: {},
      pinnedAt: null,
      pinnedBy: null,
      editedAt: null,
      deletedAt: null,
      createdAt: T,
    });
    await route('comment', t, ctxOf(actor.uid), { messageId: 'm1' });
    expect(await inbox(u.uid, `${t.id}:comment`)).toMatchObject({
      summary: 'commented: “Looks good to me”',
      messageId: 'm1',
    });

    const r = await route('invited', null, ctxOf(actor.uid), {
      boardId: board.id,
      inviteId: 'inv1',
      recipients: [invitee.uid],
    });
    expect(Object.keys(r.inbox)).toEqual([invitee.uid]);
    expect(await inbox(invitee.uid, 'invite:inv1')).toMatchObject({
      event: 'invited',
      ticketId: null,
      inviteId: 'inv1',
      summary: 'invited you to Design',
    });
  });

  it('never throws into the command', async () => {
    useFakes();
    await expect(notify('comment', null, ctxOf('x'), {})).resolves.toBeUndefined();
  });
});
