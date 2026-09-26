/**
 * The deliver task: suppression, quiet hours, the person's channel matrix,
 * and each channel (push / email / WhatsApp) with its delivery log.
 */
import { describe, expect, it } from 'vitest';
import { defaultChannelMatrix, paths, type Delivery, type User } from '@tm/shared';
import '../../src/jobs/deliver.js';
import { deliver } from '../../src/notify/deliver.js';
import { route } from '../../src/notify/index.js';
import { parseReplyAddress, verifyUnsubscribeToken } from '../../src/notify/tokens.js';
import { db } from '../../src/runtime/firebase.js';
import { typedDoc } from '../../src/runtime/index.js';
import { setupEmulators } from '../harness/index.js';
import { ctxOf, seedBoard, seedTicket, seedUser, T, useFakes } from './_seed.js';

setupEmulators();

async function deliveries(uid: string): Promise<Delivery[]> {
  const s = await db().collection('deliveries').where('uid', '==', uid).get();
  return s.docs.map((d) => d.data() as Delivery);
}

/** actor mentions `u` on a fresh ticket; returns the pieces. */
async function mention(userOver: Partial<User> = {}, boardOver = {}) {
  const f = useFakes();
  const actor = await seedUser({ name: 'Priya Shah' });
  const u = await seedUser(userOver);
  const board = await seedBoard([actor.uid, u.uid], boardOver);
  const t = await seedTicket(board.id, { title: 'Fix <login>' });
  await route('mentioned', t, ctxOf(actor.uid), { mentioned: [u.uid] });
  return { f, actor, u, board, t };
}

