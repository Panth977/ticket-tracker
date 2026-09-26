/**
 * The ProseMirror schema built from THE extension list, plus validateDoc —
 * the first half of backend.json proxyFunctions.parseRichText:
 *
 *   validate doc against the TipTap schema   // unknown node → 400
 *   strip marks not in the allow-list        // no raw HTML, ever
 *
 * Size caps keep a body inside what a Firestore document, an email and a
 * WhatsApp message can carry.
 */
import { getSchema } from '@tiptap/core';
import type { Node as PMNodeInstance, Schema } from '@tiptap/pm/model';
import { AppError } from '../../errors.js';
import {
  RichTextDocSchema,
  type PMMark,
  type PMNode,
  type RichTextDoc,
} from '../../types/index.js';
import { HEADING_LEVELS, isAllowedHref, richTextExtensions } from './extensions.js';

/** Serialized doc JSON. Firestore's limit is 1 MiB per document; a body gets a tenth of it. */
export const MAX_DOC_BYTES = 100_000;
/** Plain-text characters (what search, email and previews carry). */
export const MAX_TEXT_CHARS = 20_000;
/** Markdown accepted from REST / MCP / email before conversion. */
export const MAX_MARKDOWN_CHARS = 50_000;
/** Nesting depth (blockquote in list in blockquote …). */
export const MAX_DEPTH = 16;
/** A mention notifies someone — a body may not page the whole company. */
export const MAX_MENTIONS = 50;
export const MAX_REFS = 50;

/** The schema the editor edits and the server validates against. */
export const richTextSchema: Schema = getSchema(richTextExtensions());

export const ALLOWED_NODES: readonly string[] = Object.keys(richTextSchema.nodes);
export const ALLOWED_MARKS: readonly string[] = Object.keys(richTextSchema.marks);

function sanitizeMarks(marks: readonly PMMark[] | undefined): PMMark[] | undefined {
  if (!marks?.length) return undefined;
  const out: PMMark[] = [];
  for (const m of marks) {
    const type = richTextSchema.marks[m.type];
    if (!type) continue; // strip, don't reject: pasted content carries stray marks
    if (m.type === 'link') {
      const href = m.attrs?.href;
      if (!isAllowedHref(href)) continue; // javascript:, data:, relative … → plain text
      out.push({ type: 'link', attrs: { href: href.trim() } });
      continue;
    }
    out.push({ type: m.type });
  }
  return out.length ? out : undefined;
}

function sanitizeAttrs(n: PMNode, path: string): Record<string, unknown> | undefined {
  const type = richTextSchema.nodes[n.type]!;
  const known = Object.keys(type.spec.attrs ?? {});
  if (!known.length) return undefined;
  const a = n.attrs ?? {};
  const out: Record<string, unknown> = {};
  for (const k of known) if (a[k] !== undefined) out[k] = a[k];

  switch (n.type) {
    case 'mention':
      if (typeof out.uid !== 'string' || !out.uid)
        throw invalid(`${path}: mention needs attrs.uid`);
      return { uid: out.uid };
    case 'ticketRef':
      if (typeof out.ticketId !== 'string' || !out.ticketId)
        throw invalid(`${path}: ticketRef needs attrs.ticketId`);
      return { ticketId: out.ticketId, key: typeof out.key === 'string' ? out.key : null };
    case 'heading': {
      const level = Number(out.level ?? 1);
      return {
        level: (HEADING_LEVELS as readonly number[]).includes(level)
          ? level
          : HEADING_LEVELS.at(-1)!,
      };
    }
    case 'taskItem':
      return { checked: out.checked === true };
    case 'orderedList':
      return {
        start: Number.isInteger(out.start) && (out.start as number) >= 0 ? out.start : 1,
        type: null,
      };
    case 'codeBlock':
      return { language: typeof out.language === 'string' ? out.language.slice(0, 32) : null };
    default:
      return out;
  }
}

