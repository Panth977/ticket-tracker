/**
 * The Realtime Database, behind one port (types.ts): IceBase's (rtdb/icebase.ts).
 */
import { icebaseRtdb } from './icebase.js';
import type { RealtimeDb } from './types.js';

export type * from './types.js';

/** The Realtime Database. */
export function realtimeDb(): RealtimeDb {
  return icebaseRtdb.db();
}

/** ServerValue.TIMESTAMP: the server's clock in a write. */
export const ServerValue = { TIMESTAMP: icebaseRtdb.TIMESTAMP };
