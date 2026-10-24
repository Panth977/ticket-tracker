/**
 * MIGRATION: a VM's own database (SQLite shards under TM_DATA_DIR/db) → IceBase
 * (TM_DATA_DIR/icebase, the embedded IceBase server TM_DB=icebase runs on).
 *
 * Every document is copied with its whole tree of subcollections, each one checked against
 * the IceBase schema (src/icebase/schema.ts) on the way in. A document that does not fit is
 * reported, and copied anyway only with `unchecked` (it then stays as it was, unvalidated).
 * Running it again overwrites with the same data: it is safe to repeat. The check at the
 * end reads both stores back and compares every document (count and content hash).
 *
 * Blobs (TM_DATA_DIR/blobs), the Realtime Database tree and Google Drive boards stay where
 * they are: TM_BLOB / TM_RTDB keep their local adapters, and Drive is Drive.
 */
import { createHash } from 'node:crypto';
import { IceBaseError } from '@panth977/icebase/errors';
import { Timestamp as IbTimestamp, GeoPoint as IbGeoPoint } from '@panth977/icebase/internal';
import { matchCollectionPath, validateWrite } from '@panth977/icebase/schema';
import type { Firestore as Compat } from '@panth977/icebase-server/compat';
import type { Db, DocumentReference, DocumentSnapshot } from '../db/types.js';
import { icebaseConfig } from '../icebase/app.js';

export interface IcebaseMigrationOptions {
  /** The source: TM's SQLite database (sqliteDb()). */
  source: Db;
  /** The target: IceBase's Firestore (compat) — validated, and the unchecked one. */
  target: Compat;
  raw: Compat;
  /** false: read and check only (nothing written). */
  apply: boolean;
  /** Copy documents that do not fit the schema as they are (else they are reported and left out). */
  unchecked?: boolean;
  log?: (line: string) => void;
}

export interface IcebaseMigrationSummary {
  documents: number;
  copied: number;
  /** Documents that do not fit the schema: path → why. */
  invalid: { path: string; why: string }[];
  /** Collections (as path templates) and how many documents each had. */
  collections: Record<string, number>;
  /** After apply: documents whose copy differs from the source, or is missing. */
  mismatched: string[];
}

/** A source value → IceBase's (the SQLite classes look alike but are other classes). */
function toIceBase(v: unknown, target: Compat): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Uint8Array) return v;
  if (v instanceof Date) return IbTimestamp.fromDate(v);
  const o = v as Record<string, unknown>;
  if (typeof o.toMillis === 'function' && typeof o.seconds === 'number' && typeof o.nanoseconds === 'number') return new IbTimestamp(o.seconds, o.nanoseconds as number);
  if (typeof o.latitude === 'number' && typeof o.longitude === 'number' && typeof o.isEqual === 'function') return new IbGeoPoint(o.latitude, o.longitude as number);
  if (typeof o.path === 'string' && typeof o.collection === 'function') return target.doc(o.path);
  if (Array.isArray(v)) return v.map((x) => toIceBase(x, target));
  return Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined).map(([k, x]) => [k, toIceBase(x, target)]));
}

/** A stable content hash of a document (keys sorted; timestamps, refs and points by value). */
export function docHash(data: unknown): string {
  const canon = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    if (typeof o.toMillis === 'function' && typeof o.seconds === 'number') return { $ts: [o.seconds, o.nanoseconds] };
    if (typeof o.latitude === 'number' && typeof o.longitude === 'number') return { $geo: [o.latitude, o.longitude] };
    if (typeof o.path === 'string' && (typeof o.collection === 'function' || o.type === 'document')) return { $ref: o.path };
    if (v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString('base64') };
    if (Array.isArray(v)) return v.map(canon);
    return Object.fromEntries(Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => [k, canon(o[k])]));
  };
  return createHash('sha256').update(JSON.stringify(canon(data))).digest('hex');
}

const template = (collectionPath: string) => matchCollectionPath(icebaseConfig.schema, collectionPath)?.collection.path ?? `(undeclared) ${collectionPath}`;

export async function migrateToIcebase(o: IcebaseMigrationOptions): Promise<IcebaseMigrationSummary> {
  const log = o.log ?? (() => {});
  const sum: IcebaseMigrationSummary = { documents: 0, copied: 0, invalid: [], collections: {}, mismatched: [] };
  const hashes = new Map<string, string>();

  // Collections depth first; a document's subcollections right after it.
  type Col = { path: string; list(): Promise<DocumentReference[]> };
  const roots = await o.source.listCollections();
  const queue: Col[] = roots.map((c) => ({ path: c.path, list: () => c.listDocuments() as Promise<DocumentReference[]> }));

  let batch: { path: string; data: Record<string, unknown>; raw: boolean }[] = [];
  const flush = async () => {
    if (!o.apply || !batch.length) return void (batch = []);
    const checked = o.target.batch();
    const raw = o.raw.batch();
    let nc = 0;
    let nr = 0;
    for (const w of batch) {
      if (w.raw) (raw.set(o.raw.doc(w.path), w.data), nr++);
      else (checked.set(o.target.doc(w.path), w.data), nc++);
    }
    if (nc) await checked.commit();
    if (nr) await raw.commit();
    sum.copied += batch.length;
    batch = [];
  };

  while (queue.length) {
    const col = queue.shift()!;
    const refs = await col.list();
    const t = template(col.path);
    for (const ref of refs) {
      const snap = (await ref.get()) as DocumentSnapshot;
      // A document that only holds subcollections has no data of its own.
      if (snap.exists) {
        sum.documents++;
        sum.collections[t] = (sum.collections[t] ?? 0) + 1;
        const data = toIceBase(snap.data(), o.target) as Record<string, unknown>;
        hashes.set(ref.path, docHash(data));
        let ok = true;
        const m = matchCollectionPath(icebaseConfig.schema, col.path);
        try {
          if (!m) throw new IceBaseError('invalid-argument', `${col.path} is not a collection in the schema`);
          validateWrite(m.collection, data, 'set');
        } catch (e) {
          ok = false;
          sum.invalid.push({ path: ref.path, why: (e as Error).message.split('\n').slice(0, 4).join(' / ') });
        }
        if (ok || o.unchecked) batch.push({ path: ref.path, data, raw: !ok });
        if (batch.length >= 400) await flush();
      }
      for (const sub of await ref.listCollections()) queue.push({ path: sub.path, list: () => sub.listDocuments() as Promise<DocumentReference[]> });
    }
    log(`${col.path}: ${refs.length} document(s)`);
  }
  await flush();

  if (o.apply) {
    // Read every copied document back and compare.
    for (const [path, h] of hashes) {
      if (sum.invalid.some((i) => i.path === path) && !o.unchecked) continue;
      const s = await o.raw.doc(path).get();
      if (!s.exists || docHash(s.data()) !== h) sum.mismatched.push(path);
    }
  }
  return sum;
}
