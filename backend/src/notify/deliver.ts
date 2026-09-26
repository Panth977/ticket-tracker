/**
 * deliver — the queue task behind every push, mail and WhatsApp message
 * (platform/backend.json services.deliver). Enqueued by notify() as
 * `${uid}:${groupKey}:${minute}`; carries inbox row ids, never content — the
 * copy is read fresh here, so a burst collapsed into one row goes out once.
 *
 *   user gone                         → nothing
 *   every row read / archived / snoozed in the app → 'suppressed', nothing sent
 *   quiet hours                       → re-enqueued for the end of them
 *   channels = task.channels ∩ what the person wants NOW (they may have
 *              unticked email since the event)
 *   push      FCM to users/{uid}/devices, tag = ticketId (a newer push
 *             replaces the older one); unregistered tokens → device deleted
 *   email     HTML per event, Reply-To = emailThreads token (when the board
 *             accepts replies), In-Reply-To/References = the ticket's phantom
 *             root, List-Unsubscribe one-click for this event
 *   whatsapp  opted in only; free text inside Meta's 24h window, approved
 *             template outside; the session remembers the ticket so a bare
 *             reply lands in the right thread
 *   every attempt → deliveries/{id} (status, provider id, error)
 */
import {
  paths,
  WHATSAPP_WINDOW_MS,
  type Board,
  type Delivery,
  type DeliverTask,
  type InboxItem,
  type User,
} from '@tm/shared';
import { inQuietHours, nextAfterQuietHours } from '@tm/shared/logic/time';
import { isNotConfigured, NOT_CONFIGURED, ports } from '../adapters/index.js';
import { db } from '../runtime/firebase.js';
import { getDoc, typedCol, typedDoc } from '../runtime/index.js';
import { renderNotifyMail } from '../templates/email.js';
import {
  appUrl,
  EMAIL_THREAD_TTL_MS,
  mailDomain,
  PROVIDER,
  WHATSAPP_CONTEXT_TTL_MS,
  type OutChannel,
} from './config.js';
import { outChannels } from './router.js';
import { EVENT_STYLE } from './summary.js';
import { phantomRootId, replyAddress, replyToken, unsubscribeToken } from './tokens.js';

/** A re-run within this much of the quiet window's end just sends (clock skew). */
const QUIET_SLACK_MS = 2 * 60_000;
/** Cloud Tasks retries a task whose every channel failed, this many times. */
const MAX_RETRIES = 4;

export type ChannelOutcome = {
  channel: OutChannel;
  status: Delivery['status'];
  deliveryId: string;
  error?: string;
};
export interface DeliverOutcome {
  skipped?: 'no-user' | 'read' | 'no-channels';
  rescheduledTo?: number;
  results: ChannelOutcome[];
}

