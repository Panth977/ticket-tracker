import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { isAppError, type PMNode, type RichTextDoc } from '../../index.js';
import { sampleRichText, UID_PRIYA } from '../../schema/fixtures.js';
import {
  ALLOWED_MARKS,
  ALLOWED_NODES,
  MAX_MARKDOWN_CHARS,
  MAX_MENTIONS,
  MAX_TEXT_CHARS,
  collectMarkdownRefs,
  derive,
  docFromText,
  docToMarkdown,
  isEmptyDoc,
  isValidDoc,
  markdownToDoc,
  parseRichText,
  richTextExtensions,
  validateDoc,
} from './index.js';

const doc = (...content: PMNode[]): RichTextDoc => ({ type: 'doc', content });
const p = (...content: PMNode[]): PMNode => ({ type: 'paragraph', content });
const text = (t: string, marks?: PMNode['marks']): PMNode =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
const mention = (uid: string): PMNode => ({ type: 'mention', attrs: { uid } });
const ref = (ticketId: string, key: string): PMNode => ({
  type: 'ticketRef',
  attrs: { ticketId, key },
});

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return isAppError(e) ? e.code : 'thrown';
  }
  return undefined;
};

const people: Record<string, { name: string; email: string }> = {
  [UID_PRIYA]: { name: 'Priya Shah', email: 'priya@x.com' },
  uid_asha: { name: 'Asha Rao', email: 'asha@x.com' },
};
const byEmail = Object.fromEntries(Object.entries(people).map(([uid, p]) => [p.email, uid]));
const tickets: Record<string, string> = { 'ENG-2': 'tkt_0002', 'ENG-40': 'tkt_0040' };
const keyOfId = Object.fromEntries(Object.entries(tickets).map(([k, id]) => [id, k]));
const resolve = {
  uidForEmail: (e: string) => byEmail[e],
  ticketIdForKey: (k: string) => tickets[k],
};
const render = {
  personOf: (uid: string) => people[uid],
  keyOf: (id: string) => keyOfId[id],
  nameOf: (uid: string) => people[uid]?.name,
};

describe('schema', () => {
  it('exact allow-list of nodes and marks', () => {
    expect([...ALLOWED_NODES].sort()).toEqual(
      [
        'blockquote',
        'bulletList',
        'codeBlock',
        'doc',
        'hardBreak',
        'heading',
        'horizontalRule',
        'listItem',
        'mention',
        'orderedList',
        'paragraph',
        'taskItem',
        'taskList',
        'text',
        'ticketRef',
      ].sort(),
    );
    expect([...ALLOWED_MARKS].sort()).toEqual([
      'bold',
      'code',
      'italic',
      'link',
      'strike',
      'underline',
    ]);
  });
  it('the editor builds the same schema from the same extensions', () => {
    const s = getSchema(richTextExtensions({ nameOf: () => 'X' }));
    expect(Object.keys(s.nodes).sort()).toEqual([...ALLOWED_NODES].sort());
    expect(s.nodes.mention!.spec.attrs).toHaveProperty('uid');
    expect(Object.keys(s.nodes.ticketRef!.spec.attrs ?? {}).sort()).toEqual(['key', 'ticketId']);
  });
  it('a headless editor round-trips the fixture doc', () => {
    const editor = new Editor({
      extensions: richTextExtensions(),
      content: sampleRichText.doc,
      element: null as never,
    });
    expect(validateDoc(editor.getJSON())).toEqual(validateDoc(sampleRichText.doc));
    editor.destroy();
  });
});

