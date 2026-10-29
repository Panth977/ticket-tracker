/**
 * The admin services TaskManager uses — auth and storage — and the database, all through IceBase
 * (icebase/app.ts): firebase-admin's own objects on Firebase, aimed at the IceBase server on it
 * (with its signed tokens and signed URLs). Everything is lazy: importing a module never touches
 * the network.
 */
import type { Auth } from 'firebase-admin/auth';
import type { Storage } from 'firebase-admin/storage';
import { getAdminAuth, getAdminStorage } from '@panth977/icebase-server/admin';
import { icebaseApp } from '../icebase/app.js';

export { DEMO_PROJECT_ID, projectId, isEmulated, adminApp } from './adminApp.js';

/** The document database (src/db). Re-exported here because every module already imports it from this file. */
export { db } from '../db/index.js';

export const auth = (): Auth => getAdminAuth(icebaseApp()) as unknown as Auth;
export const storageAdmin = (): Storage => getAdminStorage(icebaseApp()) as unknown as Storage;
