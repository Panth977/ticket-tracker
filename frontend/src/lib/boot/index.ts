/**
 * Local-first boot (docs/plan/agents.html § T): what the device already knows,
 * ready before the server is asked.
 *
 *   session   the last signed-in principal, mirrored to localStorage
 *   pointer   which boards / board / ticket to subscribe to, per account, and
 *             (§W) how far each board's ticket list is already synced
 *   prewarm   opens exactly those listeners while the router is still starting
 *   track     keeps the pointer honest as you navigate
 */
export {
  readSession,
  rememberSession,
  forgetSession,
  SESSION_KEY,
  SESSION_MAX_AGE_MS,
} from './session';
export type { RememberedSession, SessionInput } from './session';
export {
  readPointer,
  notePointer,
  forgetPointer,
  readSynced,
  noteSynced,
  forgetSynced,
  POINTER_PREFIX,
  MAX_BOARDS,
  EMPTY_POINTER,
  SYNC_VERSION,
  SYNC_MAX_AGE_MS,
} from './pointer';
export type {
  Pointer,
  PointerPatch,
  BoardRef,
  LastBoard,
  LastTicket,
  SyncMark,
  SyncMarks,
} from './pointer';
export { prewarm, stopPrewarm, prewarmCount, HOLD_MS } from './prewarm';
export { trackPlace, placeOf } from './track.svelte';