export async function deliver(
  task: DeliverTask,
  meta: { retryCount: number } = { retryCount: 0 },
): Promise<DeliverOutcome> {
  const now = ports().clock.now();
  const user = await getDoc(typedDoc('users', paths.user(task.uid)));
  if (!user || user.deletedAt) return { skipped: 'no-user', results: [] };

  // What is still unseen? Read, archived or snoozed rows are not re-announced.
  const snaps = task.inboxIds.length
    ? await db().getAll(
        ...task.inboxIds.map((id) => typedDoc('inbox', paths.inboxItem(task.uid, id))),
      )
    : [];
  const open = snaps
    .filter((s) => s.exists)
    .map((s) => ({ id: s.id, item: s.data() as InboxItem }))
    .filter(
      ({ item }) =>
        item.readAt === null &&
        item.archivedAt === null &&
        !(item.snoozedUntil && item.snoozedUntil > now),
    );

  if (open.length === 0) {
    const results = await Promise.all(
      task.channels.map((channel) =>
        log(task, channel, now, { status: 'suppressed', error: 'Already read in the app' }).then(
          (deliveryId) => ({
            channel,
            status: 'suppressed' as const,
            deliveryId,
          }),
        ),
      ),
    );
    return { skipped: 'read', results };
  }

  // A mention may break quiet hours when the person allowed it (Account › Notifications).
  const mentionBreaksQuiet =
    user.notify.quietHoursAllowMentions === true && open.every((o) => o.item.event === 'mentioned');
  const quietUntil = mentionBreaksQuiet ? null : quietEnd(user, now);
  if (quietUntil !== null) {
    await ports().queue.enqueue('deliver', task, {
      name: `${task.uid}:${task.groupKey}:q${Math.floor(quietUntil / 60_000)}`,
      delaySeconds: Math.ceil((quietUntil - now) / 1000),
    });
    return { rescheduledTo: quietUntil, results: [] };
  }

  const { item } = open[0]!;
  const inboxIds = open.map((o) => o.id);
  const wanted = new Set(outChannels(user, item.event));
  const channels = task.channels.filter((c) => wanted.has(c));
  if (channels.length === 0) return { skipped: 'no-channels', results: [] };

  const [board, actor] = await Promise.all([
    getDoc(typedDoc('boards', paths.board(item.boardId))),
    item.actor ? getDoc(typedDoc('users', paths.user(item.actor))) : Promise.resolve(undefined),
  ]);
  const c: SendContext = {
    task: { ...task, inboxIds },
    user,
    item,
    board,
    actorName: actor && !actor.deletedAt ? actor.name : null,
    now,
  };

  const results: ChannelOutcome[] = [];
  for (const channel of channels) {
    const deliveryId = ports().ids.id();
    let status: Delivery['status'];
    let providerId: string | null = null;
    let error: string | undefined;
    try {
      const r = await SENDERS[channel](c, deliveryId);
      status = r.status;
      providerId = r.providerId ?? null;
      error = r.error;
    } catch (e) {
      if (isNotConfigured(e)) {
        // Production without this provider's credentials: recorded, never retried.
        status = 'suppressed';
        error = NOT_CONFIGURED;
      } else {
        status = 'failed';
        error = e instanceof Error ? e.message : String(e);
        console.error(`[deliver] ${channel} to ${task.uid} failed`, e);
      }
    }
    await log(c.task, channel, now, { status, providerId, error }, deliveryId);
    results.push({ channel, status, deliveryId, ...(error ? { error } : {}) });
  }

  // Only when NOTHING went out is a retry safe (a retry must not repeat a sent push).
  if (results.every((r) => r.status === 'failed') && meta.retryCount < MAX_RETRIES) {
    throw new Error(`deliver ${task.uid}:${task.groupKey}: every channel failed`);
  }
  return { results };
}

/** When a delivery held for quiet hours may go, or null when it may go now. */
function quietEnd(user: User, now: number): number | null {
  try {
    if (!inQuietHours(user, now)) return null;
    const at = nextAfterQuietHours(user, now);
    return at - now > QUIET_SLACK_MS ? at : null;
  } catch {
    return null; // a malformed zone or window never blocks a notification
  }
}

async function log(
  task: DeliverTask,
  channel: OutChannel,
  now: number,
  r: { status: Delivery['status']; providerId?: string | null; error?: string | undefined },
  id = ports().ids.id(),
): Promise<string> {
  const row: Delivery = {
    uid: task.uid,
    channel,
    groupKey: task.groupKey,
    inboxIds: task.inboxIds,
    status: r.status,
    provider: PROVIDER[channel],
    providerId: r.providerId ?? null,
    error: r.error ?? null,
    createdAt: now,
  };
  await typedDoc('deliveries', paths.delivery(id)).set(row);
  return id;
}

// ─── channels ────────────────────────────────────────────────────────────────

interface SendContext {
  task: DeliverTask;
  user: User;
  item: InboxItem;
  board: Board | undefined;
  actorName: string | null;
  now: number;
}
interface SendResult {
  status: Delivery['status'];
  providerId?: string | null;
  error?: string;
}

/** Links in every channel. */
export function itemUrl(item: Pick<InboxItem, 'ticketKey' | 'messageId'>): string {
  if (!item.ticketKey) return `${appUrl()}/inbox`;
  return `${appUrl()}/t/${encodeURIComponent(item.ticketKey)}${item.messageId ? `?m=${encodeURIComponent(item.messageId)}` : ''}`;
}
export const settingsUrl = (): string => `${appUrl()}/account/notifications`;

const more = (count: number) => (count > 1 ? ` (${count} updates)` : '');

