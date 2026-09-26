import { describe, expect, it } from 'vitest';
import { QuestionSchema, MAX_QUESTION_FIELDS, questionFieldIssue } from '@tm/shared';
import {
  addField,
  addOption,
  blankField,
  canAddField,
  draftFields,
  draftIssues,
  draftOk,
  emptyDraft,
  expiresAtOf,
  fieldIssue,
  generalIssues,
  moveField,
  moveOption,
  patchField,
  patchOption,
  previewQuestion,
  removeField,
  removeOption,
  setFieldType,
  templateDraft,
  toAskInput,
  type AskDraft,
} from './askBuilder';

const NOW = 1_800_000_000_000;

/** A ready-to-ask draft: a title and one answerable field. */
function ready(): AskDraft {
  const d = templateDraft('one');
  return { ...d, title: 'Which database?' };
}

describe('the builder starts somewhere (§N1 starting points)', () => {
  it('offers four templates, each already valid once titled', () => {
    for (const id of ['yesno', 'one', 'several', 'text'] as const) {
      const d = { ...templateDraft(id), title: 'Pick' };
      expect(draftIssues(d), id).toEqual([]);
    }
  });

  it('Yes / No is one boolean field, Pick several is a multi with options', () => {
    expect(templateDraft('yesno').fields[0]!.type).toBe('boolean');
    const several = templateDraft('several').fields[0]!;
    expect(several.type).toBe('multi');
    expect(several.options.map((o) => o.label)).toEqual(['Option 1', 'Option 2']);
  });

  it('an empty draft is not askable: no title, no field label', () => {
    const issues = draftIssues(emptyDraft());
    expect(generalIssues(issues)).toContain('A question needs a title');
    expect(issues.some((i) => i.fieldId !== null)).toBe(true);
  });
});

describe('fields', () => {
  it('adds up to ten and no more (§L1: 1–10)', () => {
    let d = emptyDraft();
    while (canAddField(d)) d = addField(d);
    expect(d.fields).toHaveLength(MAX_QUESTION_FIELDS);
    expect(addField(d).fields).toHaveLength(MAX_QUESTION_FIELDS);
    expect(generalIssues(draftIssues(d))).not.toContain(
      `A question has at most ${MAX_QUESTION_FIELDS} fields`,
    );
  });

  it('removing the last field leaves a blank one, so the form is never empty', () => {
    const d = emptyDraft();
    const after = removeField(d, d.fields[0]!.id);
    expect(after.fields).toHaveLength(1);
    expect(after.fields[0]!.id).not.toBe(d.fields[0]!.id);
  });

  it('moves a field up and down, and ignores moves off the ends', () => {
    let d = addField(emptyDraft(), 'text');
    const [a, b] = [d.fields[0]!.id, d.fields[1]!.id];
    d = moveField(d, b, -1);
    expect(d.fields.map((f) => f.id)).toEqual([b, a]);
    expect(moveField(d, b, -1).fields.map((f) => f.id)).toEqual([b, a]);
    expect(moveField(d, a, 1).fields.map((f) => f.id)).toEqual([b, a]);
  });

  it('switching to a choice type grows an option editor, switching away drops it', () => {
    const d = emptyDraft();
    const id = d.fields[0]!.id;
    const text = setFieldType(d, id, 'text');
    expect(text.fields[0]!.options).toEqual([]);
    const back = setFieldType(text, id, 'multi');
    expect(back.fields[0]!.options).toHaveLength(2);
  });

  it('keeps the options already typed when switching single ↔ multi', () => {
    const d = ready();
    const switched = setFieldType(d, d.fields[0]!.id, 'multi');
    expect(switched.fields[0]!.options.map((o) => o.label)).toEqual(['Option 1', 'Option 2']);
  });
});

