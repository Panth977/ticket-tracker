/**
 * deadlineSweep, digestSend and housekeeping against the emulators.
 * Global scans see every test's data: assertions look only at this file's
 * unique uids / ids, and seeded "old" rows sit far in the past.
 */
import { describe, expect, it } from 'vitest';
import { defaultChannelMatrix, paths, type Delivery, type InboxItem } from '@tm/shared';
import { fixtures } from '@tm/shared/schema/fixtures';
import { digestDue, digestSend } from '../../src/notify/digest.js';
import { housekeeping, pruneUploads } from '../../src/notify/housekeeping.js';
import { deadlineSweep } from '../../src/notify/sweep.js';
import { db, storageAdmin } from '../../src/runtime/firebase.js';
import { typedDoc } from '../../src/runtime/index.js';
import { setupEmulators, uniq } from '../harness/index.js';
import { seedBoard, seedTicket, seedUser, T, useFakes } from './_seed.js';
import { actsOf, putFile } from '../tickets/store.js';

setupEmulators();

const H = 3_600_000;
const D = 24 * H;
const ticketDoc = async (boardId: string, id: string) =>
  (await typedDoc('tickets', paths.ticket(boardId, id)).get()).data()!;

describe('deadlineSweep', () => {
  it('per-person lead time, dueNotified makes a re-run harmless, overdue after due', async () => {
    useFakes();
    const short = await seedUser({
      notify: {
        channels: defaultChannelMatrix(),
        quietHours: null,
        digest: 'off',
        dueSoonLeadMinutes: 60,
        commitmentReminders: true,
      },
    });
    const long = await seedUser(); // 1440 minutes
    const board = await seedBoard([short.uid, long.uid]);
    const t = await seedTicket(board.id, { dueAt: T + 3 * H, assigneeUids: [short.uid, long.uid] });

    const r1 = await deadlineSweep(T);
    expect(r1.dueSoon).toContain(`${t.key}:${long.uid}`);
    expect(r1.dueSoon).not.toContain(`${t.key}:${short.uid}`);
    expect((await ticketDoc(board.id, t.id)).dueNotified).toEqual({ [long.uid]: { soon: T } });
    const row = (
      await typedDoc('inbox', paths.inboxItem(long.uid, `${t.id}:dueSoon`)).get()
    ).data() as InboxItem;
    expect(row).toMatchObject({
      event: 'dueSoon',
      actor: null,
      via: 'system',
      summary: 'is due soon',
    });

    // Re-run at the same time: nothing new.
    const r2 = await deadlineSweep(T);
    expect(r2.dueSoon.filter((k) => k.startsWith(`${t.key}:`))).toEqual([]);

    // 2h30 later the short-lead person is inside their hour.
    const r3 = await deadlineSweep(T + 2.5 * H);
    expect(r3.dueSoon).toContain(`${t.key}:${short.uid}`);

    // After the due date: overdue once each, and the board count follows.
    const r4 = await deadlineSweep(T + 4 * H);
    expect(r4.overdue).toEqual(
      expect.arrayContaining([`${t.key}:${short.uid}`, `${t.key}:${long.uid}`]),
    );
    expect(r4.boardCounts[board.id]).toBe(1);
    expect((await typedDoc('boards', paths.board(board.id)).get()).data()!.counts.overdue).toBe(1);
    const r5 = await deadlineSweep(T + 5 * H);
    expect(r5.overdue.filter((k) => k.startsWith(`${t.key}:`))).toEqual([]);
  });

  it('done tickets are skipped; a board count drops once its overdue ticket is done', async () => {
    useFakes();
    const u = await seedUser();
    const board = await seedBoard([u.uid], { counts: { active: 0, done: 1, overdue: 1 } });
    const t = await seedTicket(board.id, {
      dueAt: T - H,
      assigneeUids: [u.uid],
      stageId: 'st_done',
      stageCategory: 'done',
    });
    const r = await deadlineSweep(T);
    expect(r.overdue.filter((k) => k.endsWith(u.uid))).toEqual([]);
    expect(r.boardCounts[board.id]).toBe(0);
    expect((await ticketDoc(board.id, t.id)).dueNotified).toEqual({});
  });

  it("all-day due dates are overdue only after the day ends in the person's zone", async () => {
    useFakes();
    const u = await seedUser({ timezone: 'America/Los_Angeles' });
    const board = await seedBoard([u.uid]);
    // Due "2026-09-22" all day: the start of that day in LA (PDT, UTC-7).
    const t = await seedTicket(board.id, {
      dueAt: Date.UTC(2026, 8, 22, 7),
      dueAllDay: true,
      assigneeUids: [u.uid],
    });
    const r = await deadlineSweep(Date.UTC(2026, 8, 23, 3)); // 20:00 on the 22nd in LA
    expect(r.overdue).not.toContain(`${t.key}:${u.uid}`);
    const r2 = await deadlineSweep(Date.UTC(2026, 8, 23, 8)); // 01:00 on the 23rd in LA
    expect(r2.overdue).toContain(`${t.key}:${u.uid}`);
  });

  it('commitments nudge that person once, when the run crosses them, if they opted in', async () => {
    useFakes();
    const yes = await seedUser();
    const no = await seedUser({
      notify: {
        channels: defaultChannelMatrix(),
        quietHours: null,
        digest: 'off',
        dueSoonLeadMinutes: 0,
        commitmentReminders: false,
      },
    });
    const board = await seedBoard([yes.uid, no.uid]);
    const t = await seedTicket(board.id, {
      dueAt: T + 48 * H,
      assigneeUids: [yes.uid, no.uid],
      commitments: { [yes.uid]: T - 5 * 60_000, [no.uid]: T - 5 * 60_000 },
    });
    const r = await deadlineSweep(T);
    expect(r.nudges).toContain(`${t.key}:${yes.uid}`);
    expect(r.nudges).not.toContain(`${t.key}:${no.uid}`);
    const r2 = await deadlineSweep(T + 20 * 60_000);
    expect(r2.nudges).not.toContain(`${t.key}:${yes.uid}`);
  });

  it('a commitment on a ticket with NO due date is nudged too (nextCommitmentAt), once, then moves on', async () => {
    useFakes();
    const u = await seedUser();
    const board = await seedBoard([u.uid]);
    const t = await seedTicket(board.id, {
      dueAt: null,
      assigneeUids: [u.uid],
      commitments: { [u.uid]: T - 60_000 },
      nextCommitmentAt: T - 60_000,
    });
    const r = await deadlineSweep(T);
    expect(r.nudges).toContain(`${t.key}:${u.uid}`);
    const r2 = await deadlineSweep(T + 20 * 60_000);
    expect(r2.nudges).not.toContain(`${t.key}:${u.uid}`);
  });
});

