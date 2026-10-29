/**
 * The database — IceBase (src/icebase), on Firebase or on the IceBase server (TM_ICEBASE). Every
 * write is checked against the schema (icebase/schema.ts) and every query needs its index
 * declared (icebase/indexes.ts).
 *
 * Everything above this file imports db(), the value classes and the types from here.
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
import { icebaseAdapter, icebaseRawDb } from './icebase.js';
import { RoutedDb } from './drive/router.js';

export type * from './types.js';

const adapter: DbAdapter = icebaseAdapter;

/**
 * The database without schema checks, for seeding data a test means to be invalid or legacy
 * (a migration test).
 */
export function rawDb(): Db {
  return icebaseRawDb();
}

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
  // Emergency switch: TM_NO_TICKET_ROUTER=1 serves every path from the adapter
  // (Drive boards then read as empty — for diagnosing, never for running).
  if (process.env.TM_NO_TICKET_ROUTER === '1') return base;
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
