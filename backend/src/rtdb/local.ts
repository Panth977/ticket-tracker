/**
 * The local Realtime Database (TM_RTDB=local, the VM default): ONE JSON tree
 * in memory, written to $TM_DATA_DIR/rtdb.json (atomically, at most every
 * 200 ms) and read back at start. Same semantics as Firebase's:
 *
 *   - null deletes; empty objects vanish; there are no arrays-with-holes games
 *   - update() takes multi-path keys ('a/b': 1); set(null) == remove()
 *   - { '.sv': 'timestamp' } becomes the server's clock
 *   - push() keys are Firebase-style: time-ordered, 20 characters
 *   - transaction() runs the function on the current value and commits
 *     atomically (one process: nothing can interleave)
 *
 * Every write is announced to onWrite listeners (the /live channel's change
 * feed for browsers).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../runtime/platform.js';
import type {
  DataSnapshot,
  RealtimeDb,
  Reference,
  RtdbAdapter,
  TransactionResult,
} from './types.js';

type Json = null | boolean | number | string | { [k: string]: Json };
const TIMESTAMP = Object.freeze({ '.sv': 'timestamp' });

export function splitPath(path: string | undefined): string[] {
  const segs = (path ?? '').split('/').filter(Boolean);
  for (const s of segs)
    // eslint-disable-next-line no-control-regex -- RTDB keys may not hold control characters
    if (/[.$#[\]]/.test(s) || /[\x00-\x1f\x7f]/.test(s))
      throw new Error(
        `Reference.child failed: invalid key "${s}" (must not contain . $ # [ ] or control characters)`,
      );
  return segs;
}

/** A written value → its stored form (server values resolved, nulls and empties dropped). */
function normalize(v: unknown, now: number): Json {
  if (v === undefined) throw new Error('Value is undefined (use null to remove)');
  if (v === null) return null;
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Cannot store a non-finite number');
    return v;
  }
  if (Array.isArray(v)) {
    const o: Record<string, unknown> = {};
    v.forEach((x, i) => (o[String(i)] = x));
    return normalize(o, now);
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length === 1 && o['.sv'] === 'timestamp') return now;
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(o)) {
      splitPath(k);
      if (x === undefined) throw new Error(`Value for "${k}" is undefined`);
      const n = normalize(x, now);
      if (n !== null) out[k] = n;
    }
    return Object.keys(out).length ? out : null;
  }
  throw new Error(`Cannot store a ${typeof v}`);
}

const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
let lastPushTime = 0;
let lastRandom: number[] = [];
/** Firebase push id: 8 chars of time + 12 random, monotonic within a millisecond. */
export function pushId(now = Date.now()): string {
  const dup = now === lastPushTime;
  lastPushTime = now;
  let t = now;
  let head = '';
  for (let i = 0; i < 8; i++) {
    head = PUSH_CHARS[t % 64] + head;
    t = Math.floor(t / 64);
  }
  if (!dup) lastRandom = Array.from({ length: 12 }, () => Math.floor(Math.random() * 64));
  else {
    let i = 11;
    while (i >= 0 && lastRandom[i] === 63) lastRandom[i--] = 0;
    if (i >= 0) lastRandom[i]!++;
  }
  return head + lastRandom.map((n) => PUSH_CHARS[n]).join('');
}

export type WriteListener = (paths: string[]) => void;

export class LocalTree {
  root: Json = null;
  private readonly listeners = new Set<WriteListener>();
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(readonly file: string | null) {
    if (file) {
      try {
        this.root = JSON.parse(readFileSync(file, 'utf8')) as Json;
      } catch {
        this.root = null;
      }
    }
  }

  read(segs: string[]): Json {
    let cur: Json = this.root;
    for (const s of segs) {
      if (cur === null || typeof cur !== 'object') return null;
      cur = (cur as Record<string, Json>)[s] ?? null;
    }
    return cur;
  }

