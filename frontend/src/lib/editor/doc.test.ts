// @vitest-environment jsdom
/**
 * Composer serialisation: what the editor produces must be what the server
 * accepts (shared validateDoc / derive), after the client's normalisation and
 * slash-command extraction.
 */
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { derive, validateDoc } from '@tm/shared/logic/index';
import type { RichTextDoc } from '@tm/shared';
import { docFromText, extractSlash, isEmptyDoc, normalizeDoc, plainText, snippet } from './doc';
import { editorExtensions } from './extensions';

const p = (...content: RichTextDoc['content']) => ({ type: 'paragraph', content });
const text = (t: string) => ({ type: 'text', text: t });
const mention = (uid: string) => ({ type: 'mention', attrs: { uid } });
const ref = (ticketId: string, key: string) => ({ type: 'ticketRef', attrs: { ticketId, key } });
const doc = (...content: RichTextDoc['content']): RichTextDoc => ({ type: 'doc', content });

/** Load a doc into a real TipTap editor on the shared schema and read it back. */
function roundTrip(d: RichTextDoc): RichTextDoc {
  const el = document.createElement('div');
  const editor = new Editor({
    element: el,
    extensions: editorExtensions({ slash: true }),
    content: d,
  });
  const out = editor.getJSON() as RichTextDoc;
  editor.destroy();
  return out;
}

describe('isEmptyDoc', () => {
  it('treats blank and whitespace docs as empty', () => {
    expect(isEmptyDoc(null)).toBe(true);
    expect(isEmptyDoc(doc())).toBe(true);
    expect(isEmptyDoc(doc({ type: 'paragraph' }, p(text('   '))))).toBe(true);
  });
  it('counts atoms (mentions, refs) as content', () => {
    expect(isEmptyDoc(doc(p(mention('u1'))))).toBe(false);
    expect(isEmptyDoc(doc(p(ref('t1', 'ENG-1'))))).toBe(false);
  });
});

describe('normalizeDoc', () => {
  it('drops leading/trailing blank paragraphs and trailing breaks/spaces, keeps inner blanks', () => {
    const d = doc(
      { type: 'paragraph' },
      p(text('Hello  ')),
      { type: 'paragraph' },
      p(text('world'), { type: 'hardBreak' }, text('  ')),
      { type: 'paragraph' },
    );
    expect(normalizeDoc(d)).toEqual(doc(p(text('Hello')), { type: 'paragraph' }, p(text('world'))));
  });
  it('does not mutate its input', () => {
    const d = doc(p(text('x  ')));
    const copy = structuredClone(d);
    normalizeDoc(d);
    expect(d).toEqual(copy);
  });
});

describe('docFromText', () => {
  it('splits paragraphs on blank lines and hard-breaks single newlines', () => {
    expect(docFromText('a\nb\r\n\r\nc')).toEqual(
      doc(p(text('a'), { type: 'hardBreak' }, text('b')), p(text('c'))),
    );
  });
});

describe('plainText / snippet', () => {
  it('renders mentions and refs', () => {
    const d = doc(
      p(text('Ask '), mention('u1'), text(' about '), ref('t9', 'ENG-9')),
      p(text('thanks')),
    );
    expect(plainText(d, (u) => (u === 'u1' ? 'Priya' : undefined))).toBe(
      'Ask @Priya about #ENG-9 thanks',
    );
  });
  it('cuts on a word boundary', () => {
    expect(snippet('alpha beta gamma delta', 14)).toBe('alpha beta…');
    // A boundary too far back (under 60%) would waste the space: hard cut instead.
    expect(snippet('one two three four', 12)).toBe('one two thre…');
    expect(snippet('short')).toBe('short');
  });
});

describe('extractSlash', () => {
  it('reads /assign with mentions and keeps the rest as the message', () => {
    const d = doc(
      p(text('/assign '), mention('a'), text(' '), mention('b'), mention('a')),
      p(text('Over to you')),
    );
    const { action, rest } = extractSlash(d);
    expect(action).toEqual({ cmd: 'assign', uids: ['a', 'b'], arg: '' });
    expect(rest).toEqual(doc(p(text('Over to you'))));
  });
  it('reads an argument', () => {
    expect(extractSlash(doc(p(text('/due fri 17:00')))).action).toEqual({
      cmd: 'due',
      uids: [],
      arg: 'fri 17:00',
    });
    expect(extractSlash(doc(p(text('/stage   In review  ')))).action?.arg).toBe('In review');
  });
  it('ignores unknown commands, mid-line slashes and marked text', () => {
    for (const d of [
      doc(p(text('/nope x'))),
      doc(p(text('and/or'))),
      doc(p({ type: 'text', text: '/due fri', marks: [{ type: 'code' }] })),
      doc(p(text('/dueX'))),
    ]) {
      expect(extractSlash(d).action).toBeNull();
    }
  });
});

describe('editor round trip on the shared schema', () => {
  const rich = doc(
    { type: 'heading', attrs: { level: 2 }, content: [text('Plan')] },
    p(text('Hi '), mention('uid_1'), text(', see '), ref('tk_1', 'ENG-42'), text(' and '), {
      type: 'text',
      text: 'this',
      marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
    }),
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [p({ type: 'text', text: 'bold', marks: [{ type: 'bold' }] })],
        },
      ],
    },
    { type: 'paragraph' },
  );

  it('produces a doc the server accepts, with the same mentions and refs', () => {
    const sent = normalizeDoc(roundTrip(rich));
    expect(() => validateDoc(sent)).not.toThrow();
    const d = derive(sent);
    expect(d.mentions).toEqual(['uid_1']);
    expect(d.refs).toEqual(['tk_1']);
    // The trailing blank paragraph the editor keeps is gone.
    expect(sent.content.at(-1)?.type).toBe('bulletList');
  });

  it('is stable: normalise(roundTrip(x)) round-trips to itself', () => {
    const once = normalizeDoc(roundTrip(rich));
    expect(normalizeDoc(roundTrip(once))).toEqual(once);
  });

  it('a slash command message still validates after extraction', () => {
    const d = roundTrip(doc(p(text('/assign '), mention('uid_2')), p(text('Take this one'))));
    const { action, rest } = extractSlash(d);
    expect(action?.cmd).toBe('assign');
    expect(action?.uids).toEqual(['uid_2']);
    expect(() => validateDoc(rest)).not.toThrow();
    expect(plainText(rest)).toBe('Take this one');
  });
});
