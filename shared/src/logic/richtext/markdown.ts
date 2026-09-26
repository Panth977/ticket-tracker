/**
 * Markdown ↔ RichText doc — for the doors that speak Markdown (REST, MCP,
 * email replies, the public shape).
 *
 * IN  (markdownToDoc): a mention is written as an EMAIL — '@priya@x.com' or
 *     '[@Priya](mailto:priya@x.com)' — and resolved to that person's uid on
 *     this board; an email not on the board stays plain text (or a mailto link).
 *     '#ENG-42' becomes a ticketRef when the key resolves. Raw HTML is never
 *     parsed; images and tables are not part of the schema.
 *     Phase 2: an AGENT (no email) is mentioned as '@ag_…' (its id) or
 *     '[@Name](agent:ag_…)', resolved with agentOnBoard.
 * OUT (docToMarkdown): mentions as [@Name](mailto:email) — agents as
 *     [@Name](agent:ag_…) — refs as #KEY (api/public.ts), so the output parses
 *     straight back to the same doc.
 *
 * Resolution is SYNCHRONOUS here (this package does no I/O): the caller runs
 * collectMarkdownRefs(), looks the emails / keys up, then passes the answers in.
 */
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import {
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownSerializer,
  type MarkdownSerializerState,
} from 'prosemirror-markdown';
import type { Node as PMNodeInstance } from '@tiptap/pm/model';
import { AppError } from '../../errors.js';
import {
  isAgentId,
  type PMNode,
  type RichTextDoc,
  type TicketId,
  type Uid,
} from '../../types/index.js';
import { MAX_MARKDOWN_CHARS, richTextSchema, toPMNode, validateDoc } from './schema.js';

export interface MarkdownResolve {
  /** Lower-cased email → the uid of a person ON THIS BOARD, else undefined. */
  uidForEmail?: (email: string) => Uid | undefined;
  /** Phase 2: is this agent id ('ag_…') on this board? Absent = agent mentions stay plain text. */
  agentOnBoard?: (agentId: string) => boolean;
  /** Upper-cased key 'ENG-42' → ticket id (the caller decides visibility), else undefined. */
  ticketIdForKey?: (key: string) => TicketId | undefined;
}

export interface MarkdownPeople {
  /** principal id → current name and email, for [@Name](mailto:email) (agents: [@Name](agent:id)). */
  personOf?: (uid: Uid) => { name: string; email?: string | null | undefined } | undefined;
  /** ticket id → current key (the node's key is only a hint). */
  keyOf?: (ticketId: TicketId) => string | undefined;
}

const EMAIL = '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}';
const KEY = '[A-Za-z][A-Za-z0-9]{1,5}-[1-9][0-9]*';
const AGENT = 'ag_[A-Za-z0-9]{16}';
/** '@email', '@ag_…' or '#KEY' where a word does not continue before it. */
const INLINE_REF_RE = new RegExp(
  `(^|[^A-Za-z0-9_@#&/])(?:@(${EMAIL})|#(${KEY})|@(${AGENT}))(?![A-Za-z0-9_-])`,
  'g',
);

/** Every email and key a Markdown body might mention — look them up, then call markdownToDoc. */
export function collectMarkdownRefs(md: string): {
  emails: string[];
  keys: string[];
  agentIds: string[];
} {
  const emails = new Set<string>();
  const keys = new Set<string>();
  const agentIds = new Set<string>();
  for (const m of md.matchAll(new RegExp(`\\]\\(mailto:(${EMAIL})\\)`, 'g')))
    emails.add(m[1]!.toLowerCase());
  for (const m of md.matchAll(new RegExp(`\\]\\(agent:(${AGENT})\\)`, 'g'))) agentIds.add(m[1]!);
  for (const m of md.matchAll(INLINE_REF_RE)) {
    if (m[2]) emails.add(m[2].toLowerCase());
    if (m[3]) keys.add(m[3].toUpperCase());
    if (m[4]) agentIds.add(m[4]);
  }
  return { emails: [...emails], keys: [...keys], agentIds: [...agentIds] };
}

// ───────────────────────── parse ─────────────────────────

interface Env {
  resolve: MarkdownResolve;
}

