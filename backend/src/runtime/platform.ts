/**
 * WHICH PLATFORM THIS PROCESS RUNS ON — one switch, many adapters.
 *
 *   TM_PLATFORM=firebase (default)  Cloud Functions + Firestore + Storage +
 *                                   Firebase Auth + RTDB + Cloud Tasks
 *   TM_PLATFORM=vm                  one Node server (Docker): SQLite, files on
 *                                   disk, local auth, WebSocket realtime,
 *                                   in-process jobs
 *   TM_PLATFORM=icebase             the functions inside the IceBase server
 *                                   (`icebase serve`, icebase.config.ts): its
 *                                   database, auth, storage, realtime database
 *                                   and task queues, through IceBase's admin API
 *
 * Each port picks its adapter from its own variable when set, else from the
 * platform default — so a mixed setup (say SQLite with Cloud Storage) is one
 * extra variable, and tests can swap a single port.
 *
 *   port      variable   firebase    vm        icebase
 *   database  TM_DB      firestore   sqlite    icebase
 *   files     TM_BLOB    gcs         disk      gcs (IceBase's storage)
 *   auth      TM_AUTH    firebase    local     firebase (IceBase's auth)
 *   rtdb      TM_RTDB    firebase    local     icebase
 */
export type Platform = 'firebase' | 'vm' | 'icebase';

export function platform(): Platform {
  const v = (process.env.TM_PLATFORM || 'firebase').toLowerCase();
  if (v === 'firebase' || v === 'vm' || v === 'icebase') return v;
  throw new Error(`TM_PLATFORM must be 'firebase', 'vm' or 'icebase', not ${JSON.stringify(v)}`);
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
