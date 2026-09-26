/**
 * Phase 3 — THE QUESTION CARD's logic (docs/plan/agents.html §L1), with no
 * Svelte and no Firebase in it, so the form's rules are unit-tested.
 *
 * An agent asks; the thread shows a form card; a person fills it in and
 * submits. The browser judges a submission with the SAME `validateAnswer`
 * the server runs, so Submit is disabled for exactly the reason the command
 * would answer 422 — the card never lies about what will be accepted.
 */
import {
  answerDefaults,
  canAnswerQuestion,
  isEmptyAnswer,
  isQuestionMessage,
  questionStatus,
  validateAnswer,
  type AnswerCheck,
  type Message,
  type Question,
  type QuestionField,
  type QuestionStatus,
  type QuestionValue,
} from '@tm/shared';
import type { CanBoard, CanCtx } from '@tm/shared/logic/can';

/** What the form holds while it is being filled in: fieldId → raw value. */
export type FormValues = Record<string, unknown>;

/**
 * The values a fresh form starts with. Every field gets a key (so binding is
 * simple): its `default`, or the empty value for its type — '' for text,
 * [] for multi, null for the rest. `false` is a real answer for a boolean,
 * so an unanswered boolean starts as null, not false.
 */
export function blankForm(q: Pick<Question, 'fields'>): FormValues {
  const defaults = answerDefaults(q);
  const out: FormValues = {};
  for (const f of q.fields) out[f.id] = defaults[f.id] ?? emptyValue(f);
  return out;
}

function emptyValue(f: Pick<QuestionField, 'type'>): unknown {
  switch (f.type) {
    case 'multi':
      return [];
    case 'text':
    case 'longText':
      return '';
    default:
      return null;
  }
}

/**
 * The submission as the command wants it: blanks dropped, unknown fields
 * gone. `validateAnswer` already builds exactly that (its `values`), so the
 * form and the server agree on what was sent.
 */
export function checkForm(
  q: Pick<Question, 'fields' | 'allowComment'>,
  values: FormValues,
  comment: string,
): AnswerCheck {
  const trimmed = comment.trim();
  // Text fields keep their inner shape but lose surrounding whitespace, the
  // same way a person reading the answer would.
  const cleaned: FormValues = {};
  for (const f of q.fields) {
    const v = values[f.id];
    cleaned[f.id] = typeof v === 'string' ? v.trim() : v;
  }
  return validateAnswer(q, cleaned, trimmed || undefined);
}

/** The first issue about one field, for the message under it. */
export function fieldError(check: AnswerCheck, fieldId: string): string | null {
  return check.issues.find((i) => i.fieldId === fieldId)?.message ?? null;
}
/** Issues that belong to no field (the comment, an unknown field). */
export function formErrors(check: AnswerCheck): string[] {
  return check.issues.filter((i) => i.fieldId === null).map((i) => i.message);
}

/**
 * Has the person put anything in at all? An untouched optional form submits
 * nothing, which is legal but almost always a mis-click, so the card keeps
 * Submit disabled until something is answered (or a comment is written).
 */
export function isBlankForm(values: FormValues, comment: string): boolean {
  return comment.trim() === '' && Object.values(values).every((v) => isEmptyAnswer(v));
}

export interface AnswerAbility {
  /** Show the form (rather than a locked card). */
  can: boolean;
  /** Why not — one line under the card. null when `can`. */
  reason: string | null;
}

/**
 * May I answer, and if not, why? The three refusals the card can explain are
 * the three `canAnswerQuestion` folds in: the question is no longer open,
 * it names other people, or my role is too low.
 */
export function answerAbility(
  ctx: CanCtx,
  board: CanBoard,
  q: Pick<Question, 'to' | 'status' | 'expiresAt'>,
  now: number,
  nameOf: (principalId: string) => string,
): AnswerAbility {
  if (canAnswerQuestion(ctx, board, q, now)) return { can: true, reason: null };
  const status = questionStatus(q, now);
  if (status !== 'open') return { can: false, reason: null }; // the locked card says it itself
  const addressed = q.to === null || q.to.length === 0 || q.to.includes(ctx.actor);
  if (!addressed) return { can: false, reason: `Waiting for ${waitingFor(q.to ?? [], nameOf)}.` };
  return { can: false, reason: 'You need commenter rights on this board to answer.' };
}