/** Core rule: turn '@email', '#KEY' and [@Name](mailto:…) inside text into mention / ticket_ref tokens. */
function refsPlugin(md: MarkdownIt) {
  md.core.ruler.after('inline', 'tm_refs', (state: StateCore) => {
    const { resolve } = (state.env as Env | undefined) ?? { resolve: {} };
    for (const blockTok of state.tokens) {
      if (blockTok.type !== 'inline' || !blockTok.children) continue;
      const out: Token[] = [];
      const kids = blockTok.children;
      let linkDepth = 0;
      for (let i = 0; i < kids.length; i++) {
        const t = kids[i]!;
        // [@Name](mailto:x) → one mention, when x is on the board.
        if (t.type === 'link_open') {
          const href = t.attrGet('href') ?? '';
          const text = kids[i + 1];
          const close = kids[i + 2];
          const m = /^mailto:(.+)$/i.exec(href);
          const a = new RegExp(`^agent:(${AGENT})$`).exec(href);
          if (
            (m || a) &&
            text?.type === 'text' &&
            text.content.startsWith('@') &&
            close?.type === 'link_close'
          ) {
            const uid = m
              ? resolve.uidForEmail?.(decodeURIComponent(m[1]!).toLowerCase())
              : resolve.agentOnBoard?.(a![1]!)
                ? a![1]!
                : undefined;
            if (uid) {
              const tok = new state.Token('mention', '', 0);
              tok.meta = { uid };
              out.push(tok);
              i += 2;
              continue;
            }
          }
          linkDepth++;
          out.push(t);
          continue;
        }
        if (t.type === 'link_close') linkDepth--;
        if (t.type !== 'text' || linkDepth > 0) {
          out.push(t);
          continue;
        }
        // Split a text token around resolvable refs.
        let last = 0;
        const src = t.content;
        for (const m of src.matchAll(INLINE_REF_RE)) {
          const start = m.index + m[1]!.length;
          const email = m[2]?.toLowerCase();
          const key = m[3]?.toUpperCase();
          const agentId = m[4];
          const uid = email
            ? resolve.uidForEmail?.(email)
            : agentId && resolve.agentOnBoard?.(agentId)
              ? agentId
              : undefined;
          const ticketId = key ? resolve.ticketIdForKey?.(key) : undefined;
          if (!uid && !ticketId) continue; // not on the board / unknown key → plain text
          if (start > last) {
            const txt = new state.Token('text', '', 0);
            txt.content = src.slice(last, start);
            out.push(txt);
          }
          const tok = new state.Token(uid ? 'mention' : 'ticket_ref', '', 0);
          tok.meta = uid ? { uid } : { ticketId, key };
          out.push(tok);
          last = m.index + m[0].length;
        }
        if (last === 0) out.push(t);
        else if (last < src.length) {
          const txt = new state.Token('text', '', 0);
          txt.content = src.slice(last);
          out.push(txt);
        }
      }
      blockTok.children = out;
    }
  });
}

const tokenizer = new MarkdownIt('default', { html: false, linkify: false, breaks: false })
  .disable(['image', 'table'])
  .use(refsPlugin);

const parser = new MarkdownParser(richTextSchema, tokenizer, {
  blockquote: { block: 'blockquote' },
  paragraph: { block: 'paragraph' },
  list_item: { block: 'listItem' },
  bullet_list: { block: 'bulletList' },
  ordered_list: {
    block: 'orderedList',
    getAttrs: (tok) => ({ start: Number(tok.attrGet('start')) || 1 }),
  },
  heading: {
    block: 'heading',
    getAttrs: (tok) => ({ level: Math.min(3, Number(tok.tag.slice(1)) || 1) }),
  },
  code_block: { block: 'codeBlock', noCloseToken: true },
  fence: {
    block: 'codeBlock',
    getAttrs: (tok) => ({ language: tok.info.trim() || null }),
    noCloseToken: true,
  },
  hr: { node: 'horizontalRule' },
  hardbreak: { node: 'hardBreak' },
  em: { mark: 'italic' },
  strong: { mark: 'bold' },
  s: { mark: 'strike' },
  link: { mark: 'link', getAttrs: (tok) => ({ href: tok.attrGet('href') }) },
  code_inline: { mark: 'code', noCloseToken: true },
  mention: { node: 'mention', getAttrs: (tok) => ({ uid: tok.meta.uid }) },
  ticket_ref: {
    node: 'ticketRef',
    getAttrs: (tok) => ({ ticketId: tok.meta.ticketId, key: tok.meta.key }),
  },
});

const TASK_RE = /^\[( |x|X)\]\s+/;

/** '- [ ] a' / '- [x] b' lists → taskList. All items must be tasks, or it stays a bullet list. */
function liftTaskLists(n: PMNode): PMNode {
  const content = n.content?.map(liftTaskLists);
  const out: PMNode = content ? { ...n, content } : { ...n };
  if (n.type !== 'bulletList' || !content?.length) return out;
  const firstText = (item: PMNode) =>
    item.content?.[0]?.type === 'paragraph' ? item.content[0].content?.[0] : undefined;
  const allTasks = content.every((item) => {
    const t = firstText(item);
    return t?.type === 'text' && TASK_RE.test(t.text ?? '');
  });
  if (!allTasks) return out;
  return {
    type: 'taskList',
    content: content.map((item) => {
      const para = item.content![0]!;
      const t = para.content![0]!;
      const m = TASK_RE.exec(t.text!)!;
      const rest = t.text!.slice(m[0].length);
      const inl = rest ? [{ ...t, text: rest }, ...para.content!.slice(1)] : para.content!.slice(1);
      const newPara: PMNode = inl.length ? { ...para, content: inl } : { type: 'paragraph' };
      // taskItem holds paragraphs only (nested: false) — flatten anything else to its text.
      const others = item.content!.slice(1).filter((c) => c.type === 'paragraph');
      return { type: 'taskItem', attrs: { checked: m[1] !== ' ' }, content: [newPara, ...others] };
    }),
  };
}

