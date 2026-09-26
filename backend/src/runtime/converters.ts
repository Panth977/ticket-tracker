/**
 * Typed Firestore access built from the shared DOC_SCHEMAS — a document's
 * TypeScript type and its runtime check come from the same zod schema the
 * frontend and the rules tests use.
 *
 *   typedDoc('boards', paths.board(id))        DocumentReference<Board>
 *   typedCol('tickets', paths.tickets(boardId)) CollectionReference<Ticket>
 *
 * Writes through a converter are VALIDATED: a full `set()` parses with the
 * schema (a bad write is a bug → throws, the runner answers 500). Merge sets
 * and `update()` are partial and pass through unchecked — Firestore never
 * calls the converter for update(). Reads are trusted (rules + this layer are
 * the only writers); under the emulators they are also checked and a drift
 * is logged, so tests surface schema mismatches early without failing reads.
 */
import {
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  FieldValue,
  type FirestoreDataConverter,
  type PartialWithFieldValue,
  type QueryDocumentSnapshot,
  type SetOptions,
  type WithFieldValue,
} from 'firebase-admin/firestore';
import { DOC_SCHEMAS, type DocName, type DocOf } from '@tm/shared';
import type { z } from 'zod';
import { db, isEmulated } from './firebase.js';

const cache = new Map<DocName, FirestoreDataConverter<unknown>>();

export function converterFor<N extends DocName>(name: N): FirestoreDataConverter<DocOf<N>> {
  const hit = cache.get(name);
  if (hit) return hit as FirestoreDataConverter<DocOf<N>>;
  const schema = DOC_SCHEMAS[name] as z.ZodTypeAny;
  const checkReads = isEmulated();
  const conv: FirestoreDataConverter<DocOf<N>> = {
    toFirestore(
      data: WithFieldValue<DocOf<N>> | PartialWithFieldValue<DocOf<N>>,
      options?: SetOptions,
    ): DocumentData {
      if (options && ('merge' in options || 'mergeFields' in options)) return data as DocumentData;
      // Sentinels (serverTimestamp, arrayUnion …) cannot be schema-checked; the write is trusted.
      if (Object.values(data as object).some((v) => v instanceof FieldValue))
        return data as DocumentData;
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        throw new Error(
          `Invalid ${name} document: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      return parsed.data as DocumentData;
    },
    fromFirestore(snap: QueryDocumentSnapshot): DocOf<N> {
      const data = snap.data();
      if (checkReads) {
        const parsed = schema.safeParse(data);
        if (!parsed.success) {
          console.warn(
            `[converters] ${snap.ref.path} does not match ${name}:`,
            parsed.error.issues.slice(0, 3),
          );
        }
      }
      return data as DocOf<N>;
    },
  };
  cache.set(name, conv as FirestoreDataConverter<unknown>);
  return conv;
}

/** A typed document reference. `path` comes from `paths.*` in @tm/shared. */
export function typedDoc<N extends DocName>(name: N, path: string): DocumentReference<DocOf<N>> {
  return db().doc(path).withConverter(converterFor(name));
}

/** A typed collection reference. */
export function typedCol<N extends DocName>(name: N, path: string): CollectionReference<DocOf<N>> {
  return db().collection(path).withConverter(converterFor(name));
}

/** A typed collection-group query (e.g. every `apiKeys` across users). */
export function typedGroup<N extends DocName>(name: N, collectionId: string) {
  return db().collectionGroup(collectionId).withConverter(converterFor(name));
}
