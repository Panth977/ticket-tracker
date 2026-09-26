/**
 * Notification configuration: public URLs, the inbound mail domain and the
 * server secrets that sign reply / unsubscribe tokens. Everything reads the
 * environment lazily so tests can set it per case.
 *
 *   APP_URL                    where links in push / mail / WhatsApp point
 *   INBOUND_EMAIL_DOMAIN       t.{token}@… (replies) and {intake}@… (email-to-board)
 *   MAIL_DOMAIN                right-hand side of our Message-IDs
 *   NOTIFY_SIGNING_SECRET      HMAC key for reply tokens and one-click unsubscribe
 *   RESEND_WEBHOOK_SECRET      svix secret of the Resend inbound webhook ('whsec_…')
 *   WHATSAPP_APP_SECRET        Meta app secret (X-Hub-Signature-256)
 *   WHATSAPP_VERIFY_TOKEN      Meta webhook subscription handshake
 */
import { createHmac } from 'node:crypto';
import type { Channel, DeliveryChannel, NotifyEvent } from '@tm/shared';
import { isEmulated } from '../runtime/firebase.js';

export const appUrl = (): string =>
  (
    process.env.APP_URL ?? (isEmulated() ? 'http://127.0.0.1:5190' : 'https://taskmanager.app')
  ).replace(/\/$/, '');
export const inboundDomain = (): string => process.env.INBOUND_EMAIL_DOMAIN ?? 'in.taskmanager.app';
export const mailDomain = (): string => process.env.MAIL_DOMAIN ?? 'taskmanager.app';

/**
 * The signing secret. Production must set it; under the emulators a fixed dev
 * value keeps tokens stable across restarts (nothing real is protected there).
 */
export function signingSecret(): string {
  const s = process.env.NOTIFY_SIGNING_SECRET;
  if (s) return s;
  if (isEmulated()) return 'dev-notify-signing-secret';
  throw new Error('NOTIFY_SIGNING_SECRET is not set');
}

export const hmac = (data: string, key = signingSecret()): string =>
  createHmac('sha256', key).update(data).digest('base64url');
/** Lower-case hex HMAC — for tokens that travel in e-mail addresses (case may not survive). */
export const hmacHex = (data: string, key = signingSecret()): string =>
  createHmac('sha256', key).update(data).digest('hex');

/** The window notify() collapses deliveries into: one task per person, group and minute. */
export const DELIVER_WINDOW_MS = 60_000;
/** Reply-To threads live this long (emailThreads.expiresAt). */
export const EMAIL_THREAD_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** How long a bare WhatsApp reply refers to the last ticket we notified about. */
export const WHATSAPP_CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Out-of-app channels a deliver task carries. */
export type OutChannel = Exclude<Channel, 'inApp'>;
export const OUT_CHANNELS: readonly OutChannel[] = ['push', 'email', 'whatsapp'];

export const PROVIDER: Record<OutChannel, 'fcm' | 'resend' | 'meta'> = {
  push: 'fcm',
  email: 'resend',
  whatsapp: 'meta',
};
export const asDeliveryChannel = (c: OutChannel): DeliveryChannel => c;

/** groupKey — `${ticketId}:${event}` (app/db.json inbox); invitations group per invite. */
export function groupKeyFor(
  event: NotifyEvent,
  ticketId: string | null,
  inviteId?: string,
): string {
  if (ticketId) return `${ticketId}:${event}`;
  return `invite:${inviteId ?? 'none'}`;
}

/** Firestore doc ids may not contain '/'; groupKeys never do, but be safe. */
export const inboxIdFor = (groupKey: string): string => groupKey.replace(/\//g, '_');

/** The system actor used by schedules (deadlineSweep): never a real uid, never notified. */
export const SYSTEM_ACTOR = 'system';
