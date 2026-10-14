/**
 * WHICH PLATFORM THIS PROCESS RUNS ON — one switch, many adapters.
 *
 *   TM_PLATFORM=firebase (default)  Cloud Functions + Firestore + Storage +
 *                                   Firebase Auth + RTDB + Cloud Tasks
 *   TM_PLATFORM=vm                  one Node server (Docker): SQLite, files on
 *                                   disk, local auth, WebSocket realtime,
 *                                   in-process jobs
 *
 * Each port picks its adapter from its own variable when set, else from the
 * platform default — so a mixed setup (say SQLite with Cloud Storage) is one
 * extra variable, and tests can swap a single port.
 *
 *   port      variable   firebase    vm
 *   database  TM_DB      firestore   sqlite
 *   files     TM_BLOB    gcs         disk
 */
export type Platform = 'firebase' | 'vm';

export function platform(): Platform {
  const v = (process.env.TM_PLATFORM || 'firebase').toLowerCase();
  if (v === 'firebase' || v === 'vm') return v;
  throw new Error(`TM_PLATFORM must be 'firebase' or 'vm', not ${JSON.stringify(v)}`);
}

/** A port's adapter: its own env variable, else the platform's default. */
export function adapterFor<T extends string>(
  variable: string,
  defaults: Record<Platform, T>,
  allowed: readonly T[],
): T {
  const v = (process.env[variable] || defaults[platform()]).toLowerCase() as T;
  if (!allowed.includes(v))
    throw new Error(`${variable} must be one of ${allowed.join(', ')}, not ${JSON.stringify(v)}`);
  return v;
}

/** Where a VM keeps its state (TM_DATA_DIR, default ./data): db/, blobs/ … */
export function dataDir(): string {
  return process.env.TM_DATA_DIR || './data';
}
