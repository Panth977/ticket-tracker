/**
 * Phase 3 — QUESTIONS WITH OPTIONS (docs/plan/agents.html §L1).
 *
 * A question IS a message: kind 'question' with the form in `Message.question`.
 * questionAsk creates it, questionAnswer / questionCancel rewrite that one
 * field in place, so the card locks exactly where it already sits in the
 * thread. This module holds what all three share:
 *
 *   waitingOn       the ticket-level summary a blocking open question drives
 *                   ('❓ Waiting for you' on the card, the drawer header and
 *                   My work). It lives on the TICKET so a board list needs no
 *                   second read per card.
 *   askedAgentOf    who to tell when the question is settled (the asker, when
 *                   it is an agent) — agent inbox question_answered / _cancelled
 *   answerBubble    the person's reply bubble that a submitted answer posts
 *   expireQuestions the sweep that locks questions whose expiresAt has passed
 */
import type { Query } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  isAgentId,
  parseTicketPath,
  paths,
  questionId,
  type Message,
  type PMNode,
  type AgentInboxEvent,
  type Question,
  type QuestionField,
  type QuestionValue,
  type RichText,
  type StoredMessage,
  type Ticket,
  type WaitingOn,
} from '@tm/shared';
import { derive } from '@tm/shared/logic/index';
import { typedDoc } from '../runtime/converters.js';
import { db } from '../runtime/firebase.js';
import { openTicket } from './doc.js';
import { questionMessages } from './read.js';
import { runTx, type Tx } from '../runtime/tx.js';
import { makeCtx } from '../runtime/context.js';

/**
 * The ticket-level summary of the blocking question(s) still open on a ticket.
 *
 * `Ticket.waitingOn` (and `Ticket.tasklistProgress`) are now part of
 * TicketSchema — the REQUEST this step filed for p3-contracts was resolved by
 * p3-integration — so the roll-up is an ordinary, validated ticket field and
 * `WaitingOn` is re-exported from @tm/shared rather than described twice.
 */
export type { WaitingOn };

export const waitingOnOf = (t: Ticket): WaitingOn | null => t.waitingOn ?? null;

/**
 * The summary row for one question message (§L1).
 *
 * Phase 15 (§W): there is no 'recompute from a query' any more — every
 * question is a row inside the ticket document, so TicketWriter derives
 * `waitingOn`, `signals.question` and `nextQuestionExpiresAt` from what it
 * already holds (tickets/doc.ts questionRollup) in the same write that changed
 * the question. An open question never spills out of the inline window, which
 * is what makes that derivation exact.
 */
export function waitingRow(messageId: string, m: Message): WaitingOn {
  const q = m.question!;
  return {
    count: 1,
    messageId,
    title: q.title,
    to: q.to ?? null,
    askedBy: m.authorUid,
    askedAt: m.createdAt,
    expiresAt: q.expiresAt,
  };
}

// ─── who hears about it ──────────────────────────────────────────────────────

/**
 * The agent to tell that its question was settled — the message's author when
 * that author is an agent and is not the one doing the settling. (An agent's
 * own actions never reach its own inbox, §D.)
 */
export function askedAgentOf(m: Message, actor: string): string | null {
  const a = m.authorUid;
  return a && isAgentId(a) && a !== actor ? a : null;
}

/** The `question` payload an agent inbox event carries (§L1). */
export function questionEventPayload(
  ticketId: string,
  messageId: string,
  q: Question,
): NonNullable<AgentInboxEvent['question']> {
  return {
    id: questionId(ticketId, messageId),
    title: q.title.slice(0, 500),
    status: q.status,
    ...(q.answer ? { values: q.answer.values, answeredBy: q.answer.by } : {}),
    ...(q.answer?.comment ? { comment: q.answer.comment } : {}),
  };
}

/**
 * Who a question notifies (§L1): the `to` people, or — when it names nobody —
 * the ticket's assignees and watchers. Agents never answer questions, so agent
 * ids are dropped; so is the asker.
 */
export function questionRecipients(
  q: Pick<Question, 'to'>,
  ticket: Pick<Ticket, 'assigneeUids' | 'watcherUids'>,
  actor: string,
): string[] {
  const base = q.to?.length ? q.to : [...ticket.assigneeUids, ...ticket.watcherUids];
  return [...new Set(base)].filter((id) => !isAgentId(id) && id !== actor);
}

// ─── rich text ───────────────────────────────────────────────────────────────

const para = (content: PMNode[]): PMNode => ({ type: 'paragraph', content });
const text = (s: string): PMNode => ({ type: 'text', text: s });

/** A RichText document from paragraphs, with `text` derived for search. */
export function richFromParagraphs(
  paragraphs: PMNode[],
  carry?: Pick<RichText, 'mentions' | 'refs'>,
): RichText {
  const doc = { type: 'doc' as const, content: paragraphs.length ? paragraphs : [para([])] };
  return {
    doc,
    text: derive(doc).text,
    mentions: carry?.mentions ?? [],
    refs: carry?.refs ?? [],
  };
}