/** Markdown → a validated RichText doc. Throws AppError too_large over MAX_MARKDOWN_CHARS. */
export function markdownToDoc(md: string, resolve: MarkdownResolve = {}): RichTextDoc {
  if (md.length > MAX_MARKDOWN_CHARS) throw new AppError('too_large', 'Markdown body too long');
  const env: Env = { resolve };
  const node = parser.parse(md.replace(/\r\n?/g, '\n'), env);
  const json = node.toJSON() as RichTextDoc;
  const lifted = liftTaskLists(json as PMNode) as RichTextDoc;
  // An empty body parses to one empty paragraph; store it as an empty doc.
  const content = lifted.content ?? [];
  if (content.length === 1 && content[0]!.type === 'paragraph' && !content[0]!.content?.length) {
    return { type: 'doc', content: [] };
  }
  return validateDoc({ type: 'doc', content });
}

// ───────────────────────── serialize ─────────────────────────

const escLabel = (s: string) => s.replace(/[[\]\\]/g, '\\$&');

function serializer(people: MarkdownPeople): MarkdownSerializer {
  const d = defaultMarkdownSerializer;
  type S = MarkdownSerializerState;
  type N = PMNodeInstance;
  const inlineBlock = (state: S, node: N) => {
    state.renderInline(node);
    state.closeBlock(node);
  };
  return new MarkdownSerializer(
    {
      paragraph: inlineBlock,
      heading: (state: S, node: N) => {
        state.write(`${'#'.repeat(Number(node.attrs.level) || 1)} `);
        inlineBlock(state, node);
      },
      blockquote: d.nodes.blockquote!,
      codeBlock: (state: S, node: N) => {
        const fence = '`'.repeat(
          Math.max(3, ...(node.textContent.match(/`+/g) ?? []).map((m) => m.length + 1)),
        );
        state.write(`${fence}${node.attrs.language ?? ''}\n`);
        state.text(node.textContent, false);
        state.ensureNewLine();
        state.write(fence);
        state.closeBlock(node);
      },
      horizontalRule: (state: S, node: N) => {
        state.write('---');
        state.closeBlock(node);
      },
      bulletList: (state: S, node: N) => state.renderList(node, '  ', () => '- '),
      orderedList: (state: S, node: N) => {
        const start = Number(node.attrs.start) || 1;
        const maxW = String(start + node.childCount - 1).length;
        const space = ' '.repeat(maxW + 2);
        state.renderList(node, space, (i) => {
          const n = String(start + i);
          return ' '.repeat(maxW - n.length) + n + '. ';
        });
      },
      taskList: (state: S, node: N) =>
        state.renderList(node, '  ', (i) => (node.child(i).attrs.checked ? '- [x] ' : '- [ ] ')),
      listItem: (state: S, node: N) => state.renderContent(node),
      taskItem: (state: S, node: N) => state.renderContent(node),
      text: (state: S, node: N) => state.text(node.text ?? ''),
      hardBreak: (state: S, node: N, parent: N, index: number) => {
        for (let i = index + 1; i < parent.childCount; i++) {
          if (parent.child(i).type !== node.type) {
            state.write('\\\n');
            return;
          }
        }
      },
      mention: (state: S, node: N) => {
        const id = String(node.attrs.uid);
        const p = people.personOf?.(id);
        const name = p?.name ?? 'someone';
        if (isAgentId(id)) state.write(`[@${escLabel(name)}](agent:${id})`);
        else
          state.write(p?.email ? `[@${escLabel(name)}](mailto:${p.email})` : `@${state.esc(name)}`);
      },
      ticketRef: (state: S, node: N) => {
        const key =
          people.keyOf?.(String(node.attrs.ticketId)) ??
          (node.attrs.key as string | null) ??
          'ticket';
        state.write(`#${key}`);
      },
    },
    {
      italic: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
      bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
      strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
      // Markdown has no underline; the words survive, the underline does not.
      underline: { open: '', close: '' },
      code: d.marks.code!,
      link: d.marks.link!,
    },
    { hardBreakNodeName: 'hardBreak' },
  );
}

/** A validated doc → CommonMark (+ ~~strike~~ and - [ ] tasks). */
export function docToMarkdown(doc: RichTextDoc, people: MarkdownPeople = {}): string {
  if (!doc.content.length) return '';
  return serializer(people).serialize(toPMNode(doc), { tightLists: true }).trim();
}
