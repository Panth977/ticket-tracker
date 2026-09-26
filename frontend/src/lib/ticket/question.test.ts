import { describe, expect, it } from 'vitest';
import type { BoardWithId, Question, QuestionField } from '@tm/shared';
import {
  answerAbility,
  answeredLines,
  blankForm,
  checkForm,
  fieldError,
  formErrors,
  isBlankForm,
  statusLabel,
  waitingBadgeLabel,
  waitingFor,
  waitingQuestions,
} from './question';

const NOW = Date.UTC(2026, 8, 23, 10, 0);

const field = (
  over: Partial<QuestionField> & Pick<QuestionField, 'id' | 'type'>,
): QuestionField => ({
  label: over.id,
  ...over,
});

const question = (over: Partial<Question> = {}): Question => ({
  title: 'Which database should the report use?',
  body: null,
  fields: [
    field({
      id: 'db',
      type: 'single',
      label: 'Database',
      required: true,
      options: [
        { id: 'pg', label: 'Postgres' },
        { id: 'sqlite', label: 'SQLite' },
      ],
    }),
  ],
  allowComment: false,
  to: null,
  blocking: true,
  status: 'open',
  expiresAt: null,
  answer: null,
  ...over,
});

/** A board where u1 is a commenter and u2 a viewer. */
const board = {
  id: 'b1',
  access: { u1: 'commenter', u2: 'viewer', ag_builder00000000: 'commenter' },
  stageGrants: {},
  settings: {},
} as unknown as BoardWithId;

describe('blankForm', () => {
  it('starts every field empty for its type, and takes the defaults', () => {
    const q = question({
      fields: [
        field({ id: 'db', type: 'single', options: [{ id: 'pg', label: 'Postgres' }] }),
        field({ id: 'tags', type: 'multi', options: [{ id: 'a', label: 'A' }] }),
        field({ id: 'note', type: 'text', default: 'hello' }),
        field({ id: 'ok', type: 'boolean' }),
      ],
    });
    // A boolean starts as null, not false: `false` is a real answer.
    expect(blankForm(q)).toEqual({ db: null, tags: [], note: 'hello', ok: null });
  });
});

describe('checkForm', () => {
  it('refuses a required field left blank, in the words the card shows', () => {
    const c = checkForm(question(), { db: null }, '');
    expect(c.ok).toBe(false);
    expect(fieldError(c, 'db')).toBe("'Database' is required");
  });

  it('refuses a value that is not one of the options', () => {
    const c = checkForm(question(), { db: 'mysql' }, '');
    expect(c.ok).toBe(false);
    expect(fieldError(c, 'db')).toContain('must be one of the options');
  });

  it('accepts a chosen option and sends exactly that', () => {
    const c = checkForm(question(), { db: 'pg' }, '');
    expect(c.ok).toBe(true);
    expect(c.values).toEqual({ db: 'pg' });
  });

  it('trims text and drops optional blanks rather than storing empty strings', () => {
    const q = question({
      fields: [field({ id: 'why', type: 'text' }), field({ id: 'more', type: 'longText' })],
    });
    const c = checkForm(q, { why: '  because  ', more: '   ' }, '');
    expect(c.ok).toBe(true);
    expect(c.values).toEqual({ why: 'because' });
  });

  it('refuses a comment when the question takes none', () => {
    const c = checkForm(question(), { db: 'pg' }, 'anything else');
    expect(c.ok).toBe(false);
    expect(formErrors(c)).toEqual(['This question takes no comment']);
  });

  it('keeps a comment when allowComment is on', () => {
    const c = checkForm(question({ allowComment: true }), { db: 'pg' }, ' ship it ');
    expect(c.ok).toBe(true);
  });

  it('checks multi answers against the option ids', () => {
    const q = question({
      fields: [
        field({
          id: 'tags',
          type: 'multi',
          label: 'Tags',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        }),
      ],
    });
    expect(checkForm(q, { tags: ['a', 'b'] }, '').ok).toBe(true);
    expect(checkForm(q, { tags: ['a', 'zz'] }, '').ok).toBe(false);
  });
});

