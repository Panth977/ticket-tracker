/**
 * Admin SDK services (auth, rtdb, storage, functions) and the database.
 * The app itself is initialised in adminApp.ts — kept apart so the database
 * adapters can use it without an import cycle. Everything is lazy: importing
 * a module never touches the network.
 */
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getDatabase, type Database } from 'firebase-admin/database';
import { getFunctions, type Functions } from 'firebase-admin/functions';
import { getStorage, type Storage } from 'firebase-admin/storage';
import { adminApp } from './adminApp.js';

export { DEMO_PROJECT_ID, projectId, isEmulated, adminApp } from './adminApp.js';

/**
 * The document database — behind the port in src/db (Firestore or SQLite,
 * picked by TM_DB). Re-exported here because every module already imports it
 * from this file.
 */
export { db } from '../db/index.js';

export const auth = (): Auth => getAuth(adminApp());
export const rtdbAdmin = (): Database => getDatabase(adminApp());
export const storageAdmin = (): Storage => getStorage(adminApp());
export const functionsAdmin = (): Functions => getFunctions(adminApp());
