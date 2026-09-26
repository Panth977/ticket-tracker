/** Emulator REST helpers: reachability and wiping. */
import { AUTH_HOST, FIRESTORE_HOST, PROJECT_ID } from './env.js';

async function reachable(host: string): Promise<boolean> {
  try {
    await fetch(`http://${host}/`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/** Throws a clear error when the emulators are not up (instead of 30s timeouts). */
export async function assertEmulators(): Promise<void> {
  const [fs, au] = await Promise.all([reachable(FIRESTORE_HOST), reachable(AUTH_HOST)]);
  if (!fs || !au) {
    throw new Error(
      `Firebase emulators not reachable (firestore ${FIRESTORE_HOST}: ${fs}, auth ${AUTH_HOST}: ${au}). ` +
        `Run via the root \`pnpm test:emu\`, or start them with \`pnpm emulators\`.`,
    );
  }
}

/**
 * Wipe ALL Firestore data. Test files run in parallel against one emulator,
 * so prefer unique ids (uniq()) over wiping; use this only in a suite that
 * owns the whole database.
 */
export async function clearFirestore(): Promise<void> {
  const res = await fetch(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    {
      method: 'DELETE',
    },
  );
  if (!res.ok) throw new Error(`clearFirestore: ${res.status}`);
}

/** Wipe ALL auth users (same caveat as clearFirestore). */
export async function clearAuth(): Promise<void> {
  const res = await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT_ID}/accounts`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`clearAuth: ${res.status}`);
}