describe('isBlankForm', () => {
  it('is blank until something is answered or written', () => {
    expect(isBlankForm({ db: null, tags: [], note: '' }, '')).toBe(true);
    expect(isBlankForm({ db: null }, 'hi')).toBe(false);
    expect(isBlankForm({ db: 'pg' }, '')).toBe(false);
    // false is an answer, not a blank.
    expect(isBlankForm({ ok: false }, '')).toBe(false);
  });
});

describe('answerAbility', () => {
  const nameOf = (id: string) => ({ u1: 'Panth', u2: 'Sam' })[id] ?? id;

  it('lets a commenter answer an open question meant for anyone', () => {
    expect(answerAbility({ actor: 'u1' }, board, question(), NOW, nameOf)).toEqual({
      can: true,
      reason: null,
    });
  });

  it('refuses a viewer, and says why', () => {
    const a = answerAbility({ actor: 'u2' }, board, question(), NOW, nameOf);
    expect(a.can).toBe(false);
    expect(a.reason).toMatch(/commenter rights/);
  });

  it('names whom an addressed question waits for', () => {
    const a = answerAbility({ actor: 'u1' }, board, question({ to: ['u2'] }), NOW, nameOf);
    expect(a).toEqual({ can: false, reason: 'Waiting for Sam.' });
  });

  it('leaves the explaining to the locked card once it is no longer open', () => {
    const expired = question({ expiresAt: NOW - 1 });
    expect(answerAbility({ actor: 'u1' }, board, expired, NOW, nameOf)).toEqual({
      can: false,
      reason: null,
    });
    const answered = question({ status: 'answered' });
    expect(answerAbility({ actor: 'u1' }, board, answered, NOW, nameOf).can).toBe(false);
  });
});

describe('waitingFor', () => {
  const nameOf = (id: string) => id.toUpperCase();
  it('reads as a sentence however many people it names', () => {
    expect(waitingFor([], nameOf)).toBe('anyone on the board');
    expect(waitingFor(['a'], nameOf)).toBe('A');
    expect(waitingFor(['a', 'b'], nameOf)).toBe('A or B');
    expect(waitingFor(['a', 'b', 'c'], nameOf)).toBe('A, B or 1 other');
    expect(waitingFor(['a', 'b', 'c', 'd'], nameOf)).toBe('A, B or 2 others');
  });
});

describe('answeredLines', () => {
  it('prints option labels, Yes / No and skips blanks, in field order', () => {
    const q = question({
      fields: [
        field({
          id: 'db',
          type: 'single',
          label: 'Database',
          options: [
            { id: 'pg', label: 'Postgres' },
            { id: 'sqlite', label: 'SQLite' },
          ],
        }),
        field({ id: 'ship', type: 'boolean', label: 'Ship today?' }),
        field({ id: 'note', type: 'text', label: 'Note' }),
      ],
      status: 'answered',
      answer: { values: { db: 'pg', ship: false }, by: 'u1', at: NOW },
    });
    expect(answeredLines(q, 'UTC')).toEqual([
      { fieldId: 'db', label: 'Database', text: 'Postgres' },
      { fieldId: 'ship', label: 'Ship today?', text: 'No' },
    ]);
  });
});

describe('waitingQuestions', () => {
  const msg = (id: string, q: Question) => ({ id, kind: 'question' as const, question: q });

  it('counts open questions for me, skips ones for other people and ones no longer open', () => {
    const rows = [
      msg('m1', question()), // anyone
      msg('m2', question({ to: ['u1'] })), // me
      msg('m3', question({ to: ['u2'] })), // someone else
      msg('m4', question({ status: 'answered' })),
      msg('m5', question({ expiresAt: NOW - 1 })), // expired by the clock alone
      { id: 'm6', kind: 'comment' as const, question: null },
    ];
    expect(waitingQuestions(rows, 'u1', NOW).map((q) => q.messageId)).toEqual(['m1', 'm2']);
  });

  it('labels the badge for one and for many', () => {
    expect(waitingBadgeLabel(1)).toBe('Waiting for you');
    expect(waitingBadgeLabel(3)).toBe('3 waiting for you');
  });
});

describe('statusLabel', () => {
  it('names each locked state', () => {
    expect(statusLabel('open')).toBe('Waiting for an answer');
    expect(statusLabel('answered')).toBe('Answered');
    expect(statusLabel('cancelled')).toBe('Cancelled');
    expect(statusLabel('expired')).toBe('Expired');
  });
});
