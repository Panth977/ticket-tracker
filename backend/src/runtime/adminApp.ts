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

export const DEMO_PROJECT_ID = 'demo-taskmanager';

/** The project id: the Functions runtime sets GCLOUD_PROJECT; local tooling falls back to the demo project. */
export function projectId(): string {
  return process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || DEMO_PROJECT_ID;
}

/**
 * True when any Firebase emulator is wired in (dev, tests, CI). Adapters use
 * it to pick dev fakes. A VM (TM_PLATFORM=vm) has no project id, so the
 * `demo-` fallback must not count there — only real emulator hosts, or
 * TM_DEV=1 for a local dev box — else production would sign with the dev key.
 */
export function isEmulated(): boolean {
  const emulatorHosts =
    process.env.FUNCTIONS_EMULATOR === 'true' ||
    !!process.env.FIRESTORE_EMULATOR_HOST ||
    !!process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if ((process.env.TM_PLATFORM || '').toLowerCase() === 'vm')
    return emulatorHosts || process.env.TM_DEV === '1';
  return emulatorHosts || projectId().startsWith('demo-');
}

let app: App | undefined;

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
