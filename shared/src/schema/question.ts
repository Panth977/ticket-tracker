/**
 * Phase 3 — QUESTIONS WITH OPTIONS (docs/plan/agents.html §L1).
 *
 * An agent asks a question; it appears in the thread as a form card
 * (a message with kind 'question', payload in Message.question) and a person
 * submits the answer. The answer comes back to the agent as structured data
 * (agent inbox event 'question_answered', GET /v1/questions/{id}).
 *
 * The question LIVES ON ITS MESSAGE: one document, one thread position, one
 * read for the UI. `questionId()` is how the API names it from outside, since
 * REST addresses questions without a ticket in the path.
 */
import { z } from 'zod';
import {
  LocalIdSchema,
  MillisSchema,
  PrincipalIdSchema,
  RichTextSchema,
  TicketIdSchema,
  UidSchema,
} from '../types/index.js';

export const QUESTION_TITLE_MAX = 300;
export const QUESTION_LABEL_MAX = 200;
export const QUESTION_PLACEHOLDER_MAX = 120;
export const QUESTION_OPTION_LABEL_MAX = 120;
export const QUESTION_OPTION_DESCRIPTION_MAX = 300;
export const QUESTION_COMMENT_MAX = 2000;
/** 1–10 fields per question (§L1). */
export const MAX_QUESTION_FIELDS = 10;
export const MAX_QUESTION_OPTIONS = 20;
/** Longest answer a text / longText field accepts. */
export const QUESTION_TEXT_MAX = 2000;
export const QUESTION_LONG_TEXT_MAX = 20_000;

/**
 * What a field asks for:
 *   single    one option id      (radio buttons)
 *   multi     option ids         (checkboxes)
 *   text      one line
 *   longText  a paragraph
 *   number    a number
 *   boolean   yes / no
 *   date      a day or instant, epoch millis like every other date here
 */
export const QUESTION_FIELD_TYPES = [
  'single',
  'multi',
  'text',
  'longText',
  'number',
  'boolean',
  'date',
] as const;
export const QuestionFieldTypeSchema = z.enum(QUESTION_FIELD_TYPES);
export type QuestionFieldType = z.infer<typeof QuestionFieldTypeSchema>;

/** Types that are answered by picking from `options`. */
export const OPTION_FIELD_TYPES = [
  'single',
  'multi',
] as const satisfies readonly QuestionFieldType[];
export const isOptionField = (type: QuestionFieldType): boolean =>
  (OPTION_FIELD_TYPES as readonly QuestionFieldType[]).includes(type);