  /** Put a stored value at a path (null removes), pruning emptied parents. */
  private put(segs: string[], value: Json): void {
    if (!segs.length) {
      this.root = value;
      return;
    }
    const walk = (node: Json, i: number): Json => {
      const o: Record<string, Json> = node !== null && typeof node === 'object' ? { ...node } : {};
      const k = segs[i]!;
      if (i === segs.length - 1) {
        if (value === null) delete o[k];
        else o[k] = value;
      } else {
        const next = walk(o[k] ?? null, i + 1);
        if (next === null) delete o[k];
        else o[k] = next;
      }
      return Object.keys(o).length ? o : null;
    };
    this.root = walk(this.root, 0);
  }

  write(entries: [string[], unknown][]): void {
    const now = Date.now();
    const norm = entries.map(([s, v]) => [s, normalize(v, now)] as [string[], Json]);
    for (const [s, v] of norm) this.put(s, v);
    this.changed(norm.map(([s]) => '/' + s.join('/')));
  }

  transaction(segs: string[], fn: (cur: never) => unknown): TransactionResult {
    const cur = this.read(segs);
    const next = fn(structuredClone(cur) as never);
    if (next === undefined) return { committed: false, snapshot: snapshot(segs, cur) };
    this.write([[segs, next]]);
    return { committed: true, snapshot: snapshot(segs, this.read(segs)) };
  }

  onWrite(l: WriteListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed(paths: string[]): void {
    for (const l of this.listeners) {
      try {
        l(paths);
      } catch (e) {
        console.error('[rtdb] listener failed', e);
      }
    }
    if (this.file && !this.flushTimer)
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flush();
      }, 200);
  }

  flush(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.root));
    renameSync(tmp, this.file);
  }
}

function snapshot(segs: string[], value: Json): DataSnapshot {
  const v = structuredClone(value);
  return {
    key: segs.length ? segs[segs.length - 1]! : null,
    val: () => structuredClone(v),
    exists: () => v !== null,
  };
}

class LocalRef implements Reference {
  constructor(
    private readonly tree: LocalTree,
    readonly segs: string[],
  ) {}
  get key(): string | null {
    return this.segs.length ? this.segs[this.segs.length - 1]! : null;
  }
  child(path: string): LocalRef {
    return new LocalRef(this.tree, [...this.segs, ...splitPath(path)]);
  }
  async get(): Promise<DataSnapshot> {
    return snapshot(this.segs, this.tree.read(this.segs));
  }
  async set(value: unknown): Promise<void> {
    this.tree.write([[this.segs, value]]);
  }
  async update(values: Record<string, unknown>): Promise<void> {
    this.tree.write(Object.entries(values).map(([k, v]) => [[...this.segs, ...splitPath(k)], v]));
  }
  async remove(): Promise<void> {
    this.tree.write([[this.segs, null]]);
  }
  push(value?: unknown): LocalRef & Promise<LocalRef> {
    const segs = [...this.segs, pushId()];
    const child = new LocalRef(this.tree, segs);
    // Resolves to a PLAIN ref (as Firebase's ThenableReference does) — not to itself.
    const plain = new LocalRef(this.tree, segs);
    const done = value === undefined ? Promise.resolve(plain) : plain.set(value).then(() => plain);
    return Object.assign(child, {
      then: done.then.bind(done),
      catch: done.catch.bind(done),
      finally: done.finally.bind(done),
    }) as LocalRef & Promise<LocalRef>;
  }
  async transaction(fn: (current: never) => unknown): Promise<TransactionResult> {
    return this.tree.transaction(this.segs, fn);
  }
}

let tree: LocalTree | undefined;
/** The process's tree ($TM_RTDB_FILE, else $TM_DATA_DIR/rtdb.json; ':memory:' keeps it in memory). */
export function localTree(): LocalTree {
  if (!tree) {
    const f = process.env.TM_RTDB_FILE || join(dataDir(), 'rtdb.json');
    tree = new LocalTree(f === ':memory:' ? null : f);
    process.once('beforeExit', () => tree?.flush());
  }
  return tree;
}

export const localRtdb: RtdbAdapter = {
  name: 'local',
  db: (): RealtimeDb => ({ ref: (path?: string) => new LocalRef(localTree(), splitPath(path)) }),
  TIMESTAMP,
};