/**
 * The question message's `body`: its title, then the asker's context. Search,
 * previews and the notification line all read `body.text`, so the title has to
 * be in there (§L1 — the card renders from `question`, not from this).
 */
export function questionBody(title: string, context: RichText | null): RichText {
  const rest = (context?.doc.content ?? []) as PMNode[];
  return richFromParagraphs([para([text(title)]), ...rest], context ?? undefined);
}

/** One answer value as a person reads it ('Postgres', 'Yes', '2 options'). */
export function renderValue(field: QuestionField, value: QuestionValue): string {
  const label = (id: string) => field.options?.find((o) => o.id === id)?.label ?? id;
  switch (field.type) {
    case 'single':
      return label(String(value));
    case 'multi':
      return (value as string[]).map(label).join(', ');
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'date':
      return new Date(Number(value)).toISOString().slice(0, 10);
    default:
      return String(value);
  }
}

/**
 * 'Answered: Database: Postgres' — the reply bubble a submitted answer posts
 * (§L1: 'the answer also appears as your reply bubble'). One paragraph per
 * field, then the free-text comment.
 */
export function answerBody(
  q: Pick<Question, 'fields'>,
  values: Record<string, QuestionValue>,
  comment?: string,
): RichText {
  const lines: PMNode[] = [];
  for (const f of q.fields) {
    const v = values[f.id];
    if (v === undefined) continue;
    lines.push(para([text(`${f.label}: ${renderValue(f, v)}`)]));
  }
  if (comment) lines.push(para([text(comment)]));
  if (!lines.length) lines.push(para([text('(no answer)')]));
  return richFromParagraphs(lines);
}

// ─── expiry ──────────────────────────────────────────────────────────────────

export interface ExpiredQuestion {
  boardId: string;
  ticketId: string;
  messageId: string;
  question: Question;
  askedBy: string | null;
  ticketKey: string;
}

/**
 * Lock every question whose `expiresAt` has passed (§L1: 'an expired one locks
 * as Expired'). The UI already READS an overdue question as expired
 * (questionStatus), so this only makes the stored status agree — and gives the
 * asking agent its question_cancelled event and clears `waitingOn`.
 *
 * Phase 15 (§W): the questions are rows inside their tickets, so the sweep
 * finds the TICKETS instead — `nextQuestionExpiresAt` is the earliest expiry
 * among a ticket's open questions and exists purely so this query is possible
 * (`> 0` excludes the nulls, which a range filter alone would not). One
 * transaction per ticket then locks every question of it that is due.
 *
 * Runs from the minute schedule (jobs/agentSilenceSweep.ts), which is the only
 * per-minute tick phase 3 has.
 */
export async function expireQuestions(now: number, limit = 200): Promise<ExpiredQuestion[]> {
  const q = db()
    .collectionGroup(COLLECTIONS.tickets)
    .where('nextQuestionExpiresAt', '>', 0)
    .where('nextQuestionExpiresAt', '<=', now)
    .limit(limit) as Query;
  const snap = await q.get();
  const out: ExpiredQuestion[] = [];

  for (const d of snap.docs) {
    const parsed = parseTicketPath(d.ref.path);
    if (!parsed) continue;
    const due = (m: StoredMessage) =>
      m.question?.status === 'open' && m.question.expiresAt !== null && m.question.expiresAt <= now;
    const locked = await runTx(async (tx) => {
      const w = await openTicket(
        tx,
        makeCtx({ actor: 'system', via: 'system', now }),
        parsed.boardId,
        parsed.ticketId,
      );
      const rows = questionMessages(w.before).filter(due);
      if (!rows.length) return [];
      for (const m of rows) {
        const found = await w.locate(m.id);
        if (!found) continue;
        w.patchMessage(found, { question: { ...m.question!, status: 'expired' } });
        w.dropCarry(m.id);
      }
      w.commit();
      return rows.map((m) => ({
        boardId: parsed.boardId,
        ticketId: parsed.ticketId,
        messageId: m.id,
        question: { ...m.question!, status: 'expired' as const },
        askedBy: m.authorUid,
        ticketKey: w.before.key,
      }));
    }).catch(() => [] as ExpiredQuestion[]);
    out.push(...locked);
  }
  return out;
}

// ─── thread bookkeeping ──────────────────────────────────────────────────────

/** 'Your own message is read' — agents never open the app, so they get no pointer. */
export function markRead(
  tx: Tx,
  actor: string,
  boardId: string,
  ticketId: string,
  now: number,
): void {
  if (isAgentId(actor)) return;
  tx.set(typedDoc('reads', paths.read(actor, ticketId)), { boardId, readAt: now, ticketId });
}
