/**
 * derive — the fields of a RichText that are COMPUTED ON THE SERVER, never
 * trusted from the client (types/richtext.ts):
 *
 *   text      plain-text render ('@Priya Shah', '#ENG-42') — email, WhatsApp, search, previews
 *   mentions  every mention uid, in order, de-duplicated
 *   refs      every ticketRef ticketId, in order, de-duplicated
 *
 * parseRichText is the whole backend.json proxyFunctions.parseRichText, with
 * the board lookups passed in (this package does no I/O):
 *   mentions = mention nodes whose uid is on this board   (isMember)
 *   refs     = ticketRef nodes on boards the AUTHOR can read (canRef)
 * A mention of someone not on the board becomes plain text; an unreadable
 * ref stays as the node (it renders its key) but is not a ref.
 */
import { AppError } from '../../errors.js';
import type { PMNode, RichText, RichTextDoc, TicketId, Uid } from '../../types/index.js';
import { MAX_MENTIONS, MAX_REFS, MAX_TEXT_CHARS, validateDoc } from './schema.js';

export interface DeriveOptions {
  /** Current display name, for '@Name' in text. */
  nameOf?: (uid: Uid) => string | undefined;
  /** Current key, for '#KEY' in text (falls back to the node's key hint). */
  keyOf?: (ticketId: TicketId) => string | undefined;
}

export interface Derived {
  text: string;
  mentions: Uid[];
  refs: TicketId[];
}

/** Pure walk over the JSON — no schema needed, so it is cheap on every render. */
export function derive(doc: RichTextDoc, opts: DeriveOptions = {}): Derived {
  const mentions: Uid[] = [];
  const refs: TicketId[] = [];
  const lines: string[] = [];
  let line = '';

  /** Inline content; `cont` prefixes the lines a hard break starts. */
  const inline = (n: PMNode, cont: string) => {
    switch (n.type) {
      case 'text':
        line += (n.text ?? '').replace(/\n/g, `\n${cont}`);
        return;
      case 'hardBreak':
        lines.push(line);
        line = cont;
        return;
      case 'mention': {
        const uid = String(n.attrs?.uid ?? '');
        if (uid && !mentions.includes(uid)) mentions.push(uid);
        line += `@${opts.nameOf?.(uid) ?? 'someone'}`;
        return;
      }
      case 'ticketRef': {
        const id = String(n.attrs?.ticketId ?? '');
        if (id && !refs.includes(id)) refs.push(id);
        const hint = typeof n.attrs?.key === 'string' && n.attrs.key ? n.attrs.key : 'ticket';
        line += `#${opts.keyOf?.(id) ?? hint}`;
        return;
      }
      default:
        for (const c of n.content ?? []) inline(c, cont);
    }
  };

  /** A block on fresh line(s): `first` prefixes its first line, `cont` the rest. */
  const block = (n: PMNode, first: string, cont: string) => {
    switch (n.type) {
      case 'bulletList':
      case 'orderedList':
      case 'taskList': {
        let i = Number(n.attrs?.start ?? 1);
        (n.content ?? []).forEach((item, idx) => {
          const bullet =
            n.type === 'orderedList'
              ? `${i++}. `
              : n.type === 'taskList'
                ? item.attrs?.checked
                  ? '[x] '
                  : '[ ] '
                : '- ';
          const itemFirst = idx === 0 ? first + bullet : cont + bullet;
          (item.content ?? []).forEach((c, j) =>
            block(c, j === 0 ? itemFirst : cont + '  ', cont + '  '),
          );
        });
        return;
      }
      case 'blockquote':
        (n.content ?? []).forEach((c, j) => block(c, (j === 0 ? first : cont) + '> ', cont + '> '));
        return;
      case 'horizontalRule':
        lines.push(first + '---');
        return;
      default:
        // paragraph, heading, codeBlock
        line = first;
        for (const c of n.content ?? []) inline(c, cont);
        lines.push(line);
        line = '';
    }
  };

  for (const b of doc.content) block(b, '', '');
  const text = lines
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, mentions, refs };
}

export interface ParseRichTextOptions extends DeriveOptions {
  /** Is this uid on the board? (members/ lookup, done by the caller.) */
  isMember?: (uid: Uid) => boolean;
  /** Can the AUTHOR read the board this ticket is on? (keys/ lookup + can(read).) */
  canRef?: (ticketId: TicketId) => boolean;
}

/** Replace mention nodes that fail `keep` with their plain '@Name' text. */
function unmention(
  nodes: PMNode[] | undefined,
  keep: (uid: Uid) => boolean,
  nameOf: DeriveOptions['nameOf'],
): PMNode[] | undefined {
  if (!nodes) return nodes;
  return nodes.map((n) => {
    if (n.type === 'mention' && !keep(String(n.attrs?.uid))) {
      const t: PMNode = { type: 'text', text: `@${nameOf?.(String(n.attrs?.uid)) ?? 'someone'}` };
      if (n.marks) t.marks = n.marks;
      return t;
    }
    return n.content ? { ...n, content: unmention(n.content, keep, nameOf) } : n;
  });
}

/**
 * Validate + clean + derive, from any door. Throws AppError (400 / 413) like
 * validateDoc, and 400 when a body mentions more than MAX_MENTIONS people.
 */
export function parseRichText(input: unknown, opts: ParseRichTextOptions = {}): RichText {
  let doc = validateDoc(input);
  if (opts.isMember)
    doc = { ...doc, content: unmention(doc.content, opts.isMember, opts.nameOf) ?? [] };
  const d = derive(doc, opts);
  if (d.mentions.length > MAX_MENTIONS)
    throw new AppError('invalid', `Rich text: at most ${MAX_MENTIONS} mentions`, { field: 'body' });
  if (d.refs.length > MAX_REFS)
    throw new AppError('invalid', `Rich text: at most ${MAX_REFS} ticket references`, {
      field: 'body',
    });
  if (d.text.length > MAX_TEXT_CHARS) throw new AppError('too_large', 'Rich text: text too long');
  return {
    doc,
    text: d.text,
    mentions: d.mentions,
    refs: opts.canRef ? d.refs.filter(opts.canRef) : d.refs,
  };
}

/** A doc from plain text: one paragraph per line (system messages, intake subjects). */
export function docFromText(text: string): RichTextDoc {
  const paras = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  return {
    type: 'doc',
    content: paras
      .filter((p) => p.length > 0)
      .map((p) => {
        const parts = p.split('\n');
        const content: PMNode[] = [];
        parts.forEach((line, i) => {
          if (i > 0) content.push({ type: 'hardBreak' });
          if (line) content.push({ type: 'text', text: line });
        });
        return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
      }),
  };
}

/** Is there anything in it? (An empty description is stored as null.) */
export function isEmptyDoc(doc: RichTextDoc | null | undefined): boolean {
  if (!doc) return true;
  const has = (n: PMNode): boolean =>
    (n.type === 'text' && !!n.text?.trim()) ||
    n.type === 'mention' ||
    n.type === 'ticketRef' ||
    n.type === 'horizontalRule' ||
    (n.content ?? []).some(has);
  return !doc.content.some(has);
}
