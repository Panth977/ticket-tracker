/**
 * The SQLite adapter (TM_DB=sqlite). Files under TM_DB_DIR (default
 * ./data/db); TM_DB_DIR=':memory:' for tests. See store.ts for the layout
 * and db.ts for the semantics.
 */
import type { DbAdapter } from '../types.js';
import { DocRef, SqliteDb } from './db.js';
import { Store } from './store.js';
import { FieldPath, FieldValue, GeoPoint, Timestamp } from './values.js';

let instance: SqliteDb | undefined;

/** The process's SQLite database (opened on first use). */
export function sqliteDb(): SqliteDb {
  if (!instance) instance = new SqliteDb(new Store(process.env.TM_DB_DIR || './data/db'));
  return instance;
}

/** Close every file (tests, shutdown). The next sqliteDb() reopens. */
export function closeSqliteDb(): void {
  instance?.store.close();
  instance = undefined;
}

export const sqliteAdapter: DbAdapter = {
  name: 'sqlite',
  db: sqliteDb,
  Timestamp,
  FieldValue,
  FieldPath,
  GeoPoint,
  DocumentReference: DocRef as unknown as DbAdapter['DocumentReference'],
};

export { SqliteDb, type DocChange, type ChangeListener } from './db.js';
