/**
 * SearchIndex: Typesense when TYPESENSE_HOST + TYPESENSE_API_KEY are set,
 * else an in-memory index (per process — enough for tests and a single
 * emulator process; it starts empty on every cold start).
 *
 * Env for the real client:
 *   TYPESENSE_HOST, TYPESENSE_PORT (443), TYPESENSE_PROTOCOL (https),
 *   TYPESENSE_API_KEY  admin key (server writes / searches)
 *   TYPESENSE_SEARCH_KEY  search-only parent key the scoped browser keys derive from
 *   TYPESENSE_PUBLIC_HOST  host the browser should use (defaults to TYPESENSE_HOST)
 *
 * The collection schema / relevance tuning belong to the `search` step
 * (backend/src/search/**); this adapter only moves documents and queries.
 */
import type { Client as TypesenseClient } from 'typesense';
import { createSearchIndex } from '../search/index.js';
import {
  SEARCH_COLLECTION,
  type SearchHit,
  type SearchIndex,
  type SearchQuery,
  type TicketDoc,
} from '@tm/shared';

// ─── in-memory ───────────────────────────────────────────────────────────────

export interface MemorySearchIndex extends SearchIndex {
  /** Test helper: everything indexed. */
  all(): TicketDoc[];
  clear(): void;
}

export function memorySearch(): MemorySearchIndex {
  const docs = new Map<string, TicketDoc>();
  return {
    async upsert(doc) {
      docs.set(doc.id, { ...doc });
    },
    async delete(ticketId) {
      docs.delete(ticketId);
    },
    async scopedKey(boardIds, expiresAt) {
      // Not a secret: the memory index is only reachable server-side.
      const key =
        'dev_' + Buffer.from(JSON.stringify({ boardIds, expiresAt })).toString('base64url');
      return { key, host: 'memory' };
    },
    async search(q: SearchQuery) {
      const needle = q.q.trim().toLowerCase();
      const allowed = new Set(q.boardIds);
      const hits: SearchHit[] = [];
      for (const d of docs.values()) {
        if (!allowed.has(d.boardId)) continue;
        if (q.stageCategory?.length && !q.stageCategory.includes(d.stageCategory)) continue;
        if (q.state?.length && !q.state.includes(d.state)) continue;
        if (q.assigneeUids?.length && !q.assigneeUids.some((u) => d.assigneeUids.includes(u)))
          continue;
        const fields = [d.key, d.title, d.text];
        const idx = needle ? fields.findIndex((f) => f.toLowerCase().includes(needle)) : 0;
        if (idx < 0) continue;
        // Score: key match > title > body; newer first within a tier.
        const score = (3 - idx) * 1e13 + d.updatedAt;
        hits.push({
          id: d.id,
          boardId: d.boardId,
          key: d.key,
          title: d.title,
          snippet: snippet(fields[idx]!, needle),
          score,
        });
      }
      hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return { hits: hits.slice(0, q.limit ?? 20), found: hits.length };
    },
    all: () => [...docs.values()],
    clear: () => docs.clear(),
  };
}

function snippet(text: string, needle: string): string {
  if (!needle) return text.slice(0, 120);
  const i = text.toLowerCase().indexOf(needle);
  const start = Math.max(0, i - 40);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (
    (start > 0 ? '…' : '') +
    esc(text.slice(start, i)) +
    '<mark>' +
    esc(text.slice(i, i + needle.length)) +
    '</mark>' +
    esc(text.slice(i + needle.length, i + needle.length + 80))
  );
}

// ─── Typesense ───────────────────────────────────────────────────────────────

export function typesenseSearch(env: NodeJS.ProcessEnv = process.env): SearchIndex {
  const host = env.TYPESENSE_HOST!;
  const port = Number(env.TYPESENSE_PORT ?? 443);
  const protocol = env.TYPESENSE_PROTOCOL ?? 'https';
  const apiKey = env.TYPESENSE_API_KEY!;
  const publicHost = env.TYPESENSE_PUBLIC_HOST ?? `${protocol}://${host}:${port}`;
  let client: Promise<TypesenseClient> | undefined;
  const get = () =>
    (client ??= import('typesense').then(
      (m) =>
        new m.default.Client({
          nodes: [{ host, port, protocol }],
          apiKey,
          connectionTimeoutSeconds: 5,
        }),
    ));
  const quote = (s: string) => '`' + s.replace(/`/g, '') + '`';

  return {
    async upsert(doc) {
      await (await get()).collections(SEARCH_COLLECTION).documents().upsert(doc);
    },
    async delete(ticketId) {
      try {
        await (await get()).collections(SEARCH_COLLECTION).documents(ticketId).delete();
      } catch (e) {
        if ((e as { httpStatus?: number }).httpStatus !== 404) throw e;
      }
    },
    async scopedKey(boardIds, expiresAt) {
      const parent = env.TYPESENSE_SEARCH_KEY ?? apiKey;
      const key = (await get()).keys().generateScopedSearchKey(parent, {
        filter_by: `boardId:[${boardIds.map(quote).join(',')}]`,
        expires_at: Math.floor(expiresAt / 1000),
      });
      return { key, host: publicHost };
    },
    async search(q) {
      if (q.boardIds.length === 0) return { hits: [], found: 0 };
      const filters = [`boardId:[${q.boardIds.map(quote).join(',')}]`];
      if (q.stageCategory?.length)
        filters.push(`stageCategory:[${q.stageCategory.map(quote).join(',')}]`);
      if (q.state?.length) filters.push(`state:[${q.state.map(quote).join(',')}]`);
      if (q.assigneeUids?.length)
        filters.push(`assigneeUids:[${q.assigneeUids.map(quote).join(',')}]`);
      const res = await (
        await get()
      )
        .collections<TicketDoc>(SEARCH_COLLECTION)
        .documents()
        .search({
          q: q.q || '*',
          query_by: 'key,title,text',
          infix: 'always,off,off',
          filter_by: filters.join(' && '),
          per_page: q.limit ?? 20,
          highlight_fields: 'title,text',
        });
      const hits: SearchHit[] = (res.hits ?? []).map((h) => {
        const d = h.document;
        const hl = h.highlights?.[0];
        return {
          id: d.id,
          boardId: d.boardId,
          key: d.key,
          title: d.title,
          ...(hl?.snippet ? { snippet: hl.snippet } : {}),
          ...(typeof h.text_match === 'number' ? { score: h.text_match } : {}),
        };
      });
      return { hits, found: res.found ?? hits.length };
    },
  };
}

/**
 * The port's default: the search step's index (Typesense with schema
 * auto-create and tuned relevance, or its matching in-memory fake). The
 * simpler clients above stay for tests that want a bare index.
 */
export function createSearch(): SearchIndex {
  return createSearchIndex();
}
