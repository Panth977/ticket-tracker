/**
 * The IceBase app behind TaskManager's backend. TM_PLATFORM picks the environment:
 * 'firebase' runs every service on Firebase (sharing the one firebase-admin app, adminApp.ts);
 * 'vm' runs them on the IceBase server.
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
import { platform } from '../runtime/platform.js';
import { schema } from './schema.js';

export const icebaseConfig = defineConfig({
  name: 'taskmanager',
  schema,
  firebase: { projectId: projectId() },
  environments: { firebase: { mode: 'firebase' }, vm: { mode: 'emulator' } },
});

let app: IceBaseApp | undefined;
export function icebaseApp(): IceBaseApp {
  return (app ??= initializeAdminApp(icebaseConfig, platform(), { name: 'taskmanager', firebaseAdminApp: adminApp() }));
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

/** The same, without write validation (db/index.ts rawDb). */
export function icebaseRawFirestore(): Firestore {
  return getFirestore(icebaseApp(), { validate: false, checkQueryValues: false });
}
