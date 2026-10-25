/**
 * MIGRATION: a VM's own data (TM_DATA_DIR) → the IceBase server's (TM_DATA_DIR/icebase), what
 * `icebase serve` runs TaskManager on (TM_PLATFORM=icebase, icebase.config.ts):
 *
 *   documents   SQLite shards (db/) → IceBase's Firestore, each checked against the schema
 *               (./icebase.ts), less the VM's own sign-in store (_auth*)
 *   people      _authUsers → IceBase's auth, uids kept (a password keeps working; e-mail-link
 *               people sign in as before); sessions are not moved: everyone signs in once more
 *   files       the disk store (blobs/) → IceBase's storage, metadata and download tokens kept
 *   realtime    rtdb.json → IceBase's Realtime Database
 *
 * Nothing of the VM's data is changed: going back is running the VM build again. Running it
 * again overwrites with the same data. Every part is read back and compared at the end.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { IceBaseApp } from '@panth977/icebase/app';
import { emulatorDatabaseDriver } from '@panth977/icebase/internal';
import type { RunningEmulator } from '@panth977/icebase-cli/emulator';
import { getAdminStorage, importAuthUsers, initializeAdminApp, type ImportedUser } from '@panth977/icebase-server/admin';
import { getFirestore } from '@panth977/icebase-server/compat';
import type { Db } from '../db/types.js';
import { icebaseConfig } from '../icebase/app.js';
import { migrateToIcebase, type IcebaseMigrationSummary } from './icebase.js';

/** The VM's sign-in store: people move to IceBase's auth; links and sessions are not kept. */
export const LOCAL_AUTH_COLLECTIONS = ['_authUsers', '_authEmails', '_authLinks', '_authSessions'];

export interface ServerMigrationOptions {
  /** The VM's SQLite database. */
  source: Db;
  /** TM_DATA_DIR of the VM (blobs/, rtdb.json); the IceBase server's data goes to <dataDir>/icebase. */
  dataDir: string;
  /** TM_BLOB_DIR when it is not <dataDir>/blobs. */
  blobDir?: string;
  apply: boolean;
  unchecked?: boolean;
  log?: (line: string) => void;
}

export interface ServerMigrationSummary {
  documents: IcebaseMigrationSummary;
  people: { found: number; imported: number; failed: { uid: string; error: string }[] };
  files: { found: number; bytes: number; copied: number; mismatched: string[] };
  realtime: { found: boolean; keys: number; matches: boolean | null };
}

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** Every object of the disk store: bucket, name, the bytes' file and its metadata. */
function diskObjects(dir: string): { bucket: string; name: string; file: string; meta: { contentType?: string; metadata?: Record<string, string> } }[] {
  if (!existsSync(dir)) return [];
  const out: ReturnType<typeof diskObjects> = [];
  for (const bucket of readdirSync(dir)) {
    const root = join(dir, bucket, 'o');
    if (!existsSync(root)) continue;
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) walk(f);
        else {
          const name = relative(root, f).split('\\').join('/');
          const mf = join(dir, bucket, 'm', `${name}.json`);
          out.push({ bucket, name, file: f, meta: existsSync(mf) ? (JSON.parse(readFileSync(mf, 'utf8')) as { contentType?: string; metadata?: Record<string, string> }) : {} });
        }
      }
    };
    walk(root);
  }
  return out;
}

const ms = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && typeof (v as { toMillis?: unknown }).toMillis === 'function') return (v as { toMillis(): number }).toMillis();
  if (typeof v === 'string' && v) return Date.parse(v) || Number(v) || undefined;
  return undefined;
};

