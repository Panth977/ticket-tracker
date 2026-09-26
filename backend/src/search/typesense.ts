/**
 * SearchIndex over Typesense. Switched on only when TYPESENSE_HOST and
 * TYPESENSE_API_KEY are set (see createSearchIndex in index.ts).
 *
 *   TYPESENSE_HOST, TYPESENSE_PORT (443), TYPESENSE_PROTOCOL (https)
 *   TYPESENSE_API_KEY      admin key: server writes and server-side search
 *   TYPESENSE_SEARCH_KEY   search-only parent key the browser's scoped keys derive from
 *   TYPESENSE_PUBLIC_HOST  URL the browser uses (defaults to protocol://host:port)
 *
 * The collection is created on first use (an upsert that finds no collection
 * creates it from TICKETS_SCHEMA and retries), so a fresh cluster needs no
 * manual setup.
 */
import type { SearchParams, Client as TypesenseClient } from 'typesense';
import {
  SEARCH_COLLECTION,
  type SearchHit,
  type SearchIndex,
  type SearchQuery,
  type TicketDoc,
} from '@tm/shared';
import { inFilter, QUERY_BY, QUERY_BY_WEIGHTS, TICKETS_SCHEMA } from './schema.js';

const status = (e: unknown) => (e as { httpStatus?: number }).httpStatus;

/** Typesense search parameters for a SearchQuery — exported so tests can pin them. */
export function searchParams(q: SearchQuery): SearchParams<TicketDoc> {
  const filters = [inFilter('boardId', q.boardIds)];
  if (q.stageCategory?.length) filters.push(inFilter('stageCategory', q.stageCategory));
  if (q.state?.length) filters.push(inFilter('state', q.state));
  if (q.assigneeUids?.length) filters.push(inFilter('assigneeUids', q.assigneeUids));
  return {
    q: q.q.trim() || '*',
    query_by: QUERY_BY.join(','),
    query_by_weights: QUERY_BY_WEIGHTS.join(','),
    // Infix on key only (the only field indexed for it); prefix on the last word everywhere.
    infix: QUERY_BY.map((f) => (f === 'key' ? 'always' : 'off')),
    prefix: QUERY_BY.map(() => true),
    filter_by: filters.join(' && '),
    sort_by: '_text_match:desc,updatedAt:desc',
    per_page: q.limit ?? 20,
    highlight_fields: 'title,text',
    // Typo tolerance on a 2-char ticket number is noise ('42' ≠ '43').
    num_typos: [0, 1, 1],
  };
}

/** Scoped-key parameters: the browser can only ever see these boards, until expiry. */
export function scopedKeyParams(boardIds: readonly string[], expiresAt: number) {
  return {
    filter_by: inFilter('boardId', boardIds),
    expires_at: Math.floor(expiresAt / 1000),
  };
}

export function typesenseSearchIndex(env: NodeJS.ProcessEnv = process.env): SearchIndex {
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

  const docs = async () => (await get()).collections<TicketDoc>(SEARCH_COLLECTION).documents();

  async function ensureCollection(): Promise<void> {
    try {
      await (await get()).collections().create(TICKETS_SCHEMA);
    } catch (e) {
      if (status(e) !== 409) throw e; // 409: someone else created it first
    }
  }

  return {
    async upsert(doc) {
      try {
        await (await docs()).upsert(doc);
      } catch (e) {
        if (status(e) !== 404) throw e;
        await ensureCollection();
        await (await docs()).upsert(doc);
      }
    },
    async delete(ticketId) {
      try {
        await (await get()).collections(SEARCH_COLLECTION).documents(ticketId).delete();
      } catch (e) {
        if (status(e) !== 404) throw e; // already gone (or no collection yet)
      }
    },
    async scopedKey(boardIds, expiresAt) {
      const parent = env.TYPESENSE_SEARCH_KEY ?? apiKey;
      const key = (await get())
        .keys()
        .generateScopedSearchKey(parent, scopedKeyParams(boardIds, expiresAt));
      return { key, host: publicHost };
    },
    async search(q) {
      if (q.boardIds.length === 0) return { hits: [], found: 0 };
      let res;
      try {
        res = await (await docs()).search(searchParams(q));
      } catch (e) {
        if (status(e) === 404) return { hits: [], found: 0 }; // nothing indexed yet
        throw e;
      }
      const hits: SearchHit[] = (res.hits ?? []).map((h) => {
        const d = h.document;
        const hl = h.highlights?.find((x) => x.snippet);
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
