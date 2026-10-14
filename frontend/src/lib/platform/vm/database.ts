/**
 * `firebase/database` FOR THE VM BUILD — presence, typing, agent liveness and
 * artifact data over the /live socket (backend live/rtdb.ts), checked by the
 * same database.rules.json. Only what the app calls: getDatabase, ref, child,
 * onValue, get, set, update, remove, push, onDisconnect, serverTimestamp and
 * the `.info/serverTimeOffset` pseudo-path.
 */
import { LiveError, request, subscribe } from './live';

export class Database {
  readonly type = 'database';
}
const DB = new Database();
export const getDatabase = (..._a: unknown[]) => DB;
export const connectDatabaseEmulator = (..._a: unknown[]) => {};
export const goOffline = (..._a: unknown[]) => {};
export const goOnline = (..._a: unknown[]) => {};

const clean = (p: string) => p.split('/').filter(Boolean).join('/');

export class DatabaseReference {
  constructor(readonly _path: string) {}
  get key(): string | null {
    return this._path ? this._path.split('/').pop()! : null;
  }
  get parent(): DatabaseReference | null {
    return this._path ? new DatabaseReference(this._path.split('/').slice(0, -1).join('/')) : null;
  }
  get root(): DatabaseReference {
    return new DatabaseReference('');
  }
  toString(): string {
    return `${location.origin}/rtdb/${this._path}`;
  }
}

export const ref = (_db: Database, path = '') => new DatabaseReference(clean(path));
export const child = (parent: DatabaseReference, path: string) => new DatabaseReference(clean(`${parent._path}/${path}`));

export const serverTimestamp = () => ({ '.sv': 'timestamp' });
export const increment = (delta: number) => ({ '.sv': { increment: delta } });

export class DataSnapshot {
  constructor(
    readonly ref: DatabaseReference,
    private readonly value: unknown,
  ) {}
  get key(): string | null {
    return this.ref.key;
  }
  val(): unknown {
    return this.value ?? null;
  }
  exportVal(): unknown {
    return this.val();
  }
  exists(): boolean {
    return this.value !== null && this.value !== undefined;
  }
  get size(): number {
    return this.value && typeof this.value === 'object' ? Object.keys(this.value).length : 0;
  }
  hasChildren(): boolean {
    return this.size > 0;
  }
  hasChild(path: string): boolean {
    return this.child(path).exists();
  }
  child(path: string): DataSnapshot {
    let cur: unknown = this.value;
    for (const s of clean(path).split('/')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[s] : null;
    return new DataSnapshot(child(this.ref, path), cur ?? null);
  }
  forEach(cb: (s: DataSnapshot) => boolean | void): boolean {
    if (!this.value || typeof this.value !== 'object') return false;
    for (const k of Object.keys(this.value).sort()) if (cb(this.child(k)) === true) return true;
    return false;
  }
  toJSON(): unknown {
    return this.val();
  }
}

// `.info/serverTimeOffset`: measured once per page from rtdb.time.
let offset: Promise<number> | null = null;
function serverTimeOffset(): Promise<number> {
  offset ??= (async () => {
    const t0 = Date.now();
    const { now } = await request<{ now: number }>({ op: 'rtdb.time' });
    return Math.round(now - (t0 + Date.now()) / 2);
  })().catch(() => 0);
  return offset;
}

type Cancel = (e: Error) => void;

export function onValue(r: DatabaseReference, cb: (s: DataSnapshot) => void, cancelOrOptions?: Cancel | object, _options?: object): () => void {
  const cancel = typeof cancelOrOptions === 'function' ? (cancelOrOptions as Cancel) : undefined;
  if (r._path === '.info/serverTimeOffset') {
    let live = true;
    void serverTimeOffset().then((o) => live && cb(new DataSnapshot(r, o)));
    return () => {
      live = false;
    };
  }
  if (r._path === '.info/connected') {
    queueMicrotask(() => cb(new DataSnapshot(r, true)));
    return () => {};
  }
  return subscribe({ op: 'rtdb.listen', path: r._path }, (f) => {
    if (f.error) {
      const e = f.error as { code: string; message: string };
      cancel?.(new LiveError(e.code, e.message));
      return;
    }
    cb(new DataSnapshot(r, f.value));
  });
}
export function off(): void {
  /* listeners are removed with the function onValue returned */
}

export async function get(r: DatabaseReference): Promise<DataSnapshot> {
  if (r._path === '.info/serverTimeOffset') return new DataSnapshot(r, await serverTimeOffset());
  const { value } = await request<{ value: unknown }>({ op: 'rtdb.get', path: r._path });
  return new DataSnapshot(r, value);
}

export const set = (r: DatabaseReference, value: unknown) => request({ op: 'rtdb.set', path: r._path, value: value ?? null }).then(() => undefined);
export const update = (r: DatabaseReference, values: object) => request({ op: 'rtdb.update', path: r._path, values }).then(() => undefined);
export const remove = (r: DatabaseReference) => request({ op: 'rtdb.remove', path: r._path }).then(() => undefined);

export function push(parent: DatabaseReference, value?: unknown): DatabaseReference & Promise<DatabaseReference> {
  const done = request<{ key: string }>({ op: 'rtdb.push', path: parent._path, ...(value === undefined ? {} : { value }) });
  // Firebase's push returns the new ref at once, which is also a promise of itself.
  // The key comes from the server, so the ref is only complete once that resolves.
  const thenable = done.then(({ key }) => child(parent, key));
  const out = Object.assign(Object.create(DatabaseReference.prototype) as DatabaseReference, { _path: '' }) as DatabaseReference & Promise<DatabaseReference>;
  void thenable.then((r) => Object.assign(out, { _path: r._path }));
  return Object.assign(out, {
    then: thenable.then.bind(thenable),
    catch: thenable.catch.bind(thenable),
    finally: thenable.finally.bind(thenable),
  }) as DatabaseReference & Promise<DatabaseReference>;
}

export function onDisconnect(r: DatabaseReference) {
  const register = (action: string, value?: unknown) =>
    request({ op: 'rtdb.onDisconnect', path: r._path, action, ...(value === undefined ? {} : { value }) }).then(() => undefined);
  return {
    set: (value: unknown) => register('set', value ?? null),
    update: (values: object) => register('update', values),
    remove: () => register('remove'),
    cancel: () => register('cancel'),
  };
}
