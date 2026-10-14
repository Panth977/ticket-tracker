/**
 * The Firestore adapter: the Admin SDK itself. The port (types.ts) is a
 * subset of its API, so there is no wrapper — the Firebase deploy runs
 * exactly the calls it ran before the port existed.
 */
import {
  DocumentReference,
  FieldPath,
  FieldValue,
  GeoPoint,
  getFirestore,
  Timestamp,
  type Firestore,
} from 'firebase-admin/firestore';
import { adminApp } from '../runtime/adminApp.js';
import type { Db, DbAdapter } from './types.js';

let firestore: Firestore | undefined;

function db(): Db {
  if (!firestore) {
    firestore = getFirestore(adminApp());
    // Commands write optional fields as `undefined` freely (zod output); drop them
    // instead of throwing. Must be set before the first read/write.
    firestore.settings({ ignoreUndefinedProperties: true });
  }
  return firestore as unknown as Db;
}

export const firestoreAdapter: DbAdapter = {
  name: 'firestore',
  db,
  Timestamp: Timestamp as unknown as DbAdapter['Timestamp'],
  FieldValue: FieldValue as unknown as DbAdapter['FieldValue'],
  FieldPath: FieldPath as unknown as DbAdapter['FieldPath'],
  GeoPoint: GeoPoint as unknown as DbAdapter['GeoPoint'],
  DocumentReference: DocumentReference as unknown as DbAdapter['DocumentReference'],
};
