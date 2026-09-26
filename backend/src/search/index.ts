/**
 * Derived data: the Typesense `tickets` index, board counts, thumbnails.
 *
 *   schema.ts     collection schema + shared query constants
 *   typesense.ts  SearchIndex over Typesense (env-selected)
 *   memory.ts     in-memory SearchIndex with the same matching rules (dev / tests)
 *   doc.ts        ticket + thread → TicketDoc (pure)
 *   counts.ts     ticket → board.counts buckets (pure)
 *   sync.ts       Firestore reads/writes the triggers run
 *   images.ts     sharp: attachment thumbnails, avatars
 *
 * The triggers live in src/triggers/ (onTicketWritten, onMessageWritten,
 * onAttachmentFinalized) and write through ports().search.
 */
import type { SearchIndex } from '@tm/shared';
import { isEmulated } from '../runtime/firebase.js';
import { firestoreSearchIndex } from './firestore.js';
import { memorySearchIndex } from './memory.js';
import { typesenseSearchIndex } from './typesense.js';

export * from './schema.js';
export * from './memory.js';
export * from './typesense.js';
export * from './firestore.js';
export * from './doc.js';
export * from './counts.js';

/**
 * Typesense when TYPESENSE_HOST + TYPESENSE_API_KEY are set; else the memory
 * index under the emulators (one process — dev and tests), and the stateless
 * Firestore index in production (a per-instance memory index would disagree
 * across instances and start empty on every cold start).
 */
export function createSearchIndex(env: NodeJS.ProcessEnv = process.env): SearchIndex {
  if (env.TYPESENSE_HOST && env.TYPESENSE_API_KEY) return typesenseSearchIndex(env);
  return isEmulated() ? memorySearchIndex() : firestoreSearchIndex();
}