describe('validateDoc', () => {
  it('accepts the fixture', () => {
    expect(validateDoc(sampleRichText.doc)).toEqual(sampleRichText.doc);
    expect(isValidDoc(sampleRichText.doc)).toBe(true);
  });
  it('accepts an empty doc', () => {
    expect(validateDoc({ type: 'doc', content: [] })).toEqual({ type: 'doc', content: [] });
  });
  it.each<[string, unknown]>([
    ['not a doc', { type: 'paragraph' }],
    ['garbage', 'hello'],
    ['unknown node', doc({ type: 'image', attrs: { src: 'x' } })],
    ['raw html node', doc({ type: 'html', text: '<script>' } as PMNode)],
    ['mention without uid', doc(p({ type: 'mention', attrs: { id: 'x' } }))],
    ['ticketRef without id', doc(p({ type: 'ticketRef', attrs: { key: 'ENG-1' } }))],
    ['text at block level', doc(text('hi'))],
    ['empty text node', doc(p({ type: 'text', text: '' }))],
    ['list item outside a list', doc({ type: 'listItem', content: [p(text('x'))] })],
  ])('rejects %s → 400', (_, input) => {
    expect(code(() => validateDoc(input))).toBe('invalid');
    expect(isValidDoc(input)).toBe(false);
  });
  it('strips unknown marks and unsafe links; keeps safe ones', () => {
    const out = validateDoc(
      doc(
        p(
          text('a', [{ type: 'bold' }, { type: 'textStyle', attrs: { color: 'red' } }]),
          text('b', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]),
          text('c', [
            { type: 'link', attrs: { href: 'https://x.com', target: '_blank', onclick: 'x' } },
          ]),
        ),
      ),
    );
    expect(out.content[0]!.content).toEqual([
      text('a', [{ type: 'bold' }]),
      text('b'),
      text('c', [{ type: 'link', attrs: { href: 'https://x.com' } }]),
    ]);
  });
  it('drops marks a parent forbids and unknown attrs; clamps heading', () => {
    const out = validateDoc(
      doc(
        {
          type: 'codeBlock',
          attrs: { language: 'ts', evil: 1 },
          content: [text('x', [{ type: 'bold' }])],
        },
        { type: 'heading', attrs: { level: 6 }, content: [text('H')] },
        p({ type: 'mention', attrs: { uid: 'u1', label: 'Old Name' } }),
      ),
    );
    expect(out.content[0]).toEqual({
      type: 'codeBlock',
      attrs: { language: 'ts' },
      content: [text('x')],
    });
    expect(out.content[1]!.attrs).toEqual({ level: 3 });
    expect(out.content[2]!.content![0]).toEqual(mention('u1'));
  });
  it('size caps → 413', () => {
    expect(code(() => validateDoc(doc(p(text('x'.repeat(MAX_TEXT_CHARS + 1))))))).toBe('too_large');
    expect(
      code(() => validateDoc(doc(...Array.from({ length: 3000 }, () => p(text('0123456789')))))),
    ).toBe('too_large');
  });
  it('depth cap → 400', () => {
    let n: PMNode = p(text('deep'));
    for (let i = 0; i < 20; i++) n = { type: 'blockquote', content: [n] };
    expect(code(() => validateDoc(doc(n)))).toBe('invalid');
  });
});

describe('derive', () => {
  it('matches the fixture', () => {
    expect(derive(sampleRichText.doc, { nameOf: (u) => people[u]?.name })).toEqual({
      text: sampleRichText.text,
      mentions: sampleRichText.mentions,
      refs: sampleRichText.refs,
    });
  });
  it('de-duplicates and keeps order; falls back to hints', () => {
    const d = derive(
      doc(
        p(
          mention('b'),
          text(' '),
          mention('a'),
          text(' '),
          mention('b'),
          text(' '),
          ref('t1', 'ENG-1'),
          ref('t1', 'ENG-1'),
        ),
      ),
    );
    expect(d.mentions).toEqual(['b', 'a']);
    expect(d.refs).toEqual(['t1']);
    expect(d.text).toBe('@someone @someone @someone #ENG-1#ENG-1');
  });
  it('renders blocks as readable plain text', () => {
    const d = derive(
      doc(
        { type: 'heading', attrs: { level: 1 }, content: [text('Plan')] },
        p(text('line 1'), { type: 'hardBreak' }, text('line 2')),
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [p(text('one'))] },
            {
              type: 'listItem',
              content: [
                p(text('two')),
                {
                  type: 'bulletList',
                  content: [{ type: 'listItem', content: [p(text('two.a'))] }],
                },
              ],
            },
          ],
        },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [{ type: 'listItem', content: [p(text('three'))] }],
        },
        {
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { checked: true }, content: [p(text('done'))] },
            { type: 'taskItem', attrs: { checked: false }, content: [p(text('todo'))] },
          ],
        },
        { type: 'blockquote', content: [p(text('quoted'))] },
        { type: 'horizontalRule' },
        { type: 'codeBlock', content: [text('a()\nb()')] },
      ),
    );
    expect(d.text).toBe(
      [
        'Plan',
        'line 1',
        'line 2',
        '- one',
        '- two',
        '  - two.a',
        '3. three',
        '[x] done',
        '[ ] todo',
        '> quoted',
        '---',
        'a()',
        'b()',
      ].join('\n'),
    );
  });
});

