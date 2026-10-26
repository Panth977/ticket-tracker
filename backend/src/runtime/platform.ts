/**
 * WHERE THIS PROCESS RUNS — TaskManager is one app on IceBase (src/icebase): every collection,
 * index, path and file is declared there, and every service goes through IceBase's admin API.
 * One switch says which backend IceBase drives:
 *
 *   TM_ICEBASE=firebase (default)  Firebase: Cloud Functions, Firestore, Auth, Storage, the
 *                                  Realtime Database and Cloud Tasks (firebase-admin underneath)
 *   TM_ICEBASE=emulator            the IceBase server (`icebase serve`, backend/icebase.config.ts):
 *                                  one port on a VM, SQLite, files on disk, its own sign-in
 */
export type IcebaseMode = 'firebase' | 'emulator';

export function icebaseMode(): IcebaseMode {
  const v = (process.env.TM_ICEBASE || 'firebase').toLowerCase();
  if (v === 'firebase' || v === 'emulator') return v;
  throw new Error(`TM_ICEBASE must be 'firebase' or 'emulator', not ${JSON.stringify(v)}`);
}

/** On the IceBase server (TM_ICEBASE=emulator). */
export const onIcebaseServer = (): boolean => icebaseMode() === 'emulator';
