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

export type * from './types.js';

const adapter: DbAdapter = icebaseAdapter;

/**
 * The database without schema checks, for seeding data a test means to be invalid or legacy
 * (a migration test).
 */
export function rawDb(): Db {
  return icebaseRawDb();
}

/** The database. Lazy: importing a module never opens a connection. */
export function db(): Db {
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
