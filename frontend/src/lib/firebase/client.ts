/**
 * The one Firebase app for the SPA, initialised lazily on first use so that
 * modules importing this file (and their unit tests) do not boot Firebase.
 *
 *   getAuthClient()  — Auth (emulator on :9209 when USE_EMULATORS)
 *   getDb()          — Firestore with the persistent IndexedDB cache: a reload
 *                      is instant and the last board stays readable offline
 *   getRtdb()        — Realtime Database (presence, typing)
 *   getStorageClient() — Cloud Storage (avatars, attachments)
 *   clearPersistentCache() — sign-out: the cached documents leave the device
 */
import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import { connectDatabaseEmulator, getDatabase, type Database } from 'firebase/database';
import {
  clearIndexedDbPersistence,
  connectFirestoreEmulator,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  terminate,
  type Firestore,
} from 'firebase/firestore';
import { connectStorageEmulator, getStorage, type FirebaseStorage } from 'firebase/storage';
import { EMULATORS, FIREBASE_CONFIG, USE_EMULATORS } from './config';

let app: FirebaseApp | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;
let rtdb: Database | undefined;
let storage: FirebaseStorage | undefined;

export function getFirebaseApp(): FirebaseApp {
  if (!app) app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);
  return app;
}

export function getAuthClient(): Auth {
  if (!auth) {
    auth = getAuth(getFirebaseApp());
    if (USE_EMULATORS) {
      connectAuthEmulator(auth, `http://${EMULATORS.host}:${EMULATORS.auth}`, {
        disableWarnings: true,
      });
    }
  }
  return auth;
}

export function getDb(): Firestore {
  if (!db) {
    const a = getFirebaseApp();
    try {
      db = initializeFirestore(a, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      });
    } catch {
      // Already initialised (HMR) or IndexedDB unavailable (private mode): fall back.
      db = getFirestore(a);
    }
    if (USE_EMULATORS) {
      try {
        connectFirestoreEmulator(db, EMULATORS.host, EMULATORS.firestore);
      } catch {
        /* already connected (HMR) */
      }
    }
  }
  return db;
}

/**
 * Drop Firestore's IndexedDB cache (§T). Sign-out clears the remembered
 * session and the pointer; without this the DOCUMENTS would still be on a
 * shared device, and the next person's app could draw them.
 *
 * The cache can only be cleared while the instance is stopped, so the instance
 * is terminated first and the handle dropped: the next getDb() builds a fresh
 * one (terminate() removes it from the Firebase app, so initializeFirestore
 * works again) and the app keeps running without a reload.
 */
export async function clearPersistentCache(): Promise<void> {
  const current = db;
  db = undefined;
  if (!current) return;
  try {
    await terminate(current);
    await clearIndexedDbPersistence(current);
  } catch {
    // Another tab still holds the cache, or IndexedDB is unavailable. This tab
    // has already forgotten everything it held in memory; the next boot with
    // no remembered session shows nothing of the previous account either.
  }
}

export function getRtdb(): Database {
  if (!rtdb) {
    const a = getFirebaseApp();
    /*
     * THE NAMESPACE MUST MATCH THE SERVER'S. An RTDB instance is identified by
     * its namespace, and the emulator keeps one tree per namespace — so a
     * client on the wrong one reads an empty database and writes into a void
     * nothing else can see. `getDatabase(a)` takes the namespace from the app's
     * own databaseURL (`{project}-default-rtdb`, the same one the Admin SDK
     * derives in backend/src/runtime/firebase.ts), and connectDatabaseEmulator
     * then only moves the HOST. Passing `?ns={projectId}` here instead — which
     * this used to do — pointed the app at a namespace the functions never
     * write to: presence, typing and (§W) agent liveness all silently did
     * nothing under the emulators.
     */
    rtdb = getDatabase(a);
    if (USE_EMULATORS) {
      try {
        connectDatabaseEmulator(rtdb, EMULATORS.host, EMULATORS.database);
      } catch {
        /* already connected */
      }
    }
  }
  return rtdb;
}

export function getStorageClient(): FirebaseStorage {
  if (!storage) {
    storage = getStorage(getFirebaseApp());
    if (USE_EMULATORS) {
      try {
        connectStorageEmulator(storage, EMULATORS.host, EMULATORS.storage);
      } catch {
        /* already connected */
      }
    }
  }
  return storage;
}

export { USE_EMULATORS };