const SENDERS: Record<OutChannel, (c: SendContext, deliveryId: string) => Promise<SendResult>> = {
  async push({ task, item, actorName }) {
    const devices = await typedCol('devices', paths.devices(task.uid)).get();
    const byToken = new Map(devices.docs.map((d) => [d.data().fcmToken, d.ref]));
    if (byToken.size === 0) return { status: 'suppressed', error: 'No push devices' };

    const who = actorName ?? EVENT_STYLE[item.event].kicker;
    const res = await ports().push.send([...byToken.keys()], {
      title: item.ticketKey ? `${item.ticketKey} · ${who}` : who,
      body: `${item.summary}${more(item.count)}${item.ticketTitle ? ` — ${item.ticketTitle}` : ''}`,
      url: itemUrl(item).slice(appUrl().length) || '/',
      // One notification per ticket on the device: the newest replaces the rest.
      tag: item.ticketId ?? item.groupKey,
      data: {
        boardId: item.boardId,
        ...(item.ticketId ? { ticketId: item.ticketId } : {}),
        inboxId: task.inboxIds[0] ?? '',
        event: item.event,
      },
    });
    const gone = res
      .filter((r) => r.unregistered)
      .map((r) => byToken.get(r.token))
      .filter((r) => !!r);
    await Promise.all(gone.map((ref) => ref.delete()));
    const ok = res.find((r) => r.ok);
    if (ok) return { status: 'sent', providerId: ok.providerId ?? null };
    return {
      status: 'failed',
      error: res.map((r) => r.error ?? 'failed').join('; ') || 'No token accepted',
    };
  },

  async email({ task, user, item, board, actorName, now }, deliveryId) {
    if (!user.email) return { status: 'suppressed', error: 'No email address' };
    const replyable = !!item.ticketId && !!board?.settings.emailReplies;
    const headers: Record<string, string> = {
      'Message-ID': `<${deliveryId}@${mailDomain()}>`,
    };
    let replyTo: string | undefined;
    if (item.ticketId) {
      const root = phantomRootId(item.ticketId);
      headers['In-Reply-To'] = root;
      headers['References'] = root;
      if (replyable) {
        const token = replyToken(task.uid, item.ticketId);
        replyTo = replyAddress(token);
        await typedDoc('emailThreads', paths.emailThread(token)).set({
          boardId: item.boardId,
          ticketId: item.ticketId,
          uid: task.uid,
          messageIdHeader: root,
          expiresAt: now + EMAIL_THREAD_TTL_MS,
        });
      }
    }
    headers['List-Unsubscribe'] =
      `<${appUrl()}/hooks/email/unsubscribe?t=${unsubscribeToken(task.uid, item.event)}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';

    const mail = renderNotifyMail({
      event: item.event,
      actorName,
      summary: item.summary,
      count: item.count,
      ticketKey: item.ticketKey,
      ticketTitle: item.ticketTitle,
      boardName: board?.name ?? 'TaskManager',
      url: itemUrl(item),
      settingsUrl: settingsUrl(),
      replyable,
    });
    const { providerId } = await ports().email.send({
      to: user.email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      ...(replyTo ? { replyTo } : {}),
      headers,
      tag: `notify.${item.event}`,
    });
    return { status: 'sent', providerId };
  },

  async whatsapp({ task, user, item, actorName, now }) {
    const wa = user.whatsapp;
    if (!wa?.optIn) return { status: 'suppressed', error: 'WhatsApp not opted in' };
    const ref = typedDoc('whatsappSessions', paths.whatsappSession(wa.number));
    const session = await getDoc(ref);
    const mine = session?.uid === task.uid ? session : undefined;
    const inWindow = !!mine?.lastInboundAt && now - mine.lastInboundAt < WHATSAPP_WINDOW_MS;

    const who = actorName ? `${actorName} ` : '';
    const head = item.ticketKey
      ? `${item.ticketKey} · ${item.ticketTitle ?? ''}`.trim()
      : EVENT_STYLE[item.event].kicker;
    const { providerId } = inWindow
      ? await ports().whatsapp.sendText(
          wa.number,
          `${head}\n${who}${item.summary}${more(item.count)}\n${itemUrl(item)}`,
        )
      : await ports().whatsapp.sendTemplate(
          wa.number,
          item.event === 'dueSoon' || item.event === 'overdue' ? 'ticket_due' : 'ticket_update',
          [
            item.ticketKey ?? EVENT_STYLE[item.event].kicker,
            item.ticketTitle ?? '',
            `${who}${item.summary}`.trim(),
          ],
        );

    // A bare reply refers to the ticket we last told them about.
    await ref.set({
      uid: task.uid,
      lastInboundAt: mine?.lastInboundAt ?? null,
      contextTicketId: item.ticketId ?? mine?.contextTicketId ?? null,
      contextExpiresAt: now + WHATSAPP_CONTEXT_TTL_MS,
    });
    return { status: 'sent', providerId };
  },
};
