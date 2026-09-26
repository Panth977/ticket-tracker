/**
 * whatsappInbound — POST /hooks/whatsapp (platform/backend.json services.whatsappInbound).
 * Meta Cloud API webhook: entry[].changes[].value.{ statuses[], messages[] }.
 *
 *   statuses → deliveries status (delivered / read / failed), never downgraded
 *   messages → session = whatsappSessions/{+from}; lastInboundAt = now (opens
 *              Meta's 24h window for free-form replies)
 *     'STOP'              → optIn = false (confirmed in one last message)
 *     button 'Mark done'  → ticketUpdate(stage → the board's first 'done' stage)
 *     button 'Snooze 1d'  → the ticket's inbox rows snoozedUntil = now + 1 day
 *     text                → messagePost on the ticket, via 'whatsapp'
 *     no ticket to refer to → reply with the last 3 notified tickets
 *
 * Which ticket? The message Meta says this one replies to (context.id → our
 * delivery → its inbox row), else the session's contextTicketId (the last one
 * we told them about), while it has not expired.
 */
import { isAppError, paths, type Delivery, type InboxItem, type WhatsappSession } from '@tm/shared';
import { markdownToDoc } from '@tm/shared/logic/richtext/index';
import { ports } from '../adapters/index.js';
import { getDoc, typedCol, typedDoc } from '../runtime/index.js';
import { invokeCommand } from './commands.js';
import { clientIdFrom } from './inbound.js';
import { itemUrl } from './deliver.js';

const DAY = 24 * 60 * 60 * 1000;

export interface WaStatus {
  id: string;
  status: string;
  errors?: { title?: string; message?: string; code?: number }[];
}
export interface WaMessage {
  id: string;
  from: string;
  type: string;
  text?: { body?: string };
  button?: { text?: string; payload?: string };
  interactive?: { button_reply?: { id?: string; title?: string } };
  context?: { id?: string };
}

export type WaOutcome =
  | { kind: 'status'; id: string; status: string; updated: number }
  | { kind: 'stop'; uid: string }
  | { kind: 'done' | 'snooze' | 'comment'; uid: string; ticketId: string }
  | { kind: 'list'; uid: string }
  | { kind: 'ignored'; reason: string };

/** Pull statuses and messages out of Meta's envelope. */
export function parseWebhook(payload: unknown): { statuses: WaStatus[]; messages: WaMessage[] } {
  const out = { statuses: [] as WaStatus[], messages: [] as WaMessage[] };
  const entries = (payload as { entry?: unknown })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const e of entries) {
    const changes = (e as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const ch of changes) {
      const v = (ch as { value?: { statuses?: unknown; messages?: unknown } })?.value;
      if (Array.isArray(v?.statuses))
        out.statuses.push(...(v.statuses as WaStatus[]).filter((s) => s?.id && s?.status));
      if (Array.isArray(v?.messages))
        out.messages.push(...(v.messages as WaMessage[]).filter((m) => m?.id && m?.from));
    }
  }
  return out;
}

export async function handleWhatsappWebhook(payload: unknown): Promise<WaOutcome[]> {
  const { statuses, messages } = parseWebhook(payload);
  const out: WaOutcome[] = [];
  for (const s of statuses) out.push(await applyStatus(s));
  for (const m of messages) {
    try {
      out.push(await handleMessage(m));
    } catch (e) {
      console.error('[whatsappInbound] message failed', e);
      out.push({ kind: 'ignored', reason: 'error' });
    }
  }
  return out;
}

// ─── statuses ────────────────────────────────────────────────────────────────

const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };

async function applyStatus(s: WaStatus): Promise<WaOutcome> {
  const next =
    s.status === 'failed'
      ? 'failed'
      : s.status in STATUS_RANK
        ? (s.status as Delivery['status'])
        : null;
  if (!next) return { kind: 'ignored', reason: `status ${s.status}` };
  const snap = await typedCol('deliveries', paths.deliveries())
    .where('providerId', '==', s.id)
    .get();
  let updated = 0;
  for (const d of snap.docs) {
    const cur = d.data();
    if (cur.provider !== 'meta') continue;
    if (next !== 'failed' && (STATUS_RANK[cur.status] ?? -1) >= STATUS_RANK[next]!) continue;
    const err = s.errors?.[0];
    await d.ref.update({
      status: next,
      ...(next === 'failed' ? { error: err?.title ?? err?.message ?? 'failed' } : {}),
    });
    updated++;
  }
  return { kind: 'status', id: s.id, status: next, updated };
}

// ─── messages ────────────────────────────────────────────────────────────────

const e164 = (from: string) => (from.startsWith('+') ? from : `+${from}`);

function actionOf(m: WaMessage): { kind: 'done' | 'snooze' | 'stop' | 'text'; text: string } {
  const label =
    m.button?.payload ??
    m.button?.text ??
    m.interactive?.button_reply?.id ??
    m.interactive?.button_reply?.title;
  if (label) {
    if (/done/i.test(label)) return { kind: 'done', text: label };
    if (/snooze/i.test(label)) return { kind: 'snooze', text: label };
  }
  const text = (m.text?.body ?? label ?? '').trim();
  if (/^(stop|unsubscribe)$/i.test(text)) return { kind: 'stop', text };
  return { kind: 'text', text };
}

