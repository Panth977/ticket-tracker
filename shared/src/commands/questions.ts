/**
 * Phase 3 — QUESTIONS (docs/plan/agents.html §L1).
 *
 * questionAsk posts a message with kind 'question'; questionAnswer and
 * questionCancel rewrite that message's `question` field in place, so the card
 * locks where it already sits in the thread. The outbox treats Submit like any
 * other write, which is why questionAnswer takes a clientId.
 */
import { z } from 'zod';
import {
  MAX_QUESTION_FIELDS,
  QUESTION_COMMENT_MAX,
  QUESTION_TITLE_MAX,
  QuestionFieldSchema,
  QuestionValueSchema,
} from '../schema/question.js';
import {
  BoardIdSchema,
  LocalIdSchema,
  MillisSchema,
  PrincipalIdSchema,
  RichTextDocSchema,
  TicketIdSchema,
} from '../types/index.js';
import { defineCommand, OkResSchema, req } from './define.js';

const TicketRef = { boardId: BoardIdSchema, ticketId: TicketIdSchema };
/** The question's message id — the thread position the card lives at. */
const MessageId = z.string().min(1).max(128);

export const questionAsk = defineCommand({
  name: 'questionAsk',
  source: 'phase3',
  scopes: ['questions:write'],
  permission:
    "can(ask) = commenter+ (usually an agent's token). The ticket must be active (409), `to` must name principals on the board (400), and fields must be 1–10 with option lists on single / multi.",
  errors: ['forbidden', 'not_found', 'conflict', 'invalid', 'unprocessable'],
  req: req({
    ...TicketRef,
    title: z.string().trim().min(1).max(QUESTION_TITLE_MAX),
    /** Optional context, the same rich text a message body holds. */
    body: RichTextDocSchema.nullable().optional(),
    fields: z.array(QuestionFieldSchema).min(1).max(MAX_QUESTION_FIELDS),
    /** Adds the 'Anything else?' box. Default false. */
    allowComment: z.boolean().optional(),
    /** Who should answer; null / absent = any person on the board. */
    to: z.array(PrincipalIdSchema).max(50).nullable().optional(),
    /** Default true: the ticket shows 'Waiting for your answer'. */
    blocking: z.boolean().optional(),
    /** After this the card locks as 'Expired'. */
    expiresAt: MillisSchema.nullable().optional(),
  }),
  res: z.object({
    messageId: z.string(),
    /** questionId(ticketId, messageId) — how REST / MCP name it afterwards. */
    questionId: z.string(),
  }),
});

export const questionAnswer = defineCommand({
  name: 'questionAnswer',
  source: 'phase3',
  scopes: ['questions:write'],
  permission:
    "canAnswerQuestion(): commenter+, and in the question's `to` when it is set. The question must still be open (409 'answered' / 'cancelled' / 'expired'); values are checked against the fields (422 with the per-field issues). Answering also posts the answer as the person's reply bubble.",
  errors: ['forbidden', 'not_found', 'conflict', 'unprocessable'],
  req: req({
    ...TicketRef,
    messageId: MessageId,
    /** fieldId → value; every required field present, option ids from the field. */
    values: z.record(LocalIdSchema, QuestionValueSchema),
    /** Only when the question has allowComment. */
    comment: z.string().max(QUESTION_COMMENT_MAX).optional(),
  }),
  res: z.object({ ok: z.literal(true), answeredAt: MillisSchema }),
});

export const questionCancel = defineCommand({
  name: 'questionCancel',
  source: 'phase3',
  scopes: ['questions:write'],
  permission:
    'The asker (the message author — usually the agent, through its token) or a board admin. Open questions only; an answered one is 409. The card locks as cancelled and nobody is notified again.',
  errors: ['forbidden', 'not_found', 'conflict'],
  req: req({ ...TicketRef, messageId: MessageId }),
  res: OkResSchema,
});