describe('parseRichText', () => {
  it('mentions only members; refs only readable', () => {
    const rt = parseRichText(
      doc(
        p(
          mention(UID_PRIYA),
          text(' '),
          mention('outsider'),
          text(' '),
          ref('tkt_0002', 'ENG-2'),
          text(' '),
          ref('secret', 'HR-1'),
        ),
      ),
      {
        isMember: (u) => u === UID_PRIYA,
        canRef: (id) => id !== 'secret',
        nameOf: (u) => (u === 'outsider' ? 'Olly' : people[u]?.name),
      },
    );
    expect(rt.mentions).toEqual([UID_PRIYA]);
    expect(rt.refs).toEqual(['tkt_0002']);
    expect(rt.text).toBe('@Priya Shah @Olly #ENG-2 #HR-1');
    expect(rt.doc.content[0]!.content![2]).toEqual(text('@Olly'));
  });
  it('caps mentions', () => {
    const many = Array.from({ length: MAX_MENTIONS + 1 }, (_, i) => mention(`u${i}`));
    expect(code(() => parseRichText(doc(p(...many))))).toBe('invalid');
  });
});

describe('markdownToDoc', () => {
  it('resolves @email and [@Name](mailto:) on the board; others stay text', () => {
    const d = markdownToDoc(
      'Hi @priya@x.com and [@Asha](mailto:asha@x.com), cc @nobody@y.com and [@Zed](mailto:zed@y.com)',
      resolve,
    );
    expect(d.content[0]!.content).toEqual([
      text('Hi '),
      mention(UID_PRIYA),
      text(' and '),
      mention('uid_asha'),
      text(', cc @nobody@y.com and '),
      text('@Zed', [{ type: 'link', attrs: { href: 'mailto:zed@y.com' } }]),
    ]);
  });
  it('#KEY → ticketRef when it resolves; not inside code or words', () => {
    const d = markdownToDoc('See #eng-40, #ENG-999, `#ENG-2`, x#ENG-2', resolve);
    expect(d.content[0]!.content).toEqual([
      text('See '),
      ref('tkt_0040', 'ENG-40'),
      text(', #ENG-999, '),
      text('#ENG-2', [{ type: 'code' }]),
      text(', x#ENG-2'),
    ]);
  });
  it('blocks and marks', () => {
    const d = markdownToDoc(
      [
        '# Title',
        '',
        '**b** *i* ~~s~~ [l](https://x.com)',
        '',
        '- a',
        '- b',
        '',
        '1. one',
        '',
        '> q',
        '',
        '```ts',
        'x()',
        '```',
        '',
        '---',
        '',
        '#### deep',
      ].join('\n'),
    );
    expect(d.content.map((n) => n.type)).toEqual([
      'heading',
      'paragraph',
      'bulletList',
      'orderedList',
      'blockquote',
      'codeBlock',
      'horizontalRule',
      'heading',
    ]);
    expect(d.content[0]!.attrs).toEqual({ level: 1 });
    expect(d.content[7]!.attrs).toEqual({ level: 3 });
    expect(d.content[5]!.attrs).toEqual({ language: 'ts' });
    expect(d.content[1]!.content!.map((n) => n.marks?.[0]?.type ?? null)).toEqual([
      'bold',
      null,
      'italic',
      null,
      'strike',
      null,
      'link',
    ]);
  });
  it('task lists', () => {
    const d = markdownToDoc('- [ ] write\n- [x] ship');
    expect(d.content[0]).toEqual({
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: false }, content: [p(text('write'))] },
        { type: 'taskItem', attrs: { checked: true }, content: [p(text('ship'))] },
      ],
    });
  });
  it('no raw HTML, no images, unsafe links unlinked', () => {
    const d = markdownToDoc(
      '<script>alert(1)</script>\n\n![x](https://i.png) [bad](javascript:alert(1))',
    );
    const all = JSON.stringify(d);
    expect(all).not.toContain('"html');
    expect(all).not.toContain('image');
    expect(all).not.toContain('"href":"javascript:');
    expect(derive(d).text).toContain('<script>alert(1)</script>');
  });
  it('empty → empty doc; too long → 413', () => {
    expect(markdownToDoc('')).toEqual({ type: 'doc', content: [] });
    expect(code(() => markdownToDoc('x'.repeat(MAX_MARKDOWN_CHARS + 1)))).toBe('too_large');
  });
  it('collectMarkdownRefs finds what to look up', () => {
    expect(collectMarkdownRefs('@Priya@X.com [@A](mailto:asha@x.com) #eng-40 #ENG-40')).toEqual({
      emails: ['asha@x.com', 'priya@x.com'],
      keys: ['ENG-40'],
      agentIds: [],
    });
    expect(
      collectMarkdownRefs(
        'hey @ag_Bu1lder000000001 and [@Rev](agent:ag_Rev1ewer00000001)',
      ).agentIds.sort(),
    ).toEqual(['ag_Bu1lder000000001', 'ag_Rev1ewer00000001']);
  });
});