async function handleMessage(m: WaMessage): Promise<WaOutcome> {
  const now = ports().clock.now();
  const number = e164(m.from);
  const sessionRef = typedDoc('whatsappSessions', paths.whatsappSession(number));
  const session = await getDoc(sessionRef);
  if (!session) return { kind: 'ignored', reason: 'unknown number' };
  const user = await getDoc(typedDoc('users', paths.user(session.uid)));
  // The number must still be linked to that person.
  if (!user || user.deletedAt || user.whatsapp?.number !== number)
    return { kind: 'ignored', reason: 'number not linked' };
  await sessionRef.update({ lastInboundAt: now });

  const action = actionOf(m);
  const reply = (text: string) => ports().whatsapp.sendText(number, text);

  if (action.kind === 'stop') {
    await typedDoc('users', paths.user(session.uid)).update({ 'whatsapp.optIn': false });
    await reply(
      "You won't get TaskManager messages here any more. Turn them back on in Account › Channels.",
    );
    return { kind: 'stop', uid: session.uid };
  }

  const target = await ticketFor(m, session, now);
  if (!target) {
    await reply(await recentList(session.uid));
    return { kind: 'list', uid: session.uid };
  }
  const base = {
    actor: session.uid,
    via: 'whatsapp' as const,
    email: user.email,
    emailVerified: true,
    now,
  };
  const label = target.ticketKey ?? 'the ticket';

  try {
    if (action.kind === 'done') {
      const board = await getDoc(typedDoc('boards', paths.board(target.boardId)));
      const stage = board?.stages
        .filter((s) => s.category === 'done')
        .sort((a, b) => a.position - b.position)[0];
      if (!stage) {
        await reply(`${label} has no Done stage to move to.`);
        return { kind: 'ignored', reason: 'no done stage' };
      }
      await invokeCommand(
        'ticketUpdate',
        {
          boardId: target.boardId,
          ticketId: target.ticketId,
          patch: { stageId: stage.id },
          clientId: clientIdFrom('wa', m.id),
        },
        base,
      );
      await reply(`Done: ${label} moved to ${stage.name}.`);
      return { kind: 'done', uid: session.uid, ticketId: target.ticketId };
    }
    if (action.kind === 'snooze') {
      const rows = await typedCol('inbox', paths.inbox(session.uid))
        .where('ticketId', '==', target.ticketId)
        .get();
      await Promise.all(rows.docs.map((r) => r.ref.update({ snoozedUntil: now + DAY })));
      await reply(`Snoozed ${label} until tomorrow.`);
      return { kind: 'snooze', uid: session.uid, ticketId: target.ticketId };
    }
    if (!action.text) return { kind: 'ignored', reason: 'empty message' };
    await invokeCommand(
      'messagePost',
      {
        boardId: target.boardId,
        ticketId: target.ticketId,
        body: markdownToDoc(action.text),
        clientId: clientIdFrom('wa', m.id),
      },
      base,
    );
    return { kind: 'comment', uid: session.uid, ticketId: target.ticketId };
  } catch (e) {
    if (!isAppError(e)) throw e;
    await reply(`Couldn't update ${label}: ${e.message}`);
    return { kind: 'ignored', reason: `command refused: ${e.code}` };
  }
}

interface Target {
  boardId: string;
  ticketId: string;
  ticketKey: string | null;
}

async function ticketFor(
  m: WaMessage,
  session: WhatsappSession,
  now: number,
): Promise<Target | null> {
  // 1. A reply to one of our messages names it exactly.
  if (m.context?.id) {
    const d = await typedCol('deliveries', paths.deliveries())
      .where('providerId', '==', m.context.id)
      .limit(1)
      .get();
    const del = d.docs[0]?.data();
    if (del && del.uid === session.uid && del.inboxIds[0]) {
      const row = await getDoc(typedDoc('inbox', paths.inboxItem(session.uid, del.inboxIds[0])));
      if (row?.ticketId)
        return { boardId: row.boardId, ticketId: row.ticketId, ticketKey: row.ticketKey };
    }
  }
  // 2. The last ticket we told them about.
  if (session.contextTicketId && session.contextExpiresAt > now) {
    const rows = await typedCol('inbox', paths.inbox(session.uid))
      .where('ticketId', '==', session.contextTicketId)
      .limit(1)
      .get();
    const row = rows.docs[0]?.data();
    if (row)
      return { boardId: row.boardId, ticketId: session.contextTicketId, ticketKey: row.ticketKey };
  }
  return null;
}

async function recentList(uid: string): Promise<string> {
  const s = await typedCol('inbox', paths.inbox(uid)).orderBy('createdAt', 'desc').limit(20).get();
  const seen = new Set<string>();
  const rows: InboxItem[] = [];
  for (const d of s.docs) {
    const r = d.data();
    if (!r.ticketId || seen.has(r.ticketId)) continue;
    seen.add(r.ticketId);
    rows.push(r);
    if (rows.length === 3) break;
  }
  if (rows.length === 0)
    return 'Nothing to reply to yet — you will hear from us when something needs you.';
  return [
    'Which ticket is this about? Reply to one of our messages about it, or open it:',
    ...rows.map((r) =>
      `• ${r.ticketKey ?? ''} ${r.ticketTitle ?? ''} ${itemUrl({ ticketKey: r.ticketKey })}`
        .replace(/\s+/g, ' ')
        .trim(),
    ),
  ].join('\n');
}