export async function migrateToIcebaseServer(o: ServerMigrationOptions): Promise<ServerMigrationSummary> {
  const log = o.log ?? (() => {});
  const icebaseDir = join(o.dataDir, 'icebase');
  // The IceBase server, on a loopback port of its own for the copy (its functions do not run:
  // nothing fires while the data moves in). The admin token is one-off.
  const { startEmulator } = await import('@panth977/icebase-cli/emulator');
  const adminToken = sha(`${Date.now()}${Math.random()}`);
  const server: RunningEmulator = await startEmulator({ config: icebaseConfig, env: 'server', root: process.cwd(), dataDir: o.apply ? icebaseDir : ':memory:', port: 0, host: '127.0.0.1', adminToken, without: ['functions', 'customAuth', 'messaging'], log: () => {} });
  const name = `tm-migrate-${server.port}`;
  const app: IceBaseApp = initializeAdminApp(icebaseConfig, 'server', { name, emulator: { origin: server.url, adminToken } });
  const raw: IceBaseApp = initializeAdminApp(icebaseConfig, 'server', { name: `${name}-raw`, emulator: { origin: server.url, adminToken, unchecked: true } });
  try {
    // ── documents ──
    const documents = await migrateToIcebase({
      source: o.source,
      target: getFirestore(app),
      raw: getFirestore(raw, { validate: false, checkQueryValues: false }),
      apply: o.apply,
      ...(o.unchecked ? { unchecked: true } : {}),
      skip: LOCAL_AUTH_COLLECTIONS,
      log,
    });

    // ── people ──
    const accounts = await o.source.collection('_authUsers').get();
    const users: ImportedUser[] = accounts.docs.map((d) => {
      const a = d.data() as Record<string, unknown>;
      return {
        uid: d.id,
        ...(typeof a.email === 'string' ? { email: a.email } : {}),
        emailVerified: !!a.emailVerified,
        ...(typeof a.displayName === 'string' ? { displayName: a.displayName } : {}),
        ...(typeof a.photoURL === 'string' ? { photoURL: a.photoURL } : {}),
        ...(typeof a.passwordHash === 'string' && a.passwordHash ? { passwordHash: a.passwordHash } : {}),
        disabled: !!a.disabled,
        ...(a.customClaims && typeof a.customClaims === 'object' ? { customClaims: a.customClaims as Record<string, unknown> } : {}),
        providers: Array.isArray(a.providers) ? (a.providers as string[]) : [],
        ...(ms(a.createdAt) ? { createdAt: ms(a.createdAt)! } : {}),
        ...(ms(a.lastSignInAt) ? { lastSignInAt: ms(a.lastSignInAt)! } : {}),
      };
    });
    const people: ServerMigrationSummary['people'] = { found: users.length, imported: 0, failed: [] };
    if (o.apply && users.length) {
      for (const r of await importAuthUsers(app, users, { overwrite: true })) {
        if (r.ok) people.imported++;
        else people.failed.push({ uid: r.uid, error: r.error ?? 'failed' });
      }
    }
    log(`people: ${users.length} found${o.apply ? `, ${people.imported} imported` : ''}`);

    // ── files ──
    const objects = diskObjects(o.blobDir ?? join(o.dataDir, 'blobs'));
    const files: ServerMigrationSummary['files'] = { found: objects.length, bytes: 0, copied: 0, mismatched: [] };
    const bucket = getAdminStorage(app).bucket(icebaseConfig.firebase?.storageBucket);
    for (const x of objects) {
      const bytes = readFileSync(x.file);
      files.bytes += bytes.length;
      if (!o.apply) continue;
      // Every disk bucket was the deploy's default one.
      const f = bucket.file(x.name);
      await f.save(bytes, { resumable: false, contentType: x.meta.contentType ?? 'application/octet-stream', ...(x.meta.metadata ? { metadata: { metadata: x.meta.metadata } } : {}) });
      const [back] = await f.download();
      if (sha(back) === sha(bytes)) files.copied++;
      else files.mismatched.push(x.name);
    }
    log(`files: ${objects.length} found (${files.bytes} bytes)${o.apply ? `, ${files.copied} copied` : ''}`);

    // ── realtime database ──
    const treeFile = join(o.dataDir, 'rtdb.json');
    const realtime: ServerMigrationSummary['realtime'] = { found: existsSync(treeFile), keys: 0, matches: null };
    if (realtime.found) {
      const tree = JSON.parse(readFileSync(treeFile, 'utf8')) as Record<string, unknown> | null;
      realtime.keys = tree && typeof tree === 'object' ? Object.keys(tree).length : 0;
      if (o.apply) {
        const rtdb = emulatorDatabaseDriver(app);
        await rtdb.set('', tree ?? null);
        const back = (await rtdb.get('', null)).value;
        const canon = (v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
        realtime.matches = JSON.stringify(canon(back)) === JSON.stringify(canon(tree));
      }
    }
    log(`realtime database: ${realtime.found ? `${realtime.keys} top-level keys` : 'no rtdb.json'}${realtime.matches === null ? '' : realtime.matches ? ', identical after copy' : ', DIFFERENT after copy'}`);

    // Read the people back.
    if (o.apply) {
      const { getAdminAuth } = await import('@panth977/icebase-server/admin');
      for (const u of users) {
        try {
          const got = await getAdminAuth(app).getUser(u.uid);
          if ((got.email ?? undefined) !== (u.email?.toLowerCase() ?? undefined)) people.failed.push({ uid: u.uid, error: 'email differs after import' });
        } catch (e) {
          people.failed.push({ uid: u.uid, error: (e as Error).message });
        }
      }
    }
    return { documents, people, files, realtime };
  } finally {
    const { deleteApp } = await import('@panth977/icebase/app');
    await deleteApp(app);
    await deleteApp(raw);
    await server.close();
  }
}