/** 'Priya', 'Priya or Sam', 'Priya, Sam or 2 others' — who the card waits for. */
export function waitingFor(to: readonly string[], nameOf: (principalId: string) => string): string {
  const names = to.map(nameOf);
  if (names.length === 0) return 'anyone on the board';
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  const rest = names.length - 2;
  return `${names[0]}, ${names[1]} or ${rest} ${rest === 1 ? 'other' : 'others'}`;
}

/** The locked card's headline. */
export function statusLabel(status: QuestionStatus): string {
  switch (status) {
    case 'answered':
      return 'Answered';
    case 'cancelled':
      return 'Cancelled';
    case 'expired':
      return 'Expired';
    case 'open':
      return 'Waiting for an answer';
  }
}

/** One answered field as the locked card prints it: 'Database · Postgres'. */
export interface AnsweredLine {
  fieldId: string;
  label: string;
  text: string;
}

/** The chosen values, in the question's field order, as readable text. */
export function answeredLines(q: Pick<Question, 'fields' | 'answer'>, tz?: string): AnsweredLine[] {
  const values = q.answer?.values ?? {};
  const out: AnsweredLine[] = [];
  for (const f of q.fields) {
    const v = values[f.id];
    if (isEmptyAnswer(v)) continue;
    out.push({ fieldId: f.id, label: f.label, text: valueText(f, v as QuestionValue, tz) });
  }
  return out;
}

/** One value in words: option labels for single / multi, Yes / No, a date. */
export function valueText(
  f: Pick<QuestionField, 'type' | 'options'>,
  value: QuestionValue,
  tz?: string,
): string {
  const labelOf = (id: string) => f.options?.find((o) => o.id === id)?.label ?? id;
  switch (f.type) {
    case 'single':
      return labelOf(String(value));
    case 'multi':
      return Array.isArray(value) ? value.map((v) => labelOf(String(v))).join(', ') : String(value);
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'date':
      return typeof value === 'number'
        ? new Date(value).toLocaleString(undefined, { timeZone: tz, dateStyle: 'medium' })
        : String(value);
    default:
      return String(value);
  }
}

// ───────────────────────── waiting on ME (§L1 › Visibility) ─────────────────

/** A question message that still wants an answer, narrowed for the badge. */
export interface WaitingQuestion {
  messageId: string;
  title: string;
  /** null = anyone on the board. */
  to: string[] | null;
  blocking: boolean;
  expiresAt: number | null;
}

/**
 * The open questions on this ticket, and the ones addressed to me — what the
 * ❓ Waiting badge on the card, the drawer header and My work count.
 * `principalId` is me; a question with no `to` is addressed to everyone, so
 * it waits for me too (§L1: 'null = any person on the board').
 */
export function waitingQuestions(
  messages: readonly (Pick<Message, 'kind' | 'question'> & { id: string })[],
  principalId: string,
  now: number,
): WaitingQuestion[] {
  const out: WaitingQuestion[] = [];
  for (const m of messages) {
    if (!isQuestionMessage(m)) continue;
    const q = m.question;
    if (questionStatus(q, now) !== 'open') continue;
    if (q.to !== null && q.to.length > 0 && !q.to.includes(principalId)) continue;
    out.push({
      messageId: m.id,
      title: q.title,
      to: q.to,
      blocking: q.blocking,
      expiresAt: q.expiresAt,
    });
  }
  return out;
}

/** Only the blocking ones put the badge up (§L1: 'a blocking open question'). */
export const blockingQuestions = (list: readonly WaitingQuestion[]): WaitingQuestion[] =>
  list.filter((q) => q.blocking);

/** '❓ Waiting for you' / '❓ 2 waiting for you'. */
export function waitingBadgeLabel(count: number): string {
  return count === 1 ? 'Waiting for you' : `${count} waiting for you`;
}