describe('digestSend', () => {
  it('daily at 09:00 local, hourly every run; unread + due today + overdue; nothing → nothing', async () => {
    const f = useFakes();
    const notify = (digest: 'daily' | 'hourly' | 'off') => ({
      channels: defaultChannelMatrix(),
      quietHours: null,
      digest,
      dueSoonLeadMinutes: 60,
      commitmentReminders: false,
    });
    // 12:00 UTC = 09:00 in America/Sao_Paulo (UTC-3)
    expect(digestDue({ timezone: 'America/Sao_Paulo', notify: notify('daily') }, T)).toBe('daily');
    expect(digestDue({ timezone: 'UTC', notify: notify('daily') }, T)).toBeNull();
    expect(digestDue({ timezone: 'UTC', notify: notify('off') }, T)).toBeNull();

    const daily = await seedUser({
      timezone: 'America/Sao_Paulo',
      notify: notify('daily'),
      name: 'Dora',
    });
    const hourlyEmpty = await seedUser({ notify: notify('hourly') });
    const board = await seedBoard([daily.uid, hourlyEmpty.uid], { name: 'Ops' });
    const over = await seedTicket(board.id, {
      dueAt: T - 2 * D,
      assigneeUids: [daily.uid],
      title: 'Late one',
    });
    const today = await seedTicket(board.id, {
      dueAt: T + 6 * H,
      assigneeUids: [daily.uid],
      title: 'Today one',
    });
    await typedDoc('inbox', paths.inboxItem(daily.uid, 'x:comment')).set({
      ...fixtures.inbox,
      boardId: board.id,
      ticketKey: 'OPS-9',
      summary: 'commented: hi',
      groupKey: 'x:comment',
      createdAt: T - 2 * H,
      count: 3,
    });
    await typedDoc('inbox', paths.inboxItem(daily.uid, 'y:comment')).set({
      ...fixtures.inbox,
      boardId: board.id,
      summary: 'already read',
      groupKey: 'y:comment',
      createdAt: T - 2 * H,
      readAt: T - H,
    });

    const r = await digestSend(T);
    expect(r.sent).toContain(daily.uid);
    expect(r.empty).toContain(hourlyEmpty.uid);
    const mails = f.mail.filter((m) => m.to === daily.email);
    expect(mails).toHaveLength(1);
    const m = mails[0]!;
    expect(m.tag).toBe('digest');
    expect(m.subject).toBe('Your daily digest: 1 unread, 1 due today, 1 overdue');
    expect(m.text).toContain(over.key);
    expect(m.text).toContain(today.key);
    expect(m.text).toContain('OPS-9 · commented: hi (3)');
    expect(m.text).not.toContain('already read');
    expect(m.html).toContain('Ops');

    // A retried run in the same hour does not mail again.
    await digestSend(T + 60_000);
    expect(f.mail.filter((x) => x.to === daily.email)).toHaveLength(1);
    const log = (
      await typedDoc('deliveries', paths.delivery(`digest_${daily.uid}_${Math.floor(T / H)}`)).get()
    ).data() as Delivery;
    expect(log).toMatchObject({ status: 'sent', channel: 'email', groupKey: 'digest:daily' });
  });
});

