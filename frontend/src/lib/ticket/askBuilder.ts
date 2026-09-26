/**
 * Phase 5 — ASKING A QUESTION FROM THE COMPOSER (docs/plan/agents.html §N1).
 *
 * "Questions and task lists are not agent features — an agent was simply the
 * first thing that could use them." The composer's builder is the person's
 * half of §L1, and this module is its logic with no Svelte in it: the draft
 * shape, the four starting points, the field / option editing operations, the
 * validation that decides whether Ask is enabled, and the Question the live
 * preview renders.
 *
 * The rules here are the SHARED ones (questionFieldIssue, the schema's limits)
 * applied to a half-built draft, so a draft that passes `draftIssues` is a
 * question `questionAsk` accepts — the dialog never lies about what will go
 * through.
 */
import {
  MAX_QUESTION_FIELDS,
  MAX_QUESTION_OPTIONS,
  QUESTION_LABEL_MAX,
  QUESTION_OPTION_LABEL_MAX,
  QUESTION_TITLE_MAX,
  isOptionField,
  type Question,
  type QuestionField,
  type QuestionFieldType,
  type QuestionOption,
  type RichTextDoc,
} from '@tm/shared';

/** The most people a question may name (QuestionSchema.to). */
export const MAX_QUESTION_TO = 50;

/** One option row while it is being edited — its label may still be blank. */
export interface DraftOption {
  id: string;
  label: string;
  description?: string;
}

/** One field row while it is being edited. */
export interface DraftField {
  id: string;
  label: string;
  type: QuestionFieldType;
  /** Only meaningful for single / multi; kept (empty) for the rest. */
  options: DraftOption[];
  required: boolean;
}

/** 'never' | '1h' | '1d' | '1w' (§N1: expires). */
export type ExpiryChoice = 'never' | '1h' | '1d' | '1w';

export const EXPIRY_CHOICES: { value: ExpiryChoice; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: '1h', label: 'In an hour' },
  { value: '1d', label: 'In a day' },
  { value: '1w', label: 'In a week' },
];