describe('agent mentions (phase 2)', () => {
  const AG = 'ag_Bu1lder000000001';
  const onBoard = { ...resolve, agentOnBoard: (id: string) => id === AG };
  const mentions = (d: ReturnType<typeof markdownToDoc>) => derive(d).mentions;
  it('@ag_… and [@Name](agent:ag_…) resolve when the agent is on the board', () => {
    expect(mentions(markdownToDoc(`ping @${AG} now`, onBoard))).toEqual([AG]);
    expect(mentions(markdownToDoc(`ping [@Builder](agent:${AG})`, onBoard))).toEqual([AG]);
  });
  it('an agent not on the board (or no resolver) stays text', () => {
    expect(mentions(markdownToDoc('ping @ag_Other00000000000x', onBoard))).toEqual([]);
    expect(mentions(markdownToDoc(`ping @${AG}`, resolve))).toEqual([]);
    expect(derive(markdownToDoc(`ping [@Builder](agent:${AG})`, resolve)).text).toContain(
      'Builder',
    );
  });
  it('round-trips as [@Name](agent:id)', () => {
    const agentRender = {
      personOf: (id: string) => (id === AG ? { name: 'Builder' } : people[id]),
    };
    const d = markdownToDoc(`Over to @${AG} and [@Priya](mailto:priya@x.com)`, onBoard);
    const md = docToMarkdown(d, agentRender);
    expect(md).toBe(`Over to [@Builder](agent:${AG}) and [@Priya Shah](mailto:priya@x.com)`);
    expect(markdownToDoc(md, onBoard)).toEqual(d);
  });
});

describe('docToMarkdown', () => {
  it('mentions as [@Name](mailto:), refs as #KEY', () => {
    expect(docToMarkdown(sampleRichText.doc, render)).toBe(
      'Ping [@Priya Shah](mailto:priya@x.com) about #ENG-2',
    );
  });
  it('unknown person → @someone; empty doc → empty string', () => {
    expect(docToMarkdown(doc(p(mention('ghost'))))).toBe('@someone');
    expect(docToMarkdown(doc())).toBe('');
  });
  it('round-trips through markdownToDoc', () => {
    const original = validateDoc(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [text('Plan')] },
        p(
          text('Ask '),
          mention(UID_PRIYA),
          text(' about '),
          ref('tkt_0040', 'ENG-40'),
          text(' — '),
          text('now', [{ type: 'bold' }]),
          text(' or '),
          text('later', [{ type: 'italic' }]),
        ),
        p(
          text('a'),
          { type: 'hardBreak' },
          text('b'),
          text(' '),
          text('site', [{ type: 'link', attrs: { href: 'https://x.com' } }]),
          text(' '),
          text('x=1', [{ type: 'code' }]),
        ),
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [p(text('one'))] },
            { type: 'listItem', content: [p(text('two'))] },
          ],
        },
        {
          type: 'orderedList',
          attrs: { start: 1 },
          content: [{ type: 'listItem', content: [p(text('first'))] }],
        },
        {
          type: 'taskList',
          content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(text('done'))] }],
        },
        { type: 'blockquote', content: [p(text('quoted'))] },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = `x`;\n```')] },
        { type: 'horizontalRule' },
        p(text('special *chars* _here_ [x] #notakey')),
      ),
    );
    const md = docToMarkdown(original, render);
    expect(markdownToDoc(md, resolve)).toEqual(original);
  });
});

describe('helpers', () => {
  it('docFromText', () => {
    expect(docFromText('a\nb\n\nc')).toEqual(
      doc(p(text('a'), { type: 'hardBreak' }, text('b')), p(text('c'))),
    );
    expect(isValidDoc(docFromText('x\n\n\ny'))).toBe(true);
  });
  it('isEmptyDoc', () => {
    expect(isEmptyDoc(null)).toBe(true);
    expect(isEmptyDoc(doc(p(), p(text('  '))))).toBe(true);
    expect(isEmptyDoc(doc(p(mention('u'))))).toBe(false);
  });
});
