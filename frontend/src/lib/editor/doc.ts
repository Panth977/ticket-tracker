/**
 * Pure helpers over the editor's JSON document — what the composer and the
 * description editor send, and how a slash command is read out of a message.
 * No TipTap / DOM here, so all of it is unit-tested (doc.test.ts).
 *
 * The server re-validates every body (shared logic/richtext validateDoc) and
 * derives text / mentions / refs itself; the client only has to send a doc
 * that is (a) not empty and (b) free of editor noise such as the trailing
 * empty paragraphs TipTap leaves behind.
 */
import type { PMNode, RichTextDoc } from '@tm/shared';

export const EMPTY: RichTextDoc = { type: 'doc', content: [] };

/** Nodes that carry meaning even with no text (a mention, a rule …). */
const ATOMS = new Set(['mention', 'ticketRef', 'horizontalRule']);

/** Does this node (recursively) hold anything a reader would see? */
export function hasContent(n: PMNode): boolean {
  if (n.type === 'text') return !!n.text && n.text.trim().length > 0;
  if (ATOMS.has(n.type)) return true;
  return (n.content ?? []).some(hasContent);
}

/** An empty or whitespace-only doc (what the editor holds when 'blank'). */
export function isEmptyDoc(doc: RichTextDoc | null | undefined): boolean {
  return !doc || !doc.content.some(hasContent);
}

function isBlankParagraph(n: PMNode): boolean {
  return n.type === 'paragraph' && !hasContent(n);
}

/** Drop trailing hard breaks and trailing whitespace inside a paragraph. */
function trimParagraphEnd(n: PMNode): PMNode {
  if (n.type !== 'paragraph' || !n.content?.length) return n;
  const content = [...n.content];
  while (content.length) {
    const last = content[content.length - 1]!;
    if (last.type === 'hardBreak') {
      content.pop();
      continue;
    }
    if (last.type === 'text') {
      const t = (last.text ?? '').replace(/\s+$/, '');
      if (!t) {
        content.pop();
        continue;
      }
      if (t !== last.text) content[content.length - 1] = { ...last, text: t };
    }
    break;
  }
  return content.length ? { ...n, content } : { type: 'paragraph' };
}

/**
 * The doc as it should be SENT: blank paragraphs at the start and end removed,
 * trailing breaks / spaces trimmed. Inner blank lines are kept (they are the
 * author's spacing). Returns a new object; the input is not touched.
 */
export function normalizeDoc(doc: RichTextDoc): RichTextDoc {
  const content = [...(doc.content ?? [])];
  while (content.length && isBlankParagraph(content[0]!)) content.shift();
  while (content.length && isBlankParagraph(content[content.length - 1]!)) content.pop();
  return { type: 'doc', content: content.map(trimParagraphEnd) };
}

/** Plain text → a doc: blank lines split paragraphs, single newlines become hard breaks. */
export function docFromText(text: string): RichTextDoc {
  const paras = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .filter((p) => p.trim().length);
  return {
    type: 'doc',
    content: paras.map((p) => {
      const lines = p.split('\n');
      const content: PMNode[] = [];
      lines.forEach((l, i) => {
        if (i > 0) content.push({ type: 'hardBreak' });
        if (l) content.push({ type: 'text', text: l });
      });
      return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
    }),
  };
}

/** Plain text of a doc, for snippets (quote-reply, previews). Mentions render as '@'. */
export function plainText(
  doc: RichTextDoc | null | undefined,
  nameOf?: (uid: string) => string | undefined,
): string {
  if (!doc) return '';
  const out: string[] = [];
  const walk = (n: PMNode, acc: string[]) => {
    switch (n.type) {
      case 'text':
        acc.push(n.text ?? '');
        return;
      case 'hardBreak':
        acc.push(' ');
        return;
      case 'mention':
        acc.push('@' + (nameOf?.(String(n.attrs?.uid ?? '')) ?? 'someone'));
        return;
      case 'ticketRef':
        acc.push('#' + (typeof n.attrs?.key === 'string' && n.attrs.key ? n.attrs.key : 'ticket'));
        return;
    }
    for (const c of n.content ?? []) walk(c, acc);
  };
  for (const block of doc.content) {
    const acc: string[] = [];
    walk(block, acc);
    const line = acc.join('').trim();
    if (line) out.push(line);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** Cut to `max` characters on a word boundary, with an ellipsis. */
export function snippet(text: string, max = 140): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

// ─────────────────────────────── slash commands ───────────────────────────────

export const SLASH_COMMANDS = [
  { id: 'assign', label: '/assign', hint: '@person — add assignees', needsArg: true },
  { id: 'unassign', label: '/unassign', hint: '@person — remove assignees', needsArg: true },
  { id: 'me', label: '/me', hint: 'Assign yourself', needsArg: false },
  { id: 'due', label: '/due', hint: 'fri, tomorrow, +3d, 2026-10-01 17:00', needsArg: true },
  { id: 'stage', label: '/stage', hint: 'Move to a stage by name', needsArg: true },
  { id: 'priority', label: '/priority', hint: 'Set priority by name', needsArg: true },
  // Phase 5 (§N1): opens the question builder — it takes no argument.
  { id: 'ask', label: '/ask', hint: 'Ask a question with options', needsArg: false },
  { id: 'watch', label: '/watch', hint: 'Watch this ticket', needsArg: false },
  { id: 'unwatch', label: '/unwatch', hint: 'Stop watching', needsArg: false },
] as const;
export type SlashId = (typeof SLASH_COMMANDS)[number]['id'];

export interface SlashAction {
  cmd: SlashId;
  /** Mention nodes in the command line (for /assign, /unassign). */
  uids: string[];
  /** The rest of the command line as text ('fri', 'In review'). */
  arg: string;
}

/** Commands matching what was typed after '/' (the '/' picker's items). */
export function matchSlash(query: string) {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.id.startsWith(q));
}

/**
 * Read a slash command out of a message: when the FIRST paragraph starts with
 * '/cmd', that paragraph is the command and the remaining blocks are the
 * message (possibly empty). Anything else → { action: null, rest: doc }.
 *
 *   '/assign @Priya @Sam' + 'Over to you'  → assign [priya, sam], rest = 'Over to you'
 *   '/due fri'                             → due 'fri', rest = empty
 */
export function extractSlash(doc: RichTextDoc): { action: SlashAction | null; rest: RichTextDoc } {
  const norm = normalizeDoc(doc);
  const first = norm.content[0];
  if (!first || first.type !== 'paragraph' || !first.content?.length)
    return { action: null, rest: norm };
  const head = first.content[0]!;
  if (head.type !== 'text' || head.marks?.length) return { action: null, rest: norm };
  const m = /^\/([a-z]+)(?=\s|$)/.exec(head.text ?? '');
  const cmd = m && SLASH_COMMANDS.find((c) => c.id === m[1]);
  if (!m || !cmd) return { action: null, rest: norm };

  const uids: string[] = [];
  const words: string[] = [];
  first.content.forEach((n, i) => {
    if (n.type === 'mention' && typeof n.attrs?.uid === 'string') {
      if (!uids.includes(n.attrs.uid)) uids.push(n.attrs.uid);
    } else if (n.type === 'text') {
      words.push(i === 0 ? (n.text ?? '').slice(m[0].length) : (n.text ?? ''));
    } else if (n.type === 'hardBreak') words.push(' ');
  });
  return {
    action: { cmd: cmd.id, uids, arg: words.join('').replace(/\s+/g, ' ').trim() },
    rest: { type: 'doc', content: norm.content.slice(1) },
  };
}
