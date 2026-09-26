/**
 * Firebase client configuration.
 *
 * The project is `demo-taskmanager`: the `demo-` prefix tells the Firebase SDKs
 * and the emulator suite that no real project exists, so everything runs
 * offline. PUBLIC_USE_EMULATORS switches the SDKs to the local emulators
 * (ports from firebase.json); when unset it defaults to ON for a demo- project,
 * because a demo project has nothing real to talk to.
 */
import { env } from '$env/dynamic/public';

export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  databaseURL: string;
  messagingSenderId: string;
  appId: string;
}

export interface EmulatorConfig {
  host: string;
  auth: number;
  firestore: number;
  database: number;
  storage: number;
  functions: number;
}

const projectId = env.PUBLIC_FIREBASE_PROJECT_ID || 'demo-taskmanager';

/** true/1/yes → on, false/0/no → off, unset → on for demo- projects. */
export function parseUseEmulators(raw: string | undefined, project: string): boolean {
  if (raw === undefined || raw === '') return project.startsWith('demo-');
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export const USE_EMULATORS = parseUseEmulators(env.PUBLIC_USE_EMULATORS, projectId);

const port = (v: string | undefined, fallback: number) =>
  v && /^\d+$/.test(v) ? Number(v) : fallback;

/**
 * Defaults are firebase.json's ports; PUBLIC_EMULATOR_*_PORT move them (e.g. when
 * another project's emulators already hold the defaults on this machine).
 */
export const EMULATORS: EmulatorConfig = {
  host: env.PUBLIC_EMULATOR_HOST || '127.0.0.1',
  auth: port(env.PUBLIC_EMULATOR_AUTH_PORT, 9209),
  firestore: port(env.PUBLIC_EMULATOR_FIRESTORE_PORT, 8380),
  database: port(env.PUBLIC_EMULATOR_DATABASE_PORT, 9300),
  storage: port(env.PUBLIC_EMULATOR_STORAGE_PORT, 9309),
  functions: port(env.PUBLIC_EMULATOR_FUNCTIONS_PORT, 5101),
};

export const FIREBASE_CONFIG: FirebaseClientConfig = {
  apiKey: env.PUBLIC_FIREBASE_API_KEY || 'demo-api-key',
  authDomain: env.PUBLIC_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
  projectId,
  storageBucket: env.PUBLIC_FIREBASE_STORAGE_BUCKET || `${projectId}.appspot.com`,
  databaseURL:
    env.PUBLIC_FIREBASE_DATABASE_URL || `https://${projectId}-default-rtdb.firebaseio.com`,
  messagingSenderId: env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '000000000000',
  appId: env.PUBLIC_FIREBASE_APP_ID || '1:000000000000:web:0000000000000000',
};
