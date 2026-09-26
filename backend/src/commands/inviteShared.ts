/**
 * Invite helpers shared by inviteCreate / inviteAccept / inviteRevoke and
 * the auth triggers (a new account finds its pending invites in the inbox).
 *
 * The invitee's inbox row is written HERE, not by notify(): the invitee is
 * not on the board yet (no prefs, no role), and the same row must be written
 * by the onUserCreated trigger for people who sign up after being invited.
 * Its id is deterministic — invite_{inviteId} — so every writer is idempotent.
 */
import { INVITE_TTL_MS, paths, type InboxItem, type Invite, type Via } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { typedDoc } from '../runtime/converters.js';
import { auth, db } from '../runtime/firebase.js';
import { appUrl } from './boardShared.js';

export { INVITE_TTL_MS };

export const inviteRef = (inviteId: string) => typedDoc('invites', paths.invite(inviteId));
export const inviteInboxId = (inviteId: string) => `invite_${inviteId}`;
export const inviteInboxRef = (uid: string, inviteId: string) =>
  typedDoc('inbox', paths.inboxItem(uid, inviteInboxId(inviteId)));

const ROLE_WORDS: Record<Invite['role'], string> = {
  admin: 'an admin',
  editor: 'an editor',
  commenter: 'a commenter',
  viewer: 'a viewer',
};

export function inviteSummary(inv: Pick<Invite, 'invitedByName' | 'boardName' | 'role'>): string {
  return `${inv.invitedByName} invited you to ${inv.boardName} as ${ROLE_WORDS[inv.role]}`;
}

export function inviteInboxItem(inv: Invite, inviteId: string, via: Via, now: number): InboxItem {
  return {
    event: 'invited',
    boardId: inv.boardId,
    ticketId: null,
    ticketKey: null,
    ticketTitle: null,
    inviteId,
    actor: inv.invitedBy,
    via,
    summary: inviteSummary(inv),
    groupKey: `invite:${inviteId}`,
    count: 1,
    createdAt: now,
    readAt: null,
    archivedAt: null,
    snoozedUntil: null,
  };
}

/** A pending invite that can still be accepted. */
export const isLive = (inv: Invite, now: number) => inv.status === 'pending' && inv.expiresAt > now;

/** The uid of the (not deleted) account using this e-mail, if any. */
export async function uidForEmail(email: string): Promise<string | null> {
  const q = await db().collection(paths.users()).where('email', '==', email).limit(5).get();
  const live = q.docs.find((d) => d.get('deletedAt') == null);
  if (live) return live.id;
  try {
    return (await auth().getUserByEmail(email)).uid;
  } catch {
    return null;
  }
}

/** 'asha@acme.com' → 'a***@acme.com' — enough to tell which account to switch to. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * The invitation e-mail. The sender is always ours; the inviter is named by
 * their VERIFIED sign-in address — never a free-text sender (open sign-up
 * means anyone could otherwise send mail through us as anybody).
 */
export async function sendInviteEmail(
  inv: Invite,
  inviteId: string,
  token: string,
  inviterEmail: string | null | undefined,
): Promise<void> {
  const link = `${appUrl()}/invite/${inviteId}.${token}`;
  const by = inviterEmail ? `${inv.invitedByName} (${inviterEmail})` : inv.invitedByName;
  const lines = [
    `${by} invited you to the board “${inv.boardName}” (${inv.boardKey}) as ${ROLE_WORDS[inv.role]}.`,
    ...(inv.message ? ['', `“${inv.message}”`] : []),
    '',
    `Join: ${link}`,
    '',
    `Sign in with ${inv.email} to accept — the invite only works for that address.`,
    `It expires in ${Math.round(INVITE_TTL_MS / 86_400_000)} days.`,
  ];
  try {
    await ports().email.send({
      to: inv.email,
      subject: `${inv.invitedByName} invited you to ${inv.boardName}`,
      text: lines.join('\n'),
      tag: 'invite',
      headers: { 'X-TM-Invite': inviteId },
    });
  } catch (e) {
    // The invite exists either way; 'Resend' (inviteRevoke resend) retries the mail.
    console.warn(`[invite] mail for ${inviteId} failed`, e);
  }
}

/**
 * Every live invite for this (verified) address → an 'invited' inbox row.
 * create() only: a row that already exists (read, archived) is left alone, so
 * this is safe on every sign-in. Returns how many rows were created.
 */
export async function attachInvitesToInbox(
  uid: string,
  email: string,
  now: number,
): Promise<number> {
  const snap = await db()
    .collection(paths.invites())
    .where('email', '==', email.toLowerCase())
    .where('status', '==', 'pending')
    .get();
  let n = 0;
  for (const d of snap.docs) {
    const inv = d.data() as Invite;
    if (!isLive(inv, now)) continue;
    try {
      await inviteInboxRef(uid, d.id).create(inviteInboxItem(inv, d.id, 'app', now));
      n++;
    } catch (e) {
      if ((e as { code?: number }).code !== 6) throw e; // 6 = ALREADY_EXISTS
    }
  }
  return n;
}
