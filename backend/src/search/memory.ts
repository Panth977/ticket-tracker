/**
 * In-memory SearchIndex with the SAME matching rules as the Typesense query in
 * typesense.ts, so tests and the emulator behave like production:
 *
 *   tokens     query and fields split on whitespace, punctuation and '-'
 *              (TICKETS_SCHEMA.token_separators), compared lowercase
 *   key        infix: a query token matches if it occurs INSIDE a key token
 *              ('42' → ENG-42, 'NG' → ENG-42)
 *   title/text whole word, and the LAST query token also as a prefix
 *              (Typesense `prefix: true` = prefix on the last word being typed)
 *   AND        every query token must match somewhere (key, title or text)
 *   rank       sum of the best field weight per token (key 4, title 2, text 1),
 *              then updatedAt desc — '*' / empty query is updatedAt desc
 *   filters    boardId (always), stageCategory, state, assigneeUids — exact
 *
 * Deliberately NOT modelled: typo tolerance and token dropping. A test that
 * relies on either would pass here and fail on Typesense, so none should.
 */
import type { SearchHit, SearchIndex, SearchQuery, TicketDoc } from '@tm/shared';
import { QUERY_BY, QUERY_BY_WEIGHTS } from './schema.js';

export interface MemorySearchIndex extends SearchIndex {
  /** Test helper: the stored document, or undefined. */
  get(ticketId: string): TicketDoc | undefined;
  /** Test helper: everything indexed. */
  all(): TicketDoc[];
  clear(): void;
}

/** Split like Typesense with token_separators ['-']: words of letters/digits. */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

type Field = (typeof QUERY_BY)[number];

/** Weight of the best field `token` matches in, 0 when none. */
function matchToken(
  token: string,
  isLast: boolean,
  fields: Record<Field, string[]>,
): { weight: number; field: Field } | null {
  for (let i = 0; i < QUERY_BY.length; i++) {
    const f = QUERY_BY[i]!;
    const words = fields[f];
    const hit =
      f === 'key'
        ? words.some((w) => w.includes(token))
        : words.some((w) => w === token || (isLast && w.startsWith(token)));
    if (hit) return { weight: QUERY_BY_WEIGHTS[i]!, field: f };
  }
  return null;
}

export function memorySearchIndex(): MemorySearchIndex {
  const docs = new Map<string, TicketDoc>();

  return {
    async upsert(doc) {
      docs.set(doc.id, structuredClone(doc));
    },
    async delete(ticketId) {
      docs.delete(ticketId);
    },
    async scopedKey(boardIds, expiresAt) {
      // Not a secret: the memory index is only reachable server-side. The
      // payload mirrors what a Typesense scoped key embeds.
      const payload = { filter_by: `boardId:[${boardIds.join(',')}]`, expires_at: expiresAt };
      return {
        key: 'dev_' + Buffer.from(JSON.stringify(payload)).toString('base64url'),
        host: 'memory',
      };
    },
    async search(q: SearchQuery) {
      const tokens = tokenize(q.q === '*' ? '' : q.q);
      const allowed = new Set(q.boardIds);
      const scored: { hit: SearchHit; rank: number; updatedAt: number }[] = [];

      for (const d of docs.values()) {
        if (!allowed.has(d.boardId)) continue;
        if (q.stageCategory?.length && !q.stageCategory.includes(d.stageCategory)) continue;
        if (q.state?.length && !q.state.includes(d.state)) continue;
        if (q.assigneeUids?.length && !q.assigneeUids.some((u) => d.assigneeUids.includes(u)))
          continue;

        const fields: Record<Field, string[]> = {
          key: tokenize(d.key),
          title: tokenize(d.title),
          text: tokenize(d.text),
        };
        let rank = 0;
        let snippetField: Field | null = null;
        let snippetToken = '';
        let ok = true;
        tokens.forEach((t, i) => {
          if (!ok) return;
          const m = matchToken(t, i === tokens.length - 1, fields);
          if (!m) return void (ok = false);
          rank += m.weight;
          if (m.field !== 'key' && !snippetField) {
            snippetField = m.field;
            snippetToken = t;
          }
        });
        if (!ok) continue;

        const hit: SearchHit = { id: d.id, boardId: d.boardId, key: d.key, title: d.title };
        if (snippetField) hit.snippet = snippet(d[snippetField], snippetToken);
        hit.score = rank;
        scored.push({ hit, rank, updatedAt: d.updatedAt });
      }

      scored.sort((a, b) => b.rank - a.rank || b.updatedAt - a.updatedAt);
      return { hits: scored.slice(0, q.limit ?? 20).map((s) => s.hit), found: scored.length };
    },
    get: (id) => {
      const d = docs.get(id);
      return d && structuredClone(d);
    },
    all: () => [...docs.values()].map((d) => structuredClone(d)),
    clear: () => docs.clear(),
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** ~120 chars around the first word starting with `token`, the word wrapped in <mark>. */
export function snippet(text: string, token: string): string {
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(token)}[\\p{L}\\p{N}]*)`, 'iu');
  const m = re.exec(text);
  if (!m) return esc(text.slice(0, 120));
  const i = m.index + m[1]!.length;
  const word = m[2]!;
  const start = Math.max(0, i - 40);
  return (
    (start > 0 ? '…' : '') +
    esc(text.slice(start, i)) +
    '<mark>' +
    esc(word) +
    '</mark>' +
    esc(text.slice(i + word.length, i + word.length + 80)) +
    (i + word.length + 80 < text.length ? '…' : '')
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