describe('deliver', () => {
  it('push + email for a mention: payloads, reply token, phantom root, unsubscribe, deliveries log', async () => {
    const { f, u, t } = await mention();
    await typedDoc('devices', `${paths.devices(u.uid)}/d1`).set({
      fcmToken: 'tok-ok',
      kind: 'web',
      userAgent: 'x',
      lastSeenAt: T,
    });
    await typedDoc('devices', `${paths.devices(u.uid)}/d2`).set({
      fcmToken: 'unregistered-1',
      kind: 'web',
      userAgent: 'x',
      lastSeenAt: T,
    });
    expect(await f.queue.drain()).toBe(1);

    expect(f.push).toHaveLength(1);
    expect(f.push[0]!.msg).toMatchObject({
      title: `${t.key} · Priya Shah`,
      body: 'mentioned you — Fix <login>',
      url: `/t/${t.key}`,
      tag: t.id,
    });
    // stale token cleaned up
    expect(
      (
        await db()
          .doc(`${paths.devices(u.uid)}/d2`)
          .get()
      ).exists,
    ).toBe(false);
    expect(
      (
        await db()
          .doc(`${paths.devices(u.uid)}/d1`)
          .get()
      ).exists,
    ).toBe(true);

    expect(f.mail).toHaveLength(1);
    const m = f.mail[0]!;
    expect(m.to).toBe(u.email);
    expect(m.subject).toBe(`[${t.key}] Fix <login>`);
    expect(m.html).toContain('Fix &lt;login&gt;');
    expect(m.html).not.toContain('Fix <login>');
    expect(m.text).toContain('Priya Shah mentioned you');
    expect(m.headers!['In-Reply-To']).toBe(`<ticket-${t.id}@taskmanager.app>`);
    expect(m.headers!['References']).toBe(m.headers!['In-Reply-To']);
    expect(m.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const unsub = /t=([^>]+)>/.exec(m.headers!['List-Unsubscribe']!)![1]!;
    expect(verifyUnsubscribeToken(unsub)).toEqual({ uid: u.uid, event: 'mentioned' });
    const token = parseReplyAddress(m.replyTo!)!;
    expect(token).toBeTruthy();
    const thread = (await typedDoc('emailThreads', paths.emailThread(token)).get()).data();
    expect(thread).toMatchObject({
      ticketId: t.id,
      uid: u.uid,
      messageIdHeader: `<ticket-${t.id}@taskmanager.app>`,
    });

    const log = await deliveries(u.uid);
    expect(log.map((d) => [d.channel, d.status, d.provider]).sort()).toEqual([
      ['email', 'sent', 'resend'],
      ['push', 'sent', 'fcm'],
    ]);
    expect(log.every((d) => d.inboxIds[0] === `${t.id}:mentioned`)).toBe(true);
  });

  it('no Reply-To when the board refuses email replies; no push devices → suppressed', async () => {
    const { f, u } = await mention(
      {},
      { settings: { allowDelete: false, emailReplies: false, autoArchiveDoneAfterDays: null } },
    );
    await f.queue.drain();
    expect(f.mail[0]!.replyTo).toBeUndefined();
    const log = await deliveries(u.uid);
    expect(log.find((d) => d.channel === 'push')).toMatchObject({
      status: 'suppressed',
      error: 'No push devices',
    });
  });

  it('read in the app before the window closed → suppressed, nothing sent', async () => {
    const { f, u, t } = await mention();
    await typedDoc('inbox', paths.inboxItem(u.uid, `${t.id}:mentioned`)).update({ readAt: T + 1 });
    await f.queue.drain();
    expect(f.mail).toHaveLength(0);
    expect(f.push).toHaveLength(0);
    const log = await deliveries(u.uid);
    expect(log.map((d) => d.status)).toEqual(['suppressed', 'suppressed']);
  });

  it('snoozed rows are not announced', async () => {
    const { f, u, t } = await mention();
    await typedDoc('inbox', paths.inboxItem(u.uid, `${t.id}:mentioned`)).update({
      snoozedUntil: T + 3_600_000,
    });
    await f.queue.drain();
    expect(f.mail).toHaveLength(0);
  });

  it("quiet hours reschedule to their end (in the person's zone)", async () => {
    // 12:00 UTC = 17:30 in Kolkata; quiet 17:00–19:00 there → ends 13:30 UTC.
    const { f, u, t } = await mention({
      timezone: 'Asia/Kolkata',
      notify: {
        channels: defaultChannelMatrix(),
        quietHours: { start: '17:00', end: '19:00' },
        digest: 'off',
        dueSoonLeadMinutes: 60,
        commitmentReminders: false,
      },
    });
    const task = f.queue.pending()[0]!;
    f.queue.clear();
    const out = await deliver(task.payload as never);
    expect(out.rescheduledTo).toBe(Date.UTC(2026, 8, 22, 13, 30));
    expect(f.mail).toHaveLength(0);
    const [again] = f.queue.pending();
    expect(again).toMatchObject({
      queue: 'deliver',
      payload: { uid: u.uid, groupKey: `${t.id}:mentioned` },
    });
    expect(again!.opts.delaySeconds).toBe(90 * 60);

    // After the window: it goes out.
    f.clock.set(Date.UTC(2026, 8, 22, 13, 31));
    const sent = await deliver(again!.payload as never);
    expect(sent.results.map((r) => r.status)).toEqual(['suppressed', 'sent']); // no devices, email sent
  });

  it('the person unticked email after the event → only what they still want', async () => {
    const { f, u } = await mention();
    const ch = { ...defaultChannelMatrix(), mentioned: ['inApp' as const, 'push' as const] };
    await typedDoc('users', paths.user(u.uid)).update({ 'notify.channels': ch });
    await f.queue.drain();
    expect(f.mail).toHaveLength(0);
    expect((await deliveries(u.uid)).map((d) => d.channel)).toEqual(['push']);
  });

  it('a user deleted since → nothing', async () => {
    const { f, u } = await mention();
    await typedDoc('users', paths.user(u.uid)).update({ deletedAt: T });
    await f.queue.drain();
    expect(f.mail).toHaveLength(0);
    expect(await deliveries(u.uid)).toHaveLength(0);
  });

  it('every channel failing throws for a retry; the final attempt logs and gives up', async () => {
    const { f, u } = await mention({
      notify: {
        channels: { ...defaultChannelMatrix(), mentioned: ['inApp', 'email'] },
        quietHours: null,
        digest: 'off',
        dueSoonLeadMinutes: 60,
        commitmentReminders: false,
      },
    });
    f.failEmail(true);
    const task = f.queue.pending()[0]!;
    await expect(deliver(task.payload as never, { retryCount: 0 })).rejects.toThrow(
      /every channel failed/,
    );
    const out = await deliver(task.payload as never, { retryCount: 4 });
    expect(out.results).toEqual([
      expect.objectContaining({ channel: 'email', status: 'failed', error: 'smtp down' }),
    ]);
    expect((await deliveries(u.uid)).filter((d) => d.status === 'failed')).toHaveLength(2);
  });

  it('WhatsApp: template outside the 24h window, free text inside; context ticket recorded', async () => {
    const number = `+9198${Math.floor(Math.random() * 1e8)}`;
    const wa = { number, verifiedAt: T - 1000, optIn: true };
    const channels = {
      ...defaultChannelMatrix(),
      mentioned: ['inApp' as const, 'whatsapp' as const],
    };
    const { f, u, t } = await mention({
      whatsapp: wa,
      notify: {
        channels,
        quietHours: null,
        digest: 'off',
        dueSoonLeadMinutes: 60,
        commitmentReminders: false,
      },
    });
    await f.queue.drain();
    expect(f.wa).toEqual([
      {
        kind: 'template',
        to: number,
        template: 'ticket_update',
        params: [t.key, 'Fix <login>', 'Priya Shah mentioned you'],
      },
    ]);
    const s = (await typedDoc('whatsappSessions', paths.whatsappSession(number)).get()).data();
    expect(s).toMatchObject({ uid: u.uid, contextTicketId: t.id, lastInboundAt: null });
    expect((await deliveries(u.uid))[0]).toMatchObject({
      channel: 'whatsapp',
      status: 'sent',
      provider: 'meta',
      providerId: 'wamid.1',
    });

    // They wrote to us an hour ago → free text with the link.
    await typedDoc('whatsappSessions', paths.whatsappSession(number)).update({
      lastInboundAt: T - 3_600_000,
    });
    await typedDoc('inbox', paths.inboxItem(u.uid, `${t.id}:mentioned`)).update({ readAt: null });
    await deliver({
      uid: u.uid,
      groupKey: `${t.id}:mentioned`,
      inboxIds: [`${t.id}:mentioned`],
      channels: ['whatsapp'],
    });
    expect(f.wa[1]).toMatchObject({ kind: 'text', to: number });
    expect(f.wa[1]!.text).toContain(`/t/${t.key}`);
  });

  it('WhatsApp opted out since → not sent', async () => {
    const number = `+9197${Math.floor(Math.random() * 1e8)}`;
    const channels = {
      ...defaultChannelMatrix(),
      mentioned: ['inApp' as const, 'whatsapp' as const],
    };
    const { f, u, t } = await mention({
      whatsapp: { number, verifiedAt: T, optIn: true },
      notify: {
        channels,
        quietHours: null,
        digest: 'off',
        dueSoonLeadMinutes: 60,
        commitmentReminders: false,
      },
    });
    await typedDoc('users', paths.user(u.uid)).update({ 'whatsapp.optIn': false });
    const out = await deliver({
      uid: u.uid,
      groupKey: `${t.id}:mentioned`,
      inboxIds: [`${t.id}:mentioned`],
      channels: ['whatsapp'],
    });
    expect(out.skipped).toBe('no-channels');
    expect(f.wa).toHaveLength(0);
  });
});
