/**
 * The Realtime Database, behind one port (types.ts). TM_RTDB (else
 * TM_PLATFORM) picks the adapter: 'firebase' (firebase) | 'local' (vm).
 */
import { adapterFor } from '../runtime/platform.js';
import { firebaseRtdb } from './firebase.js';
import { localRtdb } from './local.js';
import type { RealtimeDb, RtdbAdapter } from './types.js';

export type * from './types.js';
export type RtdbKind = 'firebase' | 'local';

export function rtdbKind(): RtdbKind {
  return adapterFor<RtdbKind>('TM_RTDB', { firebase: 'firebase', vm: 'local' }, [
    'firebase',
    'local',
  ]);
}

const adapter: RtdbAdapter = rtdbKind() === 'local' ? localRtdb : firebaseRtdb;

/** The Realtime Database. */
export function realtimeDb(): RealtimeDb {
  return adapter.db();
}

/** ServerValue.TIMESTAMP of the active store. */
export const ServerValue = { TIMESTAMP: adapter.TIMESTAMP };