describe('housekeeping', () => {
  it('expires invites, prunes old read inbox rows and old deliveries, auto-archives done tickets', async () => {
    useFakes();
    const u = await seedUser();
    const inviteOld = uniq('inv');
    const inviteLive = uniq('inv');
    await typedDoc('invites', paths.invite(inviteOld)).set({
      ...fixtures.invites,
      expiresAt: T - 1,
    });
    await typedDoc('invites', paths.invite(inviteLive)).set({
      ...fixtures.invites,
      expiresAt: T + D,
    });

    const oldRead = { ...fixtures.inbox, createdAt: T - 100 * D, readAt: T - 99 * D };
    await typedDoc('inbox', paths.inboxItem(u.uid, 'old-read')).set(oldRead);
    await typedDoc('inbox', paths.inboxItem(u.uid, 'old-unread')).set({ ...oldRead, readAt: null });
    await typedDoc('inbox', paths.inboxItem(u.uid, 'new-read')).set({
      ...oldRead,
      createdAt: T - D,
    });

    const dOld = uniq('dl');
    const dNew = uniq('dl');
    const delivery: Delivery = {
      uid: u.uid,
      channel: 'email',
      groupKey: 'g',
      inboxIds: [],
      status: 'sent',
      provider: 'resend',
      providerId: null,
      error: null,
      createdAt: T - 40 * D,
    };
    await typedDoc('deliveries', paths.delivery(dOld)).set(delivery);
    await typedDoc('deliveries', paths.delivery(dNew)).set({ ...delivery, createdAt: T - D });

    const board = await seedBoard([u.uid], {
      settings: { allowDelete: false, emailReplies: true, autoArchiveDoneAfterDays: 7 },
    });
    const stale = await seedTicket(board.id, {
      stageId: 'st_done',
      stageCategory: 'done',
      completedAt: T - 8 * D,
    });
    const fresh = await seedTicket(board.id, {
      stageId: 'st_done',
      stageCategory: 'done',
      completedAt: T - 2 * D,
    });

    const r = await housekeeping(T);
    expect(r.errors.filter((e) => !e.startsWith('uploadsDeleted'))).toEqual([]);

    expect((await typedDoc('invites', paths.invite(inviteOld)).get()).data()!.status).toBe(
      'expired',
    );
    expect((await typedDoc('invites', paths.invite(inviteLive)).get()).data()!.status).toBe(
      'pending',
    );
    const exists = async (p: string) => (await db().doc(p).get()).exists;
    expect(await exists(paths.inboxItem(u.uid, 'old-read'))).toBe(false);
    expect(await exists(paths.inboxItem(u.uid, 'old-unread'))).toBe(true);
    expect(await exists(paths.inboxItem(u.uid, 'new-read'))).toBe(true);
    expect(await exists(paths.delivery(dOld))).toBe(false);
    expect(await exists(paths.delivery(dNew))).toBe(true);

    expect((await ticketDoc(board.id, stale.id)).state).toBe('archived');
    expect((await ticketDoc(board.id, fresh.id)).state).toBe('active');
    expect(await actsOf(board.id, stale.id)).toEqual([
      expect.objectContaining({ action: 'state', via: 'system', actor: null }),
    ]);
  });

  it.skipIf(!process.env.FIREBASE_STORAGE_EMULATOR_HOST)(
    'deletes uploads no ticket.files row points at, older than 24h',
    async () => {
      const u = await seedUser();
      const board = await seedBoard([u.uid]);
      const t = await seedTicket(board.id);
      const bucket = storageAdmin().bucket();
      const kept = `boards/${board.id}/tickets/${t.id}/a1/kept.txt`;
      const orphan = `boards/${board.id}/tickets/${t.id}/a2/orphan.txt`;
      await bucket.file(kept).save('k');
      await bucket.file(orphan).save('o');
      await bucket.file(`boards/${board.id}/tickets/${t.id}/a2/thumb_400.webp`).save('t');
      await putFile(board.id, t.id, {
        id: 'a1',
        path: kept,
        name: 'kept.txt',
        mime: 'text/plain',
        size: 1,
        uploadedBy: u.uid,
        source: 'message',
        messageId: null,
        createdAt: T,
        deletedAt: null,
      });
      expect(await pruneUploads(Date.now() + 1000)).toBe(0); // too young
      expect(await pruneUploads(Date.now() + 2 * D)).toBeGreaterThanOrEqual(1);
      expect((await bucket.file(kept).exists())[0]).toBe(true);
      expect((await bucket.file(orphan).exists())[0]).toBe(false);
      expect(
        (await bucket.file(`boards/${board.id}/tickets/${t.id}/a2/thumb_400.webp`).exists())[0],
      ).toBe(false);
    },
  );
});
