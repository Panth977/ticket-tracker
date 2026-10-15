/** The port suite on the SQLite adapter, in memory and on disk (no emulator needed). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { sqliteAdapter } from '../../src/db/sqlite/index.js';
import { SqliteDb } from '../../src/db/sqlite/db.js';
import { Store } from '../../src/db/sqlite/store.js';
import type { DbAdapter } from '../../src/db/types.js';
import { portSuite } from './suite.js';

const bucket = new SqliteDb(new Store(':memory:'));
portSuite('sqlite (bucket)', (): DbAdapter => ({ ...sqliteAdapter, db: () => bucket }));

const dir = mkdtempSync(join(tmpdir(), 'tm-db-'));
const disk = new SqliteDb(new Store(dir));
portSuite('sqlite (files)', (): DbAdapter => ({ ...sqliteAdapter, db: () => disk }));

afterAll(() => {
  bucket.store.close();
  disk.store.close();
  rmSync(dir, { recursive: true, force: true });
});
