/**
 * digestSend — every hour on the hour (app/backend.json services.digestSend).
 *
 *   who     digest 'hourly' → every run; 'daily' → the run where it is 09:00
 *           in the person's own zone
 *   what    unread inbox rows from the period (1h / 24h), grouped by board,
 *           + 'due today' and 'overdue' from My Work (assigned, not done)
 *   how     ONE e-mail; nothing to say → nothing sent
 *
 * The period is the schedule's own window, so no 'last digest' marker is
 * needed; the deliveries row id is deterministic (per person and hour), so a
 * retried run never mails twice.
 */
import {
  parseTicketPath,
  paths,
  type Board,
  type Delivery,
  type InboxItem,
  type Ticket,
  type User,
} from '@tm/shared';
import { dayRange, isOverdue, zonedParts } from '@tm/shared/logic/time';
import { isNotConfigured, NOT_CONFIGURED, ports } from '../adapters/index.js';
import { db } from '../runtime/firebase.js';
import { converterFor, typedCol, typedDoc } from '../runtime/index.js';
import { renderDigestMail } from '../templates/digest.js';
import { appUrl } from './config.js';
import { itemUrl, settingsUrl } from './deliver.js';

const HOUR = 60 * 60 * 1000;
export const DAILY_DIGEST_HOUR = 9;

export type DigestPeriod = 'hourly' | 'daily';

/** Which digest (if any) this person gets on the run at `now`. */
export function digestDue(
  user: Pick<User, 'notify' | 'timezone'>,
  now: number,
): DigestPeriod | null {
  const d = user.notify.digest;
  if (d === 'hourly') return 'hourly';
  if (d !== 'daily') return null;
  try {
    return zonedParts(now, user.timezone).hour === DAILY_DIGEST_HOUR ? 'daily' : null;
  } catch {
    return null;
  }
}

export interface DigestRunResult {
  sent: string[];
  empty: string[];
}

export async function digestSend(now: number): Promise<DigestRunResult> {
  const res: DigestRunResult = { sent: [], empty: [] };
  const snap = await typedCol('users', paths.users())
    .where('notify.digest', 'in', ['hourly', 'daily'])
    .get();
  for (const doc of snap.docs) {
    const user = doc.data();
    if (user.deletedAt || !user.email) continue;
    const period = digestDue(user, now);
    if (!period) continue;
    try {
      const sent = await digestFor(doc.id, user, period, now);
      (sent ? res.sent : res.empty).push(doc.id);
    } catch (e) {
      console.error(`[digestSend] ${doc.id} failed`, e);
    }
  }
  return res;
}

/** Build and send one person's digest. Returns false when there was nothing to say. */
export async function digestFor(
  uid: string,
  user: User,
  period: DigestPeriod,
  now: number,
): Promise<boolean> {
  const hourStamp = Math.floor(now / HOUR);
  const logRef = typedDoc('deliveries', paths.delivery(`digest_${uid}_${hourStamp}`));
  const prior = await logRef.get();
  // Sent (or being sent) this hour already; a failed attempt may be retried.
  if (prior.exists && prior.data()!.status !== 'failed') return true;

  const since = now - (period === 'daily' ? 24 * HOUR : HOUR);
  const inboxSnap = await typedCol('inbox', paths.inbox(uid)).where('createdAt', '>', since).get();
  const unread = inboxSnap.docs
    .map((d) => ({ id: d.id, item: d.data() as InboxItem }))
    .filter(
      ({ item }) =>
        item.readAt === null &&
        item.archivedAt === null &&
        !(item.snoozedUntil && item.snoozedUntil > now),
    )
    .sort((a, b) => b.item.createdAt - a.item.createdAt);

  // My Work: assigned to me, not done, with a due date up to the end of my today.
  const today = dayRange(now, user.timezone);
  const work = await db()
    .collectionGroup('tickets')
    .withConverter(converterFor('tickets'))
    .where('assigneeUids', 'array-contains', uid)
    .where('stageCategory', 'in', ['backlog', 'todo', 'active'])
    .where('dueAt', '<', today.end)
    .get();
  const overdue: { key: string; title: string; url: string }[] = [];
  const dueToday: { key: string; title: string; url: string }[] = [];
  for (const d of work.docs) {
    const t = d.data() as Ticket;
    if (t.state !== 'active' || t.dueAt === null || !parseTicketPath(d.ref.path)) continue;
    const row = { key: t.key, title: t.title, url: `${appUrl()}/t/${encodeURIComponent(t.key)}` };
    if (isOverdue(t.dueAt, now, { allDay: t.dueAllDay, tz: user.timezone })) overdue.push(row);
    else if (t.dueAt >= today.start) dueToday.push(row);
  }

  if (unread.length === 0 && overdue.length === 0 && dueToday.length === 0) return false;

  const boardIds = [...new Set(unread.map((u) => u.item.boardId))];
  const boardSnaps = boardIds.length
    ? await db().getAll(...boardIds.map((id) => typedDoc('boards', paths.board(id))))
    : [];
  const boardName = new Map(
    boardSnaps.map((s) => [s.id, s.exists ? (s.data() as Board).name : 'A board']),
  );
  const boards = boardIds.map((id) => ({
    name: boardName.get(id) ?? 'A board',
    items: unread
      .filter((u) => u.item.boardId === id)
      .map(({ item }) => ({
        line: `${item.ticketKey ? `${item.ticketKey} · ` : ''}${item.summary}${item.count > 1 ? ` (${item.count})` : ''}`,
        url: itemUrl(item),
      })),
  }));

  const mail = renderDigestMail({
    name: user.name,
    period,
    boards,
    dueToday,
    overdue,
    inboxUrl: `${appUrl()}/inbox`,
    settingsUrl: settingsUrl(),
  });
  const row: Delivery = {
    uid,
    channel: 'email',
    groupKey: `digest:${period}`,
    inboxIds: unread.map((u) => u.id).slice(0, 100),
    status: 'queued',
    provider: 'resend',
    providerId: null,
    error: null,
    createdAt: now,
  };
  // Claim first: a concurrent run sees the row and stops.
  try {
    if (prior.exists) await logRef.set(row);
    else await logRef.create(row);
  } catch {
    return true;
  }
  try {
    const { providerId } = await ports().email.send({
      to: user.email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      tag: 'digest',
    });
    await logRef.update({ status: 'sent', providerId });
  } catch (e) {
    if (isNotConfigured(e)) {
      await logRef.update({ status: 'suppressed', error: NOT_CONFIGURED });
      return true;
    }
    await logRef.update({ status: 'failed', error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  return true;
}
