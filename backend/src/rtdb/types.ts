/**
 * THE REALTIME-DATABASE PORT — the JSON tree (liveness: agent status, wake
 * and rev signals, rate counters, artifact pages' RTDB data).
 *
 * Shaped like the Admin SDK's Database (the subset the code uses), like the
 * other ports. Adapters: firebase (getDatabase() itself) and local (one JSON
 * tree in memory, persisted to $TM_DATA_DIR/rtdb.json — Panth's "json +
 * websocket" for the VM; the browser reaches it through /live).
 *
 * Code above the port calls realtimeDb() from 'src/rtdb/index.js', never
 * the Admin SDK's database directly.
 */
export interface DataSnapshot {
  readonly key: string | null;
  val(): unknown;
  exists(): boolean;
}

export interface TransactionResult {
  committed: boolean;
  snapshot: DataSnapshot;
}

export interface Reference {
  readonly key: string | null;
  child(path: string): Reference;
  get(): Promise<DataSnapshot>;
  set(value: unknown): Promise<void>;
  update(values: Record<string, unknown>): Promise<void>;
  remove(): Promise<void>;
  /** A child with a new, time-ordered key (written only when a value is given). */
  push(value?: unknown): Reference & Promise<Reference>;
  /** Run `update` on the current value; returning undefined aborts. (Extra args as the Admin SDK's.) */
  transaction(
    update: (current: never) => unknown,
    onComplete?: unknown,
    applyLocally?: boolean,
  ): Promise<TransactionResult>;
}

export interface RealtimeDb {
  ref(path?: string): Reference;
}

export interface RtdbAdapter {
  readonly name: string;
  db(): RealtimeDb;
  /** The placeholder for "the server's clock" in a write. */
  readonly TIMESTAMP: object;
}
