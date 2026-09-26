/**
 * Phase 3 — answering a question (docs/plan/agents.html §L1).
 *
 * The form card, the questionAnswer command and the REST / MCP doors all judge
 * a submission with THIS function, so the browser can disable Submit for the
 * same reason the server would answer 422.
 */
import {
  answerValueIssue,
  isEmptyAnswer,
  questionAddresses,
  questionIsOpen,
  QUESTION_COMMENT_MAX,
  type Question,
  type QuestionField,
  type QuestionValue,
} from '../schema/question.js';
import type { CanBoard, CanCtx } from './can.js';
import { can } from './can.js';

export interface AnswerIssue {
  /** The field it is about; null for whole-form problems (unknown field, comment). */
  fieldId: string | null;
  message: string;
}

export interface AnswerCheck {
  ok: boolean;
  issues: AnswerIssue[];
  /** The values to store: known fields only, blanks dropped, in field order. */
  values: Record<string, QuestionValue>;
}

/**
 * Check a submission against the question's fields:
 *   - every required field has a non-empty value
 *   - every value fits its field's type (option ids must exist, and so on)
 *   - no values for fields the question does not have
 *   - the comment only when allowComment is on, and within its limit
 * Values for optional fields left blank are dropped, so an answer never stores
 * '' or [].
 */
export function validateAnswer(
  question: Pick<Question, 'fields' | 'allowComment'>,
  submitted: Record<string, unknown>,
  comment?: string | null,
): AnswerCheck {
  const issues: AnswerIssue[] = [];
  const values: Record<string, QuestionValue> = {};
  const byId = new Map<string, QuestionField>(question.fields.map((f) => [f.id, f]));

  for (const field of question.fields) {
    const raw = submitted[field.id];
    if (isEmptyAnswer(raw)) {
      if (field.required)
        issues.push({ fieldId: field.id, message: `'${field.label}' is required` });
      continue;
    }
    const bad = answerValueIssue(field, raw);
    if (bad) issues.push({ fieldId: field.id, message: `'${field.label}' ${bad}` });
    else values[field.id] = raw as QuestionValue;
  }

  for (const id of Object.keys(submitted)) {
    if (!byId.has(id)) issues.push({ fieldId: null, message: `Unknown field '${id}'` });
  }

  if (comment != null && comment !== '') {
    if (!question.allowComment)
      issues.push({ fieldId: null, message: 'This question takes no comment' });
    else if (comment.length > QUESTION_COMMENT_MAX) {
      issues.push({
        fieldId: null,
        message: `A comment is at most ${QUESTION_COMMENT_MAX} characters`,
      });
    }
  }

  return { ok: issues.length === 0, issues, values };
}

/** The values a fresh form starts with (the fields' `default`s). */
export function answerDefaults(question: Pick<Question, 'fields'>): Record<string, QuestionValue> {
  const out: Record<string, QuestionValue> = {};
  for (const f of question.fields) if (f.default !== undefined) out[f.id] = f.default;
  return out;
}

/**
 * May this principal answer this question (§L1)?
 *   can(answer) — commenter or above, with the questions:write scope for a token
 *   ∩ `to`, when the question names who should answer
 *   ∩ the question is still open at `now`.
 * The asker's own token can never answer: an agent asks, a person answers.
 */
export function canAnswerQuestion(
  ctx: CanCtx,
  board: CanBoard,
  question: Pick<Question, 'to' | 'status' | 'expiresAt'>,
  now: number,
): boolean {
  if (!questionIsOpen(question, now)) return false;
  if (!questionAddresses(question, ctx.actor)) return false;
  return can(ctx, board, 'answer');
}
