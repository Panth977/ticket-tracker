/**
 * Admin SDK bootstrap — the ONE place firebase-admin is initialised.
 *
 * Emulator-aware without any branching of our own: the Admin SDK reads
 * FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST / FIREBASE_DATABASE_EMULATOR_HOST /
 * FIREBASE_STORAGE_EMULATOR_HOST / CLOUD_TASKS_EMULATOR_HOST itself. We only
 * make sure a project id exists when running outside the Functions runtime
 * (vitest, scripts): the `demo-` prefix keeps every emulator fully offline.
 *
 * Everything is lazy so importing a module never touches the network, and
 * unit tests that never call db() never need an emulator.
 */
import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getDatabase, type Database } from 'firebase-admin/database';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getFunctions, type Functions } from 'firebase-admin/functions';
import { getStorage, type Storage } from 'firebase-admin/storage';

export const DEMO_PROJECT_ID = 'demo-taskmanager';

/** The project id: the Functions runtime sets GCLOUD_PROJECT; local tooling falls back to the demo project. */
export function projectId(): string {
  return process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || DEMO_PROJECT_ID;
}

/** True when any Firebase emulator is wired in (dev, tests, CI). Adapters use it to pick dev fakes. */
export function isEmulated(): boolean {
  return (
    process.env.FUNCTIONS_EMULATOR === 'true' ||
    !!process.env.FIRESTORE_EMULATOR_HOST ||
    !!process.env.FIREBASE_AUTH_EMULATOR_HOST ||
    projectId().startsWith('demo-')
  );
}

let app: App | undefined;
let firestore: Firestore | undefined;

export function adminApp(): App {
  if (app) return app;
  app = getApps()[0];
  if (!app && process.env.FIREBASE_CONFIG && !isEmulated()) {
    // Deployed: FIREBASE_CONFIG (set by the Functions runtime) carries the real
    // databaseURL (an RTDB outside the US lives on *.firebasedatabase.app) and
    // the default bucket (*.firebasestorage.app for newer projects) — guessing
    // them here would be wrong. TM_DATABASE_URL / TM_STORAGE_BUCKET override.
    const cfg = JSON.parse(process.env.FIREBASE_CONFIG) as {
      databaseURL?: string;
      storageBucket?: string;
    };
    const databaseURL = process.env.TM_DATABASE_URL || cfg.databaseURL;
    const storageBucket = process.env.TM_STORAGE_BUCKET || cfg.storageBucket;
    initializeApp({
      projectId: projectId(),
      ...(databaseURL ? { databaseURL } : {}),
      ...(storageBucket ? { storageBucket } : {}),
    });
    app = getApps()[0]!;
  }
  if (!app) {
    const pid = projectId();
    initializeApp({
      projectId: pid,
      // Needed by getDatabase(); in the emulator the namespace is `${project}-default-rtdb`.
      databaseURL:
        process.env.FIREBASE_DATABASE_URL ??
        (process.env.FIREBASE_DATABASE_EMULATOR_HOST
          ? `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${pid}-default-rtdb`
          : `https://${pid}-default-rtdb.firebaseio.com`),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET ?? `${pid}.appspot.com`,
    });
    app = getApps()[0]!;
  }
  return app;
}

export function db(): Firestore {
  if (firestore) return firestore;
  firestore = getFirestore(adminApp());
  // Commands write optional fields as `undefined` freely (zod output); drop them
  // instead of throwing. Must be set before the first read/write.
  firestore.settings({ ignoreUndefinedProperties: true });
  return firestore;
}

export const auth = (): Auth => getAuth(adminApp());
export const rtdbAdmin = (): Database => getDatabase(adminApp());
export const storageAdmin = (): Storage => getStorage(adminApp());
export const functionsAdmin = (): Functions => getFunctions(adminApp());
