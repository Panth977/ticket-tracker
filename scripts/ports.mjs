/**
 * This project's dedicated local port block — ONE place for scripts to read it.
 * The emulator ports themselves live in firebase.json (the Firebase CLI reads
 * them there); this module re-exports them next to the web dev port so dev,
 * seed and e2e never hard-code a number.
 *
 * Other copies that must agree (they cannot import this file):
 *   frontend/src/lib/firebase/config.ts   PUBLIC_EMULATOR_*_PORT defaults
 *   frontend/vite.config.ts               server.port 5190, functions proxy 5101
 *   backend/test/harness/env.ts           *_EMULATOR_HOST defaults
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const emu = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf8')).emulators;

export const PROJECT_ID = 'demo-taskmanager';
export const HOST = '127.0.0.1';
export const PORTS = {
  web: Number(process.env.TM_WEB_PORT || 5190),
  /** Local webhook receiver (dev sink; the e2e suite listens here). */
  webhookSink: 5199,
  ui: emu.ui.port,
  hub: emu.hub.port,
  auth: emu.auth.port,
  firestore: emu.firestore.port,
  database: emu.database.port,
  storage: emu.storage.port,
  functions: emu.functions.port,
  hosting: emu.hosting.port,
  tasks: emu.tasks.port,
};

export const URLS = {
  web: `http://${HOST}:${PORTS.web}`,
  api: `http://${HOST}:${PORTS.functions}/${PROJECT_ID}/us-central1/api`,
  ui: `http://${HOST}:${PORTS.ui}`,
  webhookSink: `http://${HOST}:${PORTS.webhookSink}`,
};

/** Env for any Admin-SDK process (seed, e2e helpers) talking to the emulators. */
export const EMULATOR_ENV = {
  GCLOUD_PROJECT: PROJECT_ID,
  FIRESTORE_EMULATOR_HOST: `${HOST}:${PORTS.firestore}`,
  FIREBASE_AUTH_EMULATOR_HOST: `${HOST}:${PORTS.auth}`,
  FIREBASE_DATABASE_EMULATOR_HOST: `${HOST}:${PORTS.database}`,
  FIREBASE_STORAGE_EMULATOR_HOST: `${HOST}:${PORTS.storage}`,
};
