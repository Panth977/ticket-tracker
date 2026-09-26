/**
 * Client-side matching with the SAME rules as the Typesense query
 * (backend/src/search/typesense.ts › searchParams, memory.ts):
 *   tokens  split on anything that is not a letter or digit, lowercase
 *   key     infix — '42' finds ENG-42, 'ng' finds ENG-42
 *   title   whole word, and the LAST query token also as a prefix
 *   AND     every query token must match somewhere
 *   rank    best field weight per token (key 4, title 2, text 1), then newest
 * Used by the dev / fallback search so ⌘K behaves the same with no Typesense.
 */
export interface Searchable {
  key: string;
  title: string;
  text?: string;
  updatedAt: number;
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const WEIGHTS = { key: 4, title: 2, text: 1 } as const;

/** 0 = no match; otherwise a relevance score. */
export function score(query: string, doc: Searchable): number {
  const q = tokenize(query);
  if (!q.length) return 1;
  const fields = {
    key: tokenize(doc.key),
    title: tokenize(doc.title),
    text: tokenize(doc.text ?? ''),
  };
  let total = 0;
  for (let i = 0; i < q.length; i++) {
    const t = q[i]!;
    const last = i === q.length - 1;
    let best = 0;
    if (fields.key.some((w) => w.includes(t))) best = WEIGHTS.key;
    else if (fields.title.some((w) => w === t || (last && w.startsWith(t)))) best = WEIGHTS.title;
    else if (fields.text.some((w) => w === t || (last && w.startsWith(t)))) best = WEIGHTS.text;
    if (!best) return 0;
    total += best;
  }
  return total;
}

/** Filter + rank; newest first among equals. */
export function rank<T extends Searchable>(query: string, docs: readonly T[], limit = 20): T[] {
  return docs
    .map((d) => ({ d, s: score(query, d) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.d.updatedAt - a.d.updatedAt)
    .slice(0, limit)
    .map((x) => x.d);
}
