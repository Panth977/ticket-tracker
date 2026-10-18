/**
 * The database, behind one port (types.ts). TM_DB (else TM_PLATFORM) picks
 * the adapter once, at startup:
 *
 *   'firestore' (firebase)      Cloud Firestore through the Admin SDK (the
 *                               Firebase deploy; emulator-aware as before)
 *   'sqlite' (vm)               SQLite files under TM_DB_DIR (the VM / Docker
 *                               deploy) — see src/db/sqlite/
 *
 * Everything above this file imports db(), the value classes and the types
 * from here. Nothing above it knows which store is underneath.
 */
import type {
  DbAdapter,
  Db,
  DocumentData,
  DocumentReference as DocumentReferenceT,
  FieldPath as FieldPathT,
  FieldPathStatic,
  FieldValue as FieldValueT,
  FieldValueStatic,
  GeoPoint as GeoPointT,
  GeoPointStatic,
  Timestamp as TimestampT,
  TimestampStatic,
} from './types.js';
import { firestoreAdapter } from './firestore.js';
import { sqliteAdapter } from './sqlite/index.js';
import { RoutedDb } from './drive/router.js';
import { adapterFor } from '../runtime/platform.js';

export type * from './types.js';

export type DbKind = 'firestore' | 'sqlite';

/** The store this process uses: TM_DB, else the platform's (runtime/platform.ts). */
export function dbKind(): DbKind {
  return adapterFor<DbKind>('TM_DB', { firebase: 'firestore', vm: 'sqlite' }, [
    'firestore',
    'sqlite',
  ]);
}

const adapter: DbAdapter = dbKind() === 'sqlite' ? sqliteAdapter : firestoreAdapter;

let routed: { base: Db; db: RoutedDb } | undefined;

/**
 * The database. Lazy: importing a module never opens a connection.
 *
 * Every path under boards/{b}/tickets/ goes through the ticket router
 * (drive/router.ts): a board whose tickets live in Google Drive is read and
 * written there; every other board's calls are the adapter's own.
 */
export function db(): Db {
  const base = adapter.db();
  if (routed?.base !== base) routed = { base, db: new RoutedDb(base, adapter.Timestamp) };
  return routed.db;
}

/** The adapter itself, without the ticket router (the router's own reads, migrations). */
export function baseDb(): Db {
  return adapter.db();
}

export const adapterName = adapter.name;

// The value classes of the active store. Same names as the Admin SDK's so a
// call site reads the same either way: FieldValue.increment(1), new FieldPath('a', 'b'),
// Timestamp.fromMillis(ms), `v instanceof Timestamp`.
export const Timestamp: TimestampStatic = adapter.Timestamp;
export type Timestamp = TimestampT;
export const FieldValue: FieldValueStatic = adapter.FieldValue;
export type FieldValue = FieldValueT;
export const FieldPath: FieldPathStatic = adapter.FieldPath;
export type FieldPath = FieldPathT;
export const GeoPoint: GeoPointStatic = adapter.GeoPoint;
export type GeoPoint = GeoPointT;
/** For `value instanceof DocumentReference` (a reference stored as a field value). */
export const DocumentReference = adapter.DocumentReference;
export type DocumentReference<T = DocumentData> = DocumentReferenceT<T>;
