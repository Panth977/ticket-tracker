/**
 * `firebase/storage` FOR THE ICEBASE BUILD — Firebase's own SDK, talking to the IceBase server this
 * page came from (it speaks Cloud Storage for Firebase's API; storage.rules apply there).
 */
import * as real from 'tm-real-storage';
import type { FirebaseStorage } from 'tm-real-storage';

export * from 'tm-real-storage';

const wired = new WeakSet<FirebaseStorage>();

export function getStorage(...a: Parameters<typeof real.getStorage>): FirebaseStorage {
  const s = real.getStorage(...a);
  if (!wired.has(s)) {
    wired.add(s);
    const port = Number(location.port || (location.protocol === 'https:' ? 443 : 80));
    real.connectStorageEmulator(s, location.hostname, port);
    // The SDK's emulator mode speaks http; this origin may be https.
    (s as unknown as { _protocol: string })._protocol = location.protocol.replace(':', '');
  }
  return s;
}
/** Already pointed at this origin by getStorage(). */
export const connectStorageEmulator = (..._a: unknown[]): void => {};
