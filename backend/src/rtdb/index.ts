/**
 * The Realtime Database, behind one port (types.ts). TM_RTDB (else
 * TM_PLATFORM) picks the adapter: 'firebase' (firebase) | 'local' (vm) | 'icebase' (icebase).
 */
import { adapterFor } from '../runtime/platform.js';
import { firebaseRtdb } from './firebase.js';
import { icebaseRtdb } from './icebase.js';
import { localRtdb } from './local.js';
import type { RealtimeDb, RtdbAdapter } from './types.js';

export type * from './types.js';
export type RtdbKind = 'firebase' | 'local' | 'icebase';

export function rtdbKind(): RtdbKind {
  return adapterFor<RtdbKind>('TM_RTDB', { firebase: 'firebase', vm: 'local', icebase: 'icebase' }, [
    'firebase',
    'local',
    'icebase',
  ]);
}

const kind = rtdbKind();
const adapter: RtdbAdapter = kind === 'local' ? localRtdb : kind === 'icebase' ? icebaseRtdb : firebaseRtdb;

/** The Realtime Database. */
export function realtimeDb(): RealtimeDb {
  return adapter.db();
}

/** ServerValue.TIMESTAMP of the active store. */
export const ServerValue = { TIMESTAMP: adapter.TIMESTAMP };