describe('options', () => {
  it('adds, renames, reorders and removes', () => {
    let d = ready();
    const f = d.fields[0]!.id;
    d = addOption(d, f, 'Option 3');
    expect(d.fields[0]!.options).toHaveLength(3);
    const third = d.fields[0]!.options[2]!.id;
    d = patchOption(d, f, third, { label: 'SQLite' });
    expect(d.fields[0]!.options[2]!.label).toBe('SQLite');
    d = moveOption(d, f, third, -1);
    expect(d.fields[0]!.options.map((o) => o.label)).toEqual(['Option 1', 'SQLite', 'Option 2']);
    d = removeOption(d, f, third);
    expect(d.fields[0]!.options.map((o) => o.label)).toEqual(['Option 1', 'Option 2']);
  });

  it('blank option rows are dropped, but a choice field needs one that is not', () => {
    let d = ready();
    const f = d.fields[0]!;
    d = patchField(d, f.id, { options: f.options.map((o) => ({ ...o, label: '  ' })) });
    expect(fieldIssue(draftIssues(d), f.id)).toMatch(/needs at least one option/);
    d = patchOption(d, f.id, d.fields[0]!.options[0]!.id, { label: 'Postgres' });
    expect(draftIssues(d)).toEqual([]);
    expect(draftFields(d)[0]!.options).toEqual([{ id: expect.any(String), label: 'Postgres' }]);
  });
});

describe('validation agrees with the shared schema', () => {
  it('a valid draft makes a question the schema accepts', () => {
    const d = { ...ready(), allowComment: true, blocking: true, to: ['u1'] };
    expect(draftOk(d)).toBe(true);
    const q = previewQuestion(d, NOW);
    expect(QuestionSchema.safeParse(q).success).toBe(true);
    for (const f of q.fields) expect(questionFieldIssue(f)).toBeNull();
  });

  it('an invalid draft is one the schema would refuse too', () => {
    const d: AskDraft = { ...ready(), fields: [blankField('single')] };
    expect(draftOk(d)).toBe(false);
    // ...and what it would have produced is not a legal question either.
    expect(QuestionSchema.safeParse({ ...previewQuestion(d, NOW), fields: [] }).success).toBe(
      false,
    );
  });

  it('a title is required and bounded', () => {
    expect(generalIssues(draftIssues({ ...ready(), title: '   ' }))).toContain(
      'A question needs a title',
    );
    expect(generalIssues(draftIssues({ ...ready(), title: 'x'.repeat(301) }))).toContain(
      'The title is at most 300 characters',
    );
  });

  it('names at most 50 people', () => {
    const many = Array.from({ length: 51 }, (_, i) => `u${i}`);
    expect(generalIssues(draftIssues({ ...ready(), to: many }))).toContain(
      'At most 50 people can be named',
    );
  });
});

describe('the preview and the command input', () => {
  it('previews exactly what the thread will render', () => {
    const q = previewQuestion({ ...ready(), expires: '1h', to: [] }, NOW);
    expect(q.title).toBe('Which database?');
    expect(q.status).toBe('open');
    expect(q.answer).toBeNull();
    expect(q.to).toBeNull(); // nobody named = anyone on the board
    expect(q.expiresAt).toBe(NOW + 3_600_000);
  });

  it('shows a placeholder title before one is typed, but never asks with it', () => {
    expect(previewQuestion(emptyDraft(), NOW).title).toBe('Your question');
    expect(toAskInput({ ...ready(), title: '  Which database?  ' }, NOW).title).toBe(
      'Which database?',
    );
  });

  it('turns the expiry choice into a moment', () => {
    expect(expiresAtOf('never', NOW)).toBeNull();
    expect(expiresAtOf('1d', NOW)).toBe(NOW + 86_400_000);
    expect(expiresAtOf('1w', NOW)).toBe(NOW + 604_800_000);
  });

  it('de-duplicates the people it is addressed to', () => {
    expect(toAskInput({ ...ready(), to: ['u1', 'u1', 'u2'] }, NOW).to).toEqual(['u1', 'u2']);
  });

  it('marks required fields and drops the flag when off', () => {
    const d = ready();
    expect(draftFields(d)[0]!.required).toBe(true);
    expect(
      draftFields(patchField(d, d.fields[0]!.id, { required: false }))[0]!.required,
    ).toBeUndefined();
  });
});
