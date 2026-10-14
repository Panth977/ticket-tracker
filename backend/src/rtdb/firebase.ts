/** The Firebase adapter: the Admin SDK's Realtime Database itself. */
import { ServerValue } from 'firebase-admin/database';
import { rtdbAdmin } from '../runtime/firebase.js';
import type { RealtimeDb, RtdbAdapter } from './types.js';

export const firebaseRtdb: RtdbAdapter = {
  name: 'firebase',
  db: () => rtdbAdmin() as unknown as RealtimeDb,
  TIMESTAMP: ServerValue.TIMESTAMP,
};
