/**
 * emailInbound — POST /hooks/email (platform/backend.json services.emailInbound).
 *
 *   to = t.{token}@in…   → a REPLY:
 *        thread = emailThreads/{token} (unexpired); From must be the address
 *        of the person the mail was SENT to; the board must accept replies;
 *        quoted history and signature stripped;
 *        messagePost(ctx{ actor: uid, via: 'email' }, Markdown → doc)
 *   to = {intake}@in…    → a NEW TICKET (email-to-board):
 *        intakes where email == to, enabled;
 *        ticketCreate(ctx{ actor: 'intake-bot', via: 'email' }) with the
 *        intake's defaults, subject → title, body → description
 *   attachments → Storage under the ticket's prefix, passed as paths
 *   anything else → dropped, logged (still 200: a provider must not retry it)
 *
 * The body is never logged. Retries are harmless: the command's clientId is
 * derived from the Message-ID.
 */
import {
  INTAKE_ACTOR,
  isAppError,
  paths,
  storage,
  type EmailThread,
  type Intake,
} from '@tm/shared';
import { docFromText, markdownToDoc } from '@tm/shared/logic/richtext/index';
import { ports } from '../adapters/index.js';
import { getDoc, typedCol, typedDoc } from '../runtime/index.js';
import { inboundDomain } from './config.js';
import { invokeCommand } from './commands.js';
import {
  clientIdFrom,
  htmlToText,
  parseAddress,
  parseAddressList,
  safeFileName,
  stripQuoted,
} from './inbound.js';
import { parseReplyAddress } from './tokens.js';

/** The actor ticketCreate sees for intake-created tickets (the shared contract). */
export { INTAKE_ACTOR };
const MAX_INBOUND_ATTACHMENTS = 10;
const MAX_INBOUND_BYTES = 10 * 1024 * 1024;

export interface InboundAttachment {
  filename: string;
  contentType: string;
  /** base64 */
  content: string;
}

export interface InboundEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  messageId: string | null;
  attachments: InboundAttachment[];
}

export type InboundOutcome =
  | { kind: 'reply'; ticketId: string; messageId?: string }
  | { kind: 'ticket'; ticketId: string; key?: string }
  | { kind: 'dropped'; reason: string };

/**
 * Normalise a provider payload. Accepts Resend's `{ type: 'email.received',
 * data: {...} }` and a flat parse ({ from, to, subject, text, html, headers,
 * attachments }) — the fields every inbound-parse provider sends.
 */
export function parseInbound(payload: unknown): InboundEmail | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const d = (p.data && typeof p.data === 'object' ? p.data : p) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const to = parseAddressList(d.to).map((a) => a.email);
  const from =
    str(d.from) ||
    (d.from && typeof d.from === 'object' ? str((d.from as { email?: unknown }).email) : '');
  if (!from || to.length === 0) return null;
  const headers = (d.headers && typeof d.headers === 'object' ? d.headers : {}) as Record<
    string,
    unknown
  >;
  const headerOf = (name: string) =>
    Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
  const messageId = str(d.message_id) || str(d.messageId) || str(headerOf('message-id')) || null;
  const attachments = (Array.isArray(d.attachments) ? d.attachments : [])
    .map((a) => a as Record<string, unknown>)
    .filter((a) => typeof a.content === 'string' && a.content)
    .map((a) => ({
      filename: str(a.filename) || str(a.name) || 'attachment',
      contentType: str(a.content_type) || str(a.contentType) || 'application/octet-stream',
      content: a.content as string,
    }));
  return {
    from,
    to,
    subject: str(d.subject),
    text: str(d.text),
    html: str(d.html),
    messageId,
    attachments,
  };
}

export async function handleInboundEmail(mail: InboundEmail): Promise<InboundOutcome> {
  const now = ports().clock.now();
  const sender = parseAddress(mail.from);
  if (!sender) return drop('unparseable From');
  const domain = `@${inboundDomain().toLowerCase()}`;
  const ours = mail.to.map((a) => a.toLowerCase()).filter((a) => a.endsWith(domain));

  for (const addr of ours) {
    const token = parseReplyAddress(addr);
    if (token) return reply(token, sender, mail, now);
  }
  for (const addr of ours) {
    const intakes = await typedCol('intakes', paths.intakes())
      .where('email', '==', addr)
      .limit(1)
      .get();
    const hit = intakes.docs[0];
    if (hit) return intake(hit.id, hit.data(), sender, mail, now);
  }
  return drop('no known recipient');
}

function drop(reason: string): InboundOutcome {
  console.info(`[emailInbound] dropped: ${reason}`);
  return { kind: 'dropped', reason };
}

function bodyText(mail: InboundEmail): string {
  return stripQuoted(mail.text || htmlToText(mail.html));
}

