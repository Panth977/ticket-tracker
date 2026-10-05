/**
 * DESCRIPTIONS (docs/plan/indicators.html) — every entity's description is
 * plain text (Markdown allowed). Boards used to store rich text; an old client
 * may still SEND a rich-text doc, and an old board still HOLDS one until
 * scripts/migrate-indicators.mjs runs. descriptionText() reads any of them.
 */
import { DESCRIPTION_MAX } from '../types/indicator.js';
import { docToMarkdown, validateDoc } from './richtext/index.js';

type DocLike = { type: 'doc'; content?: unknown[] };
const isDoc = (v: unknown): v is DocLike =>
  !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'doc';

/**
 * A description as plain text: a string (trimmed), a stored RichText
 * ({ doc, text, … }) or a bare doc flattened to Markdown. Empty → null.
 * Never longer than DESCRIPTION_MAX.
 */
export function descriptionText(d: unknown): string | null {
  let out = '';
  if (typeof d === 'string') out = d;
  else if (isDoc(d)) out = flatten(d, '');
  else if (d && typeof d === 'object' && 'doc' in d) {
    const r = d as { doc?: unknown; text?: unknown };
    out = flatten(r.doc, typeof r.text === 'string' ? r.text : '');
  }
  out = out.trim();
  if (!out) return null;
  return out.length > DESCRIPTION_MAX ? out.slice(0, DESCRIPTION_MAX).trimEnd() : out;
}

function flatten(doc: unknown, fallback: string): string {
  try {
    return docToMarkdown(validateDoc(doc));
  } catch {
    return fallback;
  }
}
