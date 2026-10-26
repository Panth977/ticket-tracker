/**
 * The IceBase app behind TaskManager's backend — every service goes through it. TM_ICEBASE picks
 * what it drives (runtime/platform.ts):
 *
 *   firebase  every service on Firebase, sharing the one firebase-admin app (adminApp.ts)
 *   emulator  TaskManager's functions inside the IceBase server (`icebase serve`), which tells
 *             them where it is (ICEBASE_EMULATOR_HOST) and its admin token (ICEBASE_ADMIN_TOKEN)
 *
 * ICEBASE_LEARN=<file> turns on IceBase's learning mode: an undeclared collection or index, or a
 * write that does not fit the schema, is appended to <file> (JSON lines) instead of refused.
 */
import { appendFileSync } from 'node:fs';
import { defineConfig } from '@panth977/icebase/config';
import type { IceBaseApp } from '@panth977/icebase/app';
import { initializeAdminApp } from '@panth977/icebase-server/admin';
import { getFirestore, type CompatIssue, type Firestore } from '@panth977/icebase-server/compat';
import { adminApp, projectId } from '../runtime/adminApp.js';
import { onIcebaseServer } from '../runtime/platform.js';
import { schema } from './schema.js';

export const icebaseConfig = defineConfig({
  name: 'taskmanager',
  schema,
  // The default bucket of the IceBase server (icebase.config.ts uses the same); on Firebase, the
  // shared firebase-admin app's own bucket is used.
  firebase: { projectId: projectId(), storageBucket: process.env.TM_STORAGE_BUCKET || `${projectId()}.appspot.com` },
  environments: { firebase: { mode: 'firebase' }, server: { mode: 'emulator' } },
});

/** The IceBase server these functions run in (TM_ICEBASE=emulator). */
function serverEmulator(): { origin: string; adminToken: string } {
  const host = process.env.ICEBASE_EMULATOR_HOST;
  const adminToken = process.env.ICEBASE_ADMIN_TOKEN;
  if (!host || !adminToken) throw new Error('TM_ICEBASE=emulator runs inside the IceBase server (`icebase serve`): ICEBASE_EMULATOR_HOST and ICEBASE_ADMIN_TOKEN are not set');
  return { origin: `http://${host.replace(/^https?:\/\//, '')}`, adminToken };
}

let app: IceBaseApp | undefined;
export function icebaseApp(): IceBaseApp {
  if (app) return app;
  if (onIcebaseServer()) return (app = initializeAdminApp(icebaseConfig, 'server', { name: 'taskmanager', emulator: serverEmulator() }));
  return (app = initializeAdminApp(icebaseConfig, 'firebase', { name: 'taskmanager', firebaseAdminApp: adminApp() }));
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
/** The same, without write validation (db/index.ts rawDb); on the IceBase server it skips its check too. */
export function icebaseRawFirestore(): Firestore {
  if (!onIcebaseServer()) return getFirestore(icebaseApp(), { validate: false, checkQueryValues: false });
  rawApp ??= initializeAdminApp(icebaseConfig, 'server', { name: 'taskmanager-raw', emulator: { ...serverEmulator(), unchecked: true } });
  return getFirestore(rawApp, { validate: false, checkQueryValues: false });
}