const EXPIRY_MS: Record<Exclude<ExpiryChoice, 'never'>, number> = {
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

/** When the card locks as 'Expired', or null for 'never'. */
export function expiresAtOf(choice: ExpiryChoice, now: number): number | null {
  return choice === 'never' ? null : now + EXPIRY_MS[choice];
}

/** Everything the builder holds. `to` empty = anyone on the board (§L1: null). */
export interface AskDraft {
  title: string;
  /** Optional context, the same rich text a message body holds. */
  body: RichTextDoc | null;
  fields: DraftField[];
  allowComment: boolean;
  to: string[];
  blocking: boolean;
  expires: ExpiryChoice;
}

/** The field types, in the order the picker offers them, in words. */
export const FIELD_TYPE_LABELS: { value: QuestionFieldType; label: string }[] = [
  { value: 'single', label: 'Single choice' },
  { value: 'multi', label: 'Multiple choice' },
  { value: 'text', label: 'Text' },
  { value: 'longText', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes / no' },
  { value: 'date', label: 'Date' },
];

let counter = 0;
/**
 * A draft-local id. It only has to be unique inside this one question
 * (LocalIdSchema is any 1–64 chars), and it is what the stored option /
 * field id becomes, so it stays stable while the dialog is open.
 */
export function newId(prefix = 'f'): string {
  counter += 1;
  return `${prefix}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function blankOption(label = ''): DraftOption {
  return { id: newId('o'), label };
}

export function blankField(type: QuestionFieldType = 'single', label = ''): DraftField {
  return {
    id: newId('f'),
    label,
    type,
    // A choice field starts with two rows, because one option is not a choice.
    options: isOptionField(type) ? [blankOption(), blankOption()] : [],
    required: false,
  };
}

/** An empty builder: one field, blocking (§L1's default), never expiring. */
export function emptyDraft(): AskDraft {
  return {
    title: '',
    body: null,
    fields: [blankField('single')],
    allowComment: false,
    to: [],
    blocking: true,
    expires: 'never',
  };
}

// ─────────────────────────── starting points (§N1) ───────────────────────────

export type TemplateId = 'yesno' | 'one' | 'several' | 'text';

export const TEMPLATES: { id: TemplateId; label: string; hint: string }[] = [
  { id: 'yesno', label: 'Yes / No', hint: 'One yes-or-no answer' },
  { id: 'one', label: 'Pick one', hint: 'Radio buttons' },
  { id: 'several', label: 'Pick several', hint: 'Checkboxes' },
  { id: 'text', label: 'Free text', hint: 'A written answer' },
];

/**
 * A draft started from one of the four starting points. The title is left
 * empty on purpose — it is the one thing only the asker can write.
 */
export function templateDraft(id: TemplateId): AskDraft {
  const base = emptyDraft();
  switch (id) {
    case 'yesno':
      return { ...base, fields: [{ ...blankField('boolean', 'Your answer'), required: true }] };
    case 'one':
      return {
        ...base,
        fields: [
          {
            ...blankField('single', 'Your answer'),
            options: [blankOption('Option 1'), blankOption('Option 2')],
            required: true,
          },
        ],
      };
    case 'several':
      return {
        ...base,
        fields: [
          {
            ...blankField('multi', 'Your answer'),
            options: [blankOption('Option 1'), blankOption('Option 2')],
          },
        ],
      };
    case 'text':
      return { ...base, fields: [{ ...blankField('longText', 'Your answer'), required: true }] };
  }
}

// ───────────────────────────── editing operations ────────────────────────────
/* All pure: they take a draft and return the next one, so the dialog's state
   is a single $state object and every change is testable on its own. */

export const canAddField = (d: AskDraft): boolean => d.fields.length < MAX_QUESTION_FIELDS;

export function addField(d: AskDraft, type: QuestionFieldType = 'single'): AskDraft {
  if (!canAddField(d)) return d;
  return { ...d, fields: [...d.fields, blankField(type)] };
}

export function removeField(d: AskDraft, fieldId: string): AskDraft {
  const fields = d.fields.filter((f) => f.id !== fieldId);
  // A question has at least one field; removing the last leaves a blank one.
  return { ...d, fields: fields.length ? fields : [blankField()] };
}

export function patchField(d: AskDraft, fieldId: string, patch: Partial<DraftField>): AskDraft {
  return { ...d, fields: d.fields.map((f) => (f.id === fieldId ? { ...f, ...patch } : f)) };
}

/**
 * Changing a field's type: becoming a choice grows an option editor (two
 * empty rows), leaving one drops the options — they mean nothing on a number.
 */
export function setFieldType(d: AskDraft, fieldId: string, type: QuestionFieldType): AskDraft {
  const kept = d.fields.find((f) => f.id === fieldId)?.options ?? [];
  const options = isOptionField(type) ? (kept.length ? kept : [blankOption(), blankOption()]) : [];
  return patchField(d, fieldId, { type, options });
}

/** Move a field up (-1) or down (+1); out of range is a no-op. */
export function moveField(d: AskDraft, fieldId: string, dir: -1 | 1): AskDraft {
  return {
    ...d,
    fields: swap(
      d.fields,
      d.fields.findIndex((f) => f.id === fieldId),
      dir,
    ),
  };
}

export const canAddOption = (f: DraftField): boolean => f.options.length < MAX_QUESTION_OPTIONS;

export function addOption(d: AskDraft, fieldId: string, label = ''): AskDraft {
  const f = d.fields.find((x) => x.id === fieldId);
  if (!f || !canAddOption(f)) return d;
  return patchField(d, fieldId, { options: [...f.options, blankOption(label)] });
}

export function removeOption(d: AskDraft, fieldId: string, optionId: string): AskDraft {
  const f = d.fields.find((x) => x.id === fieldId);
  if (!f) return d;
  return patchField(d, fieldId, { options: f.options.filter((o) => o.id !== optionId) });
}

export function patchOption(
  d: AskDraft,
  fieldId: string,
  optionId: string,
  patch: Partial<DraftOption>,
): AskDraft {
  const f = d.fields.find((x) => x.id === fieldId);
  if (!f) return d;
  return patchField(d, fieldId, {
    options: f.options.map((o) => (o.id === optionId ? { ...o, ...patch } : o)),
  });
}

/** Move an option up (-1) or down (+1) — the reorder §N1 asks for. */
export function moveOption(d: AskDraft, fieldId: string, optionId: string, dir: -1 | 1): AskDraft {
  const f = d.fields.find((x) => x.id === fieldId);
  if (!f) return d;
  return patchField(d, fieldId, {
    options: swap(
      f.options,
      f.options.findIndex((o) => o.id === optionId),
      dir,
    ),
  });
}

function swap<T>(xs: readonly T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (i < 0 || j < 0 || j >= xs.length) return [...xs];
  const out = [...xs];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

// ──────────────────────────────── validation ─────────────────────────────────

export interface DraftIssue {
  /** The field it is about; null for the question as a whole. */
  fieldId: string | null;
  message: string;
}

/** Options with something written in them — blank rows are simply dropped. */
const liveOptions = (f: DraftField): DraftOption[] =>
  f.options.filter((o) => o.label.trim() !== '');

/**
 * Why this draft cannot be asked yet, in the words the dialog shows. Empty =
 * Ask is enabled. The checks mirror QuestionSchema + questionFieldIssue, so a
 * draft with no issues is one questionAsk will take.
 */
export function draftIssues(d: AskDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const title = d.title.trim();
  if (!title) issues.push({ fieldId: null, message: 'A question needs a title' });
  else if (title.length > QUESTION_TITLE_MAX)
    issues.push({
      fieldId: null,
      message: `The title is at most ${QUESTION_TITLE_MAX} characters`,
    });

  if (d.fields.length === 0) issues.push({ fieldId: null, message: 'Add at least one field' });
  if (d.fields.length > MAX_QUESTION_FIELDS)
    issues.push({ fieldId: null, message: `A question has at most ${MAX_QUESTION_FIELDS} fields` });
  if (d.to.length > MAX_QUESTION_TO)
    issues.push({ fieldId: null, message: `At most ${MAX_QUESTION_TO} people can be named` });

  d.fields.forEach((f, i) => {
    const label = f.label.trim();
    if (!label) issues.push({ fieldId: f.id, message: `Field ${i + 1} needs a label` });
    else if (label.length > QUESTION_LABEL_MAX)
      issues.push({ fieldId: f.id, message: `“${label.slice(0, 20)}…” is too long a label` });
    if (isOptionField(f.type)) {
      const live = liveOptions(f);
      if (!live.length)
        issues.push({
          fieldId: f.id,
          message: `“${label || `Field ${i + 1}`}” needs at least one option`,
        });
      if (live.length > MAX_QUESTION_OPTIONS)
        issues.push({ fieldId: f.id, message: `At most ${MAX_QUESTION_OPTIONS} options` });
      if (live.some((o) => o.label.trim().length > QUESTION_OPTION_LABEL_MAX))
        issues.push({
          fieldId: f.id,
          message: `An option is at most ${QUESTION_OPTION_LABEL_MAX} characters`,
        });
    }
  });
  return issues;
}

export const draftOk = (d: AskDraft): boolean => draftIssues(d).length === 0;

/** The first issue about one field — the line under it in the builder. */
export const fieldIssue = (issues: readonly DraftIssue[], fieldId: string): string | null =>
  issues.find((i) => i.fieldId === fieldId)?.message ?? null;

/** Issues about the question as a whole. */
export const generalIssues = (issues: readonly DraftIssue[]): string[] =>
  issues.filter((i) => i.fieldId === null).map((i) => i.message);

// ───────────────────────── the question this draft makes ─────────────────────

/** The draft's fields as the schema stores them: trimmed, blank options gone. */
export function draftFields(d: AskDraft): QuestionField[] {
  return d.fields.map((f) => {
    const options: QuestionOption[] | undefined = isOptionField(f.type)
      ? liveOptions(f).map((o) => ({
          id: o.id,
          label: o.label.trim(),
          ...(o.description?.trim() ? { description: o.description.trim() } : {}),
        }))
      : undefined;
    return {
      id: f.id,
      label: f.label.trim() || 'Untitled',
      type: f.type,
      ...(options ? { options } : {}),
      ...(f.required ? { required: true } : {}),
    };
  });
}

/**
 * The card as the thread will render it — what the live preview draws, and
 * the shape the optimistic bubble carries while the ask is in the outbox.
 */
export function previewQuestion(d: AskDraft, now: number): Question {
  return {
    title: d.title.trim() || 'Your question',
    body: null,
    fields: draftFields(d),
    allowComment: d.allowComment,
    to: d.to.length ? [...d.to] : null,
    blocking: d.blocking,
    status: 'open',
    expiresAt: expiresAtOf(d.expires, now),
    answer: null,
    cancelledAt: null,
  };
}

/** What `questionAsk` is called with (boardId / ticketId added by the caller). */
export interface AskInput {
  title: string;
  body: RichTextDoc | null;
  fields: QuestionField[];
  allowComment: boolean;
  to: string[] | null;
  blocking: boolean;
  expiresAt: number | null;
}

export function toAskInput(d: AskDraft, now: number): AskInput {
  return {
    title: d.title.trim(),
    body: d.body,
    fields: draftFields(d),
    allowComment: d.allowComment,
    to: d.to.length ? [...new Set(d.to)] : null,
    blocking: d.blocking,
    expiresAt: expiresAtOf(d.expires, now),
  };
}
