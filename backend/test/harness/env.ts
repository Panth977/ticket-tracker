/**
 * Emulator wiring for tests — import FIRST (harness/index.ts does). Under
 * `firebase emulators:exec` (root `pnpm test:emu`) the hosts are already set;
 * otherwise they default to the ports in firebase.json so the suite also runs
 * against a separately started `pnpm emulators`.
 *
 * TM_QUEUE=memory: the api runs in-process here (no functions emulator to
 * dispatch Cloud Tasks to), so enqueued tasks are held for `queue().drain()`.
 */
export const PROJECT_ID = 'demo-taskmanager';

const defaults: Record<string, string> = {
  GCLOUD_PROJECT: PROJECT_ID,
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8380',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9209',
  FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:9300',
  FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9309',
  TM_QUEUE: 'memory',
  // Phase 17: GET /v1/live exchanges a custom token at the Auth emulator's Identity Toolkit (any key works).
  TM_WEB_API_KEY: 'demo-web-api-key',
};
for (const [k, v] of Object.entries(defaults)) process.env[k] ||= v;

export const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST!;
export const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST!;
