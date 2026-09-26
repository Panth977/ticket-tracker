/**
 * Signed tokens that travel in mail headers.
 *
 * REPLY TOKEN — Reply-To: t.{token}@in.taskmanager.app. Deterministic per
 * (person, ticket): HMAC(secret, uid:ticketId), so every mail about one
 * ticket to one person carries the same address and no lookup is needed to
 * find it again. Unguessable without the secret; emailThreads/{token} holds
 * where it leads and expires 90 days after the last mail.
 *
 * UNSUBSCRIBE TOKEN — List-Unsubscribe one-click (RFC 8058): which person and
 * which event, signed. POSTing it removes 'email' from that event only.
 *
 * PHANTOM ROOT — every mail about a ticket says In-Reply-To / References the
 * same Message-ID that was never sent, so mail clients thread them together.
 */
import { timingSafeEqual } from 'node:crypto';
import { NOTIFY_EVENTS, type NotifyEvent } from '@tm/shared';
import { hmac, hmacHex, inboundDomain, mailDomain } from './config.js';

/** Lower-case hex: mail systems may change the case of an address's local part. */
export function replyToken(uid: string, ticketId: string): string {
  return hmacHex(`reply:${uid}:${ticketId}`).slice(0, 32);
}

export const replyAddress = (token: string): string => `t.${token}@${inboundDomain()}`;

/** The token from 't.{token}@in.…' (case-insensitive domain), or null. */
export function parseReplyAddress(address: string): string | null {
  const m = /^t\.([a-f0-9]{8,64})@(.+)$/i.exec(address.trim());
  if (!m || m[2]!.toLowerCase() !== inboundDomain().toLowerCase()) return null;
  return m[1]!.toLowerCase();
}

export const phantomRootId = (ticketId: string): string => `<ticket-${ticketId}@${mailDomain()}>`;

export function unsubscribeToken(uid: string, event: NotifyEvent): string {
  const body = Buffer.from(JSON.stringify({ u: uid, e: event })).toString('base64url');
  return `${body}.${hmac(`unsub:${body}`)}`;
}

export function verifyUnsubscribeToken(token: string): { uid: string; event: NotifyEvent } | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(hmac(`unsub:${body}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const { u, e } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      u: unknown;
      e: unknown;
    };
    if (typeof u !== 'string' || !u || !(NOTIFY_EVENTS as readonly unknown[]).includes(e))
      return null;
    return { uid: u, event: e as NotifyEvent };
  } catch {
    return null;
  }
}
