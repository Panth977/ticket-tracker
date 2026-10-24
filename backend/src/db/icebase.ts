/**
 * The IceBase adapter: firebase-admin's API (icebase-server/compat) over IceBase, which
 * validates every write against the schema (src/icebase/schema.ts), refuses queries whose
 * index is not declared, and runs on Firebase or on the IceBase server per TM_PLATFORM.
 */
import { DocumentReference, FieldPath, FieldValue, GeoPoint, Timestamp } from '@panth977/icebase-server/compat';
import { icebaseFirestore, icebaseRawFirestore } from '../icebase/app.js';
import type { Db, DbAdapter } from './types.js';

export const icebaseAdapter: DbAdapter = {
  name: 'icebase',
  db: () => icebaseFirestore() as unknown as Db,
  Timestamp: Timestamp as unknown as DbAdapter['Timestamp'],
  FieldValue: FieldValue as unknown as DbAdapter['FieldValue'],
  FieldPath: FieldPath as unknown as DbAdapter['FieldPath'],
  GeoPoint: GeoPoint as unknown as DbAdapter['GeoPoint'],
  DocumentReference: DocumentReference as unknown as DbAdapter['DocumentReference'],
};

/** No schema checks on writes (seeding legacy-shaped data in tests). */
export const icebaseRawDb = (): Db => icebaseRawFirestore() as unknown as Db;
