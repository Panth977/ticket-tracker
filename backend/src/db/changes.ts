/**
 * The change feed of a store that has no Cloud Functions behind it (the VM): every committed
 * document change, decoded, with a snapshot maker for trigger events. SQLite announces its own
 * (db/sqlite); the embedded IceBase server announces its (icebase/app.ts).
 */
import { dbKind, db, type DocumentData } from './index.js';
import { sqliteDb } from './sqlite/index.js';
import { onIcebaseChanges } from '../icebase/app.js';

export interface DocChange {
  /** Unique per change (an event id). */
  id: string;
  path: string;
  collectionId: string;
  /** Epoch ms of the commit. */
  time: number;
  /** The document before / after, decoded (undefined: absent). */
  before: DocumentData | undefined;
  after: DocumentData | undefined;
}

/** A trigger event's snapshot of one side of a change. */
export function changeSnapshot(path: string, data: DocumentData | undefined) {
  const ref = db().doc(path);
  return { exists: data !== undefined, id: ref.id, ref, data: () => data, get: (f: string) => data?.[f] };
}

/** Listen to every committed change; null when this store has no feed (Firestore: Cloud Functions do it). */
export function onDocChanges(listener: (changes: DocChange[]) => void): (() => void) | null {
  const kind = dbKind();
  if (kind === 'sqlite') {
    const s = sqliteDb();
    return s.onChange((changes) =>
      listener(
        changes.map((c) => ({
          ...c,
          before: c.before === undefined ? undefined : (s.decodeDoc(c.path, c.before) as DocumentData),
          after: c.after === undefined ? undefined : (s.decodeDoc(c.path, c.after) as DocumentData),
        })),
      ),
    );
  }
  if (kind === 'icebase' && (process.env.TM_PLATFORM || '').toLowerCase() === 'vm') return onIcebaseChanges(listener);
  return null;
}
