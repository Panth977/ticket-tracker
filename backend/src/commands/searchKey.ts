/**
 * searchKey — a Typesense key the browser searches with directly, scoped
 * to the boards whose readerUids contain the caller (filter_by boardId:[…])
 * and valid for one hour. The client asks again when it expires — or after
 * joining / leaving a board, since the scope is fixed at mint time.
 *
 * A search backend that is down answers 503 (safe to retry).
 */
import { errors, paths } from '@tm/shared';
import { ports } from '../adapters/index.js';
import { db } from '../runtime/firebase.js';
import { defineCommand } from './_registry.js';

export const SEARCH_KEY_TTL_MS = 60 * 60 * 1000;
/** A board id that can never exist: an empty filter would mean "everything" to some backends. */
export const NO_BOARDS = '__none__';

export default defineCommand('searchKey', async (ctx) => {
  const snap = await db()
    .collection(paths.boards())
    .where('readerUids', 'array-contains', ctx.actor)
    .select()
    .get();
  let boardIds = snap.docs.map((d) => d.id).sort();
  // An API-key / OAuth caller narrowed to some boards gets only those.
  if (ctx.boardIds) boardIds = boardIds.filter((b) => ctx.boardIds!.includes(b));
  const expiresAt = ctx.now + SEARCH_KEY_TTL_MS;
  try {
    const { key, host } = await ports().search.scopedKey(
      boardIds.length ? boardIds : [NO_BOARDS],
      expiresAt,
    );
    return { key, host, expiresAt };
  } catch (e) {
    console.warn('[searchKey] search backend failed', e);
    throw errors.unavailable('Search is temporarily unavailable');
  }
});