export const QuestionOptionSchema = z.object({
  id: LocalIdSchema,
  label: z.string().trim().min(1).max(QUESTION_OPTION_LABEL_MAX),
  /** One line under the label ('costs one extra query per row'). */
  description: z.string().trim().max(QUESTION_OPTION_DESCRIPTION_MAX).optional(),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

/**
 * One answer value. Which shape is legal depends on the field's type —
 * `validateAnswer` (logic/question.ts) is the authority; this schema only says
 * what JSON may be stored at all.
 *   single → option id, multi → option ids, text/longText → string,
 *   number → number, boolean → boolean, date → Millis.
 */
export const QuestionValueSchema = z.union([
  z.string().max(QUESTION_LONG_TEXT_MAX),
  z.number(),
  z.boolean(),
  z.array(LocalIdSchema).max(MAX_QUESTION_OPTIONS),
]);
export type QuestionValue = z.infer<typeof QuestionValueSchema>;

/** The shape of one form row. Cross-field rules live in `questionFieldIssue`. */
const QuestionFieldObject = z.object({
  id: LocalIdSchema,
  label: z.string().trim().min(1).max(QUESTION_LABEL_MAX),
  type: QuestionFieldTypeSchema,
  /** single / multi only, 1–20 choices. */
  options: z.array(QuestionOptionSchema).min(1).max(MAX_QUESTION_OPTIONS).optional(),
  /** Absent = optional. An open question with a required field cannot be submitted empty. */
  required: z.boolean().optional(),
  /** Pre-filled value; must itself be a legal answer for the field. */
  default: QuestionValueSchema.optional(),
  /** text / longText / number only. */
  placeholder: z.string().max(QUESTION_PLACEHOLDER_MAX).optional(),
});

/**
 * Why this field definition is impossible, or null when it is fine. Kept
 * separate from the schema so the asking command, the UI form builder and the
 * tests can all explain the same failure.
 */
export function questionFieldIssue(field: z.infer<typeof QuestionFieldObject>): string | null {
  const opts = field.options;
  if (isOptionField(field.type)) {
    if (!opts?.length) return `Field '${field.id}': ${field.type} needs options`;
    const ids = new Set(opts.map((o) => o.id));
    if (ids.size !== opts.length) return `Field '${field.id}': duplicate option ids`;
  } else if (opts) {
    return `Field '${field.id}': options are only for single / multi`;
  }
  if (field.default !== undefined) {
    const bad = answerValueIssue(field as QuestionField, field.default);
    if (bad) return `Field '${field.id}': default ${bad}`;
  }
  return null;
}

export const QuestionFieldSchema = QuestionFieldObject.superRefine((f, ctx) => {
  const issue = questionFieldIssue(f);
  if (issue) ctx.addIssue({ code: 'custom', message: issue });
});
export type QuestionField = z.infer<typeof QuestionFieldObject>;

/**
 * A submitted answer. `by` is a PERSON: agents ask, people answer (§L1 — 'a
 * person with commenter rights or above can answer').
 */
export const QuestionAnswerSchema = z.object({
  /** fieldId → value. Every required field is present; see validateAnswer. */
  values: z.record(LocalIdSchema, QuestionValueSchema),
  /** The free-text box, when allowComment is on. */
  comment: z.string().max(QUESTION_COMMENT_MAX).optional(),
  by: UidSchema,
  at: MillisSchema,
});
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

export const QUESTION_STATUSES = ['open', 'answered', 'cancelled', 'expired'] as const;
export const QuestionStatusSchema = z.enum(QUESTION_STATUSES);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

/**
 * Message.question — the form card itself. The asker, the ticket and the time
 * come from the message it hangs on (authorUid / path / createdAt).
 */
export const QuestionSchema = z.object({
  title: z.string().trim().min(1).max(QUESTION_TITLE_MAX),
  /** Optional context, rendered like a message body. */
  body: RichTextSchema.nullable(),
  fields: z.array(QuestionFieldSchema).min(1).max(MAX_QUESTION_FIELDS),
  /** Adds the 'Anything else?' box to the card. */
  allowComment: z.boolean(),
  /** Who should answer; null = any person on the board who may comment. */
  to: z.array(PrincipalIdSchema).max(50).nullable(),
  /** true: the ticket shows 'Waiting for your answer' and the card gets the ❓ badge. */
  blocking: z.boolean(),
  status: QuestionStatusSchema,
  expiresAt: MillisSchema.nullable(),
  answer: QuestionAnswerSchema.nullable(),
  /** Set when the asker cancelled it (status 'cancelled'). */
  cancelledAt: MillisSchema.nullable().optional(),
});
export type Question = z.infer<typeof QuestionSchema>;

/**
 * A question as commands and the API handle it: the payload plus where it
 * lives. `askedBy` is the message author (the agent).
 */
export interface QuestionWithId extends Question {
  id: string;
  boardId: string;
  ticketId: string;
  messageId: string;
  askedBy: string | null;
  askedAt: number;
}

/**
 * The id the API names a question by (REST GET /v1/questions/{id}, MCP
 * get_question): '{ticketId}.{messageId}'. The board comes from the
 * credential, so this is everything a door needs to find the document without
 * a collection-group scan.
 */
export function questionId(ticketId: string, messageId: string): string {
  if (ticketId.includes('.') || messageId.includes('.'))
    throw new Error('questionId: ids may not contain "."');
  return `${ticketId}.${messageId}`;
}

/** The inverse of questionId(); null when the id is not one. */
export function parseQuestionId(id: string): { ticketId: string; messageId: string } | null {
  const m = /^([^.]+)\.([^.]+)$/.exec(id);
  return m && TicketIdSchema.safeParse(m[1]).success ? { ticketId: m[1]!, messageId: m[2]! } : null;
}

/**
 * The status to SHOW: a question whose expiry has passed reads as 'expired'
 * even before a sweep writes it ('the card locks as Expired'). Stored answers
 * and cancellations always win — a question answered before it expired stays
 * answered.
 */
export function questionStatus(
  q: Pick<Question, 'status' | 'expiresAt'>,
  now: number,
): QuestionStatus {
  if (q.status !== 'open') return q.status;
  return q.expiresAt !== null && q.expiresAt <= now ? 'expired' : 'open';
}

/** Can this question still be answered at `now`? */
export const questionIsOpen = (q: Pick<Question, 'status' | 'expiresAt'>, now: number): boolean =>
  questionStatus(q, now) === 'open';

/** Does the question restrict who may answer, and is this principal one of them? */
export function questionAddresses(q: Pick<Question, 'to'>, principalId: string): boolean {
  return q.to === null || q.to.length === 0 || q.to.includes(principalId);
}

/**
 * Is `value` a legal answer for this field? Returns the reason it is not, in
 * words a form can show ("must be one of the options"), or null when it fits.
 * Empty answers are the caller's business (see `isEmptyAnswer` / validateAnswer):
 * this only judges the SHAPE.
 */
export function answerValueIssue(
  field: Pick<QuestionField, 'type' | 'options'>,
  value: unknown,
): string | null {
  const ids = new Set((field.options ?? []).map((o) => o.id));
  switch (field.type) {
    case 'single':
      if (typeof value !== 'string') return 'must be an option id';
      return ids.has(value) ? null : 'must be one of the options';
    case 'multi': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
        return 'must be a list of option ids';
      if (value.length > MAX_QUESTION_OPTIONS) return `at most ${MAX_QUESTION_OPTIONS} options`;
      if (new Set(value).size !== value.length) return 'lists the same option twice';
      const bad = (value as string[]).find((v) => !ids.has(v));
      return bad === undefined ? null : `'${bad}' is not one of the options`;
    }
    case 'text':
      if (typeof value !== 'string') return 'must be text';
      return value.length <= QUESTION_TEXT_MAX ? null : `at most ${QUESTION_TEXT_MAX} characters`;
    case 'longText':
      if (typeof value !== 'string') return 'must be text';
      return value.length <= QUESTION_LONG_TEXT_MAX
        ? null
        : `at most ${QUESTION_LONG_TEXT_MAX} characters`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'date':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? null
        : 'must be a date (epoch millis)';
  }
}

/**
 * An answer a person left blank: absent, null, '' or []. A required field
 * rejects these; an optional one simply carries nothing.
 */
export function isEmptyAnswer(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}