const invalid = (msg: string) => new AppError('invalid', `Rich text: ${msg}`, { field: 'body' });

function sanitizeNode(n: PMNode, path: string, depth: number): PMNode {
  if (depth > MAX_DEPTH) throw invalid('nested too deeply');
  if (!richTextSchema.nodes[n.type]) throw invalid(`${path}: unknown node '${n.type}'`);
  if (n.type === 'text') {
    if (typeof n.text !== 'string' || n.text === '') throw invalid(`${path}: empty text node`);
    const marks = sanitizeMarks(n.marks);
    return marks ? { type: 'text', text: n.text, marks } : { type: 'text', text: n.text };
  }
  const out: PMNode = { type: n.type };
  const attrs = sanitizeAttrs(n, path);
  if (attrs) out.attrs = attrs;
  if (n.content?.length) {
    const parent = richTextSchema.nodes[n.type]!;
    out.content = n.content.map((c, i) => {
      const child = sanitizeNode(c, `${path}.${i}`, depth + 1);
      // Drop marks this parent does not allow on its children (bold inside a code block).
      if (child.marks) {
        const ok = child.marks.filter((m) => parent.allowsMarkType(richTextSchema.marks[m.type]!));
        if (ok.length) child.marks = ok;
        else delete child.marks;
      }
      return child;
    });
    // Join adjacent text nodes with the same marks (what ProseMirror itself would do).
    out.content = out.content.reduce<PMNode[]>((acc, c) => {
      const prev = acc.at(-1);
      if (
        prev?.type === 'text' &&
        c.type === 'text' &&
        JSON.stringify(prev.marks ?? []) === JSON.stringify(c.marks ?? [])
      ) {
        acc[acc.length - 1] = { ...prev, text: prev.text! + c.text! };
      } else acc.push(c);
      return acc;
    }, []);
  }
  // Marks on non-text nodes (a bold mention) are kept only if the schema allows them there.
  const marks = sanitizeMarks(n.marks);
  if (marks) out.marks = marks;
  return out;
}

/**
 * Validate and normalise a doc from ANY door. Throws AppError:
 *   invalid    (400)  not a doc, unknown node, bad attrs, content the schema forbids
 *   too_large  (413)  over MAX_DOC_BYTES / MAX_TEXT_CHARS
 * Returns the cleaned JSON (unknown marks and attrs dropped, unsafe links unlinked).
 */
export function validateDoc(input: unknown): RichTextDoc {
  const parsed = RichTextDocSchema.safeParse(input);
  if (!parsed.success) throw invalid('not a { type: "doc", content: [...] } document');
  if (JSON.stringify(parsed.data).length > MAX_DOC_BYTES)
    throw new AppError('too_large', 'Rich text: document too large');

  const clean = sanitizeNode(parsed.data as PMNode, 'doc', 0) as RichTextDoc;
  if (!clean.content) clean.content = [];
  let node: PMNodeInstance;
  try {
    // An empty doc is allowed (a cleared description); PM's 'block+' would refuse it.
    node = richTextSchema.nodeFromJSON(
      clean.content.length ? clean : { type: 'doc', content: [{ type: 'paragraph' }] },
    );
    node.check();
  } catch (e) {
    throw invalid((e as Error).message);
  }
  if (node.textContent.length > MAX_TEXT_CHARS)
    throw new AppError('too_large', 'Rich text: text too long');
  return clean;
}

/** validateDoc without throwing — for the editor's 'can I save this?' state. */
export function isValidDoc(input: unknown): boolean {
  try {
    validateDoc(input);
    return true;
  } catch {
    return false;
  }
}

/** A ProseMirror node for an already-validated doc. */
export function toPMNode(doc: RichTextDoc): PMNodeInstance {
  return richTextSchema.nodeFromJSON(
    doc.content.length ? doc : { type: 'doc', content: [{ type: 'paragraph' }] },
  );
}
