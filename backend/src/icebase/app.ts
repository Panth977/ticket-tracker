/**
 * The IceBase app behind TaskManager's backend. TM_PLATFORM picks the environment:
 * 'firebase' runs every service on Firebase (sharing the one firebase-admin app, adminApp.ts);
 * 'vm' runs them on the IceBase server.
 *
 * ICEBASE_LEARN=<file> turns on IceBase's learning mode: an undeclared collection or index, or a
 * write that does not fit the schema, is appended to <file> (JSON lines) instead of refused.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { defineConfig } from '@panth977/icebase/config';
import { registerEmbedded, type IceBaseApp } from '@panth977/icebase/app';
import { decode } from '@panth977/icebase/internal';
import type { RunningEmulator } from '@panth977/icebase-cli/emulator';
import { initializeAdminApp } from '@panth977/icebase-server/admin';
import { getFirestore, type CompatIssue, type Firestore } from '@panth977/icebase-server/compat';
import { adminApp, projectId } from '../runtime/adminApp.js';
import { dataDir, platform } from '../runtime/platform.js';
import { schema } from './schema.js';

export const icebaseConfig = defineConfig({
  name: 'taskmanager',
  schema,
  firebase: { projectId: projectId() },
  environments: { firebase: { mode: 'firebase' }, vm: { mode: 'emulator' } },
});

// ─── vm: the IceBase server, embedded ──────────────────────────────────────────
//
// On a VM the IceBase server runs inside this process (no port of its own): its SQLite file,
// its rules, its schema checks. TM_DATA_DIR/icebase holds its data; the admin token is made once
// and kept there, so nothing reaches the data without it.

const EMBEDDED = 'taskmanager';
let server: Promise<RunningEmulator> | undefined;

function adminToken(dir: string): string {
  const file = join(dir, 'admin-token');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600 });
  return readFileSync(file, 'utf8').trim();
}

/** The embedded IceBase server (vm), started on first use. */
export function icebaseServer(): Promise<RunningEmulator> {
  if (server) return server;
  const dir = join(dataDir(), 'icebase');
  mkdirSync(dir, { recursive: true });
  const token = adminToken(dir);
  server = import('@panth977/icebase-cli/emulator').then((m) =>
    m.startEmulator({ config: icebaseConfig, env: 'vm', dataDir: dir, listen: false, name: EMBEDDED, adminToken: token, without: ['auth', 'database', 'storage', 'functions', 'customAuth'], log: () => {} }),
  );
  // Calls made before it is up wait for it.
  registerEmbedded(EMBEDDED, async (req) => (await server!).handler(req));
  return server;
}

let app: IceBaseApp | undefined;
export function icebaseApp(): IceBaseApp {
  if (app) return app;
  if (platform() === 'vm') {
    void icebaseServer();
    const dir = join(dataDir(), 'icebase');
    return (app = initializeAdminApp(icebaseConfig, 'vm', { name: 'taskmanager', emulator: { embedded: EMBEDDED, adminToken: adminToken(dir) } }));
  }
  return (app = initializeAdminApp(icebaseConfig, 'firebase', { name: 'taskmanager', firebaseAdminApp: adminApp() }));
}

/** A committed document change (vm): what the local triggers and live listeners hang off. */
export interface IcebaseChange {
  id: string;
  path: string;
  collectionId: string;
  time: number;
  before: Record<string, unknown> | undefined;
  after: Record<string, unknown> | undefined;
}

/** Every committed change of the embedded server's documents, decoded to IceBase values. */
export function onIcebaseChanges(listener: (changes: IcebaseChange[]) => void): () => void {
  let off: (() => void) | null = null;
  let stopped = false;
  void icebaseServer().then((emu) => {
    if (stopped) return;
    const fs = icebaseFirestore();
    const toRef = (p: string) => fs.doc(p);
    off = emu.context.firestore.onChanges((changes) =>
      listener(
        changes.map((c) => {
          const v = c.after ?? c.before;
          return {
            id: `${c.path}@${v?.version ?? 0}:${randomBytes(4).toString('hex')}`,
            path: c.path,
            collectionId: c.collectionId,
            time: Date.now(),
            before: c.before ? (decode(c.before.data, toRef) as Record<string, unknown>) : undefined,
            after: c.after ? (decode(c.after.data, toRef) as Record<string, unknown>) : undefined,
          };
        }),
      ),
    );
  });
  return () => {
    stopped = true;
    off?.();
  };
}

const seen = new Set<string>();
function learn(file: string) {
  return (i: CompatIssue) => {
    const key = `${i.kind}|${i.collection}|${i.suggestion ?? i.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    appendFileSync(file, `${JSON.stringify(i)}\n`);
  };
}

let fs: Firestore | undefined;
/** firebase-admin's Firestore API, over IceBase. */
export function icebaseFirestore(): Firestore {
  const file = process.env.ICEBASE_LEARN;
  return (fs ??= getFirestore(icebaseApp(), file ? { learn: learn(file) } : {}));
}

let rawApp: IceBaseApp | undefined;
/** The same, without write validation (db/index.ts rawDb) — on the VM, the server skips its check too. */
export function icebaseRawFirestore(): Firestore {
  if (platform() !== 'vm') return getFirestore(icebaseApp(), { validate: false, checkQueryValues: false });
  icebaseApp();
  const dir = join(dataDir(), 'icebase');
  rawApp ??= initializeAdminApp(icebaseConfig, 'vm', { name: 'taskmanager-raw', emulator: { embedded: EMBEDDED, adminToken: adminToken(dir), unchecked: true } });
  return getFirestore(rawApp, { validate: false, checkQueryValues: false });
}
