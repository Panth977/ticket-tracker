/**
 * The Typesense `tickets` collection (app/db.json "tickets index") and the
 * query parameters every search uses. The memory fake (memory.ts) mirrors
 * these semantics so a test that passes against it means the same thing
 * against Typesense.
 *
 *   key    infix — '42' finds ENG-42 (the '#' picker types numbers)
 *   title  per-word prefix — '#logi' finds 'Fix login redirect'
 *   text   description + last 20 messages, per-word prefix, lowest weight
 *
 * Filters (boardId always, from the scoped key or the server's own query)
 * are facets, so they are exact-match and cheap.
 */
import type { CollectionCreateSchema } from 'typesense';
import { SEARCH_COLLECTION } from '@tm/shared';

export const TICKETS_SCHEMA: CollectionCreateSchema = {
  name: SEARCH_COLLECTION,
  fields: [
    { name: 'boardId', type: 'string', facet: true },
    // infix needs the field indexed with n-grams: costs memory, so key only.
    { name: 'key', type: 'string', infix: true, sort: true },
    { name: 'title', type: 'string' },
    { name: 'text', type: 'string' },
    { name: 'stageCategory', type: 'string', facet: true },
    { name: 'assigneeUids', type: 'string[]', facet: true },
    { name: 'state', type: 'string', facet: true },
    { name: 'updatedAt', type: 'int64', sort: true },
  ],
  default_sorting_field: 'updatedAt',
  // 'ENG-42' also tokenises as 'eng' + '42', so 'eng 42' and 'ENG-42' both hit.
  token_separators: ['-'],
};

/** Field order and weights shared by the real query and the fake's scoring. */
export const QUERY_BY = ['key', 'title', 'text'] as const;
export const QUERY_BY_WEIGHTS = [4, 2, 1] as const;

/** Upper bound on the folded `text` field (description + 20 messages). */
export const MAX_INDEX_TEXT = 32_000;

/** How many messages onMessageWritten folds into `text`. */
export const INDEXED_MESSAGES = 20;

/** Typesense filter value: backquoted so ids with ':' or ',' stay one value. */
export const quoteFilter = (s: string) => '`' + s.replace(/`/g, '') + '`';

/** `field:[a,b,c]` */
export const inFilter = (field: string, values: readonly string[]) =>
  `${field}:[${values.map(quoteFilter).join(',')}]`;