async function reply(
  token: string,
  sender: { email: string },
  mail: InboundEmail,
  now: number,
): Promise<InboundOutcome> {
  const thread: EmailThread | undefined = await getDoc(
    typedDoc('emailThreads', paths.emailThread(token)),
  );
  if (!thread || thread.expiresAt < now) return drop('unknown or expired thread');
  const user = await getDoc(typedDoc('users', paths.user(thread.uid)));
  // Attributed to the person the mail was sent to — and only if they sent it.
  if (!user || user.deletedAt || !user.email || user.email.toLowerCase() !== sender.email) {
    return drop('sender does not own this thread');
  }
  const board = await getDoc(typedDoc('boards', paths.board(thread.boardId)));
  if (!board || !board.settings.emailReplies) return drop('board does not accept email replies');

  const text = bodyText(mail);
  if (!text && mail.attachments.length === 0) return drop('empty reply');
  const people = await boardEmails(thread.boardId);
  const body = text
    ? markdownToDoc(text, { uidForEmail: (e) => people.get(e) })
    : docFromText('(attachment)');
  const attachments = await storeAttachments(thread.boardId, thread.ticketId, mail);
  try {
    const res = (await invokeCommand(
      'messagePost',
      {
        boardId: thread.boardId,
        ticketId: thread.ticketId,
        body,
        ...(attachments.length ? { attachments } : {}),
        clientId: clientIdFrom('em', mail.messageId ?? `${token}:${text}`),
      },
      { actor: thread.uid, via: 'email', email: user.email, emailVerified: true, now },
    )) as { messageId?: string } | undefined;
    return {
      kind: 'reply',
      ticketId: thread.ticketId,
      ...(res?.messageId ? { messageId: res.messageId } : {}),
    };
  } catch (e) {
    if (isAppError(e)) return drop(`messagePost refused: ${e.code}`);
    throw e;
  }
}

async function intake(
  slug: string,
  it: Intake,
  sender: { name: string | null; email: string },
  mail: InboundEmail,
  now: number,
): Promise<InboundOutcome> {
  if (!it.enabled) return drop(`intake ${slug} disabled`);
  const ticketId = typedCol('tickets', paths.tickets(it.boardId)).doc().id;
  const text = bodyText(mail);
  const from = sender.name ? `${sender.name} <${sender.email}>` : sender.email;
  // The sender is stored as the ticket's reporter AND leads the description (the drawer shows the description).
  const description = markdownToDoc(`From: ${from}${text ? `\n\n${text}` : ''}`);
  const attachments = await storeAttachments(it.boardId, ticketId, mail);
  const d = it.defaults;
  try {
    const res = (await invokeCommand(
      'ticketCreate',
      {
        boardId: it.boardId,
        ticketId,
        title: (mail.subject.trim() || `Email from ${from}`).slice(0, 500),
        description,
        ...(d.stageId ? { stageId: d.stageId } : {}),
        ...(d.priorityId ? { priorityId: d.priorityId } : {}),
        ...(d.tagIds?.length ? { tagIds: d.tagIds } : {}),
        ...(d.assigneeUids?.length ? { assigneeUids: d.assigneeUids } : {}),
        ...(attachments.length ? { attachments } : {}),
        reporter: {
          email: sender.email,
          ...(sender.name ? { name: sender.name.slice(0, 120) } : {}),
        },
        clientId: clientIdFrom(
          'ei',
          mail.messageId ?? `${slug}:${sender.email}:${mail.subject}:${text}`,
        ),
      },
      {
        actor: INTAKE_ACTOR,
        via: 'email',
        email: sender.email,
        emailVerified: false,
        // Narrowed to the intake's board (ticketCreate requires it for the intake actor).
        scopes: ['tickets:create'],
        boardIds: [it.boardId],
        now,
      },
    )) as { ticketId?: string; key?: string } | undefined;
    return {
      kind: 'ticket',
      ticketId: res?.ticketId ?? ticketId,
      ...(res?.key ? { key: res.key } : {}),
    };
  } catch (e) {
    if (isAppError(e)) return drop(`ticketCreate refused: ${e.code}`);
    throw e;
  }
}

/** Lower-cased email → uid, for the people on this board (mentions by '@email'). */
async function boardEmails(boardId: string): Promise<Map<string, string>> {
  const s = await typedCol('members', paths.members(boardId)).get();
  return new Map(s.docs.map((d) => [d.data().email.toLowerCase(), d.data().uid]));
}

async function storeAttachments(
  boardId: string,
  ticketId: string,
  mail: InboundEmail,
): Promise<string[]> {
  const out: string[] = [];
  let total = 0;
  for (const a of mail.attachments.slice(0, MAX_INBOUND_ATTACHMENTS)) {
    const bytes = Buffer.from(a.content, 'base64');
    total += bytes.length;
    if (total > MAX_INBOUND_BYTES) break;
    const path = storage.attachment(boardId, ticketId, ports().ids.id(), safeFileName(a.filename));
    await ports().files.write(path, new Uint8Array(bytes), a.contentType);
    out.push(path);
  }
  return out;
}
