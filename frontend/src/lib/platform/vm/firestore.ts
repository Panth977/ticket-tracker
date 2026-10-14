/**
 * `firebase/firestore` FOR THE VM BUILD — the modular API the app uses, over
 * the /live socket (live.ts) to the VM's server, which runs the same
 * firestore.rules. vite.config.ts aliases 'firebase/firestore' here when
 * TM_PLATFORM=vm, so no call site changes: one app, two backends.
 *
 * Only what the app calls is here (doc, collection, collectionGroup, query,
 * where, orderBy, limit, startAfter, documentId, onSnapshot, getDoc(s),
 * set/update/delete/addDoc, writeBatch, serverTimestamp, Timestamp, and the
 * cache/emulator setup calls as no-ops). There is no offline cache:
 * getDocsFromCache always fails, which the app treats as "no cache".
 */
import { LiveError, request, subscribe } from './live';

// ─── values ──────────────────────────────────────────────────────────────────

export class Timestamp {
  constructor(
    readonly seconds: number,
    readonly nanoseconds: number,
  ) {}
  static now(): Timestamp {
    return Timestamp.fromMillis(Date.now());
  }
  static fromDate(d: Date): Timestamp {
    return Timestamp.fromMillis(d.getTime());
  }
  static fromMillis(ms: number): Timestamp {
    const s = Math.floor(ms / 1000);
    return new Timestamp(s, Math.round((ms - s * 1000) * 1e6));
  }
  toMillis(): number {
    return this.seconds * 1000 + this.nanoseconds / 1e6;
  }
  toDate(): Date {
    return new Date(this.toMillis());
  }
  isEqual(o: Timestamp): boolean {
    return o.seconds === this.seconds && o.nanoseconds === this.nanoseconds;
  }
  valueOf(): string {
    return `${String(this.seconds + 1e12).padStart(13, '0')}.${String(this.nanoseconds).padStart(9, '0')}`;
  }
  toJSON() {
    return { seconds: this.seconds, nanoseconds: this.nanoseconds };
  }
}

class Sentinel {
  constructor(
    readonly kind: string,
    readonly v?: unknown,
  ) {}
}
export const serverTimestamp = () => new Sentinel('serverTimestamp');
export const deleteField = () => new Sentinel('delete');
export const increment = (n: number) => new Sentinel('increment', n);
export const arrayUnion = (...e: unknown[]) => new Sentinel('arrayUnion', e);
export const arrayRemove = (...e: unknown[]) => new Sentinel('arrayRemove', e);

const NAME = '__name__';
class FieldPathV {
  constructor(readonly segments: string[]) {}
}
export const documentId = () => new FieldPathV([NAME]);
export const FieldPath = FieldPathV;
const fieldName = (f: string | FieldPathV) => (f instanceof FieldPathV ? f.segments.join('.') : f);

const plain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

function toWire(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Timestamp) return { __ts: v.toMillis() };
  if (v instanceof Date) return { __ts: v.getTime() };
  if (v instanceof Sentinel) return { __fv: v.kind, v: Array.isArray(v.v) ? v.v.map(toWire) : v.v };
  if (v instanceof DocumentReference) return { __ref: v.path };
  if (v instanceof Uint8Array) return { __bytes: btoa(String.fromCharCode(...v)) };
  if (Array.isArray(v)) return v.map(toWire);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as object)) if (x !== undefined) out[k] = toWire(x);
  return out;
}
function fromWire(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(fromWire);
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1) {
    if (typeof o.__ts === 'number') return Timestamp.fromMillis(o.__ts);
    if (typeof o.__ref === 'string') return new DocumentReference(o.__ref);
    if (Array.isArray(o.__geo)) return { latitude: o.__geo[0], longitude: o.__geo[1] };
    if (typeof o.__bytes === 'string') return Uint8Array.from(atob(o.__bytes), (c) => c.charCodeAt(0));
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = fromWire(o[k]);
  return out;
}

// ─── the database and references ─────────────────────────────────────────────

export class Firestore {
  readonly type = 'firestore';
}
const DB = new Firestore();
export const getFirestore = (..._a: unknown[]) => DB;
export const initializeFirestore = (..._a: unknown[]) => DB;
export const connectFirestoreEmulator = (..._a: unknown[]) => {};
export const persistentLocalCache = (..._a: unknown[]) => ({});
export const persistentMultipleTabManager = (..._a: unknown[]) => ({});
export const memoryLocalCache = (..._a: unknown[]) => ({});
export const terminate = async (..._a: unknown[]) => {};
export const clearIndexedDbPersistence = async (..._a: unknown[]) => {};

const AUTO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const autoId = () => Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => AUTO[b % 62]).join('');
const join = (parts: string[]) => parts.flatMap((p) => p.split('/')).filter(Boolean).join('/');

export class DocumentReference {
  readonly type = 'document';
  readonly firestore = DB;
  constructor(readonly path: string) {}
  get id(): string {
    return this.path.split('/').pop()!;
  }
  get parent(): CollectionReference {
    return new CollectionReference(this.path.split('/').slice(0, -1).join('/'));
  }
  withConverter(): this {
    return this;
  }
}

interface Constraint {
  kind: 'where' | 'orderBy' | 'limit' | 'limitToLast' | 'startAfter' | 'startAt' | 'endAt' | 'endBefore';
  args: unknown[];
}

export class Query {
  readonly type: 'query' | 'collection' = 'query';
  readonly firestore = DB;
  constructor(
    readonly _path: string,
    readonly _group: boolean,
    readonly _constraints: Constraint[] = [],
  ) {}
  withConverter(): this {
    return this;
  }
}
export class CollectionReference extends Query {
  override readonly type = 'collection' as const;
  constructor(readonly path: string) {
    super(path, false);
  }
  get id(): string {
    return this.path.split('/').pop()!;
  }
  get parent(): DocumentReference | null {
    const segs = this.path.split('/');
    return segs.length > 1 ? new DocumentReference(segs.slice(0, -1).join('/')) : null;
  }
}

type Base = Firestore | DocumentReference | CollectionReference;
const basePath = (b: Base) => (b instanceof Firestore ? '' : b.path);

export function doc(base: Base, ...segs: string[]): DocumentReference {
  if (base instanceof CollectionReference && segs.length === 0) return new DocumentReference(`${base.path}/${autoId()}`);
  return new DocumentReference(join([basePath(base), ...segs]));
}
export function collection(base: Base, ...segs: string[]): CollectionReference {
  return new CollectionReference(join([basePath(base), ...segs]));
}
export function collectionGroup(_db: Firestore, id: string): Query {
  return new Query(id, true);
}

export const where = (field: string | FieldPathV, op: string, value: unknown): Constraint => ({ kind: 'where', args: [fieldName(field), op, value] });
export const orderBy = (field: string | FieldPathV, dir: 'asc' | 'desc' = 'asc'): Constraint => ({ kind: 'orderBy', args: [fieldName(field), dir] });
export const limit = (n: number): Constraint => ({ kind: 'limit', args: [n] });
export const limitToLast = (n: number): Constraint => ({ kind: 'limitToLast', args: [n] });
export const startAfter = (...v: unknown[]): Constraint => ({ kind: 'startAfter', args: v });
export const startAt = (...v: unknown[]): Constraint => ({ kind: 'startAt', args: v });
export const endAt = (...v: unknown[]): Constraint => ({ kind: 'endAt', args: v });
export const endBefore = (...v: unknown[]): Constraint => ({ kind: 'endBefore', args: v });

export function query(base: Query, ...constraints: (Constraint | null | undefined | false)[]): Query {
  return new Query(base._path, base._group, [...base._constraints, ...constraints.filter((c): c is Constraint => !!c)]);
}

/** The query as the server's QuerySpec (backend live/data.ts). */
function spec(q: Query): Record<string, unknown> {
  const out: Record<string, unknown> = { path: q._path, ...(q._group ? { group: true } : {}) };
  const where: unknown[] = [];
  const order: [string, string][] = [];
  for (const c of q._constraints) {
    if (c.kind === 'where') where.push([c.args[0], c.args[1], toWire(c.args[2])]);
    else if (c.kind === 'orderBy') order.push(c.args as [string, string]);
    else if (c.kind === 'limit' || c.kind === 'limitToLast') out[c.kind] = c.args[0];
    else {
      // A cursor: values, or a snapshot → its values for the order fields (+ its name).
      const [first] = c.args;
      const values =
        first instanceof DocumentSnapshot
          ? [
              ...order.filter(([f]) => f !== NAME).map(([f]) => first.get(f)),
              q._group ? first.ref.path : first.id,
            ]
          : c.args;
      out[c.kind] = values.map(toWire);
    }
  }
  if (where.length) out.where = where;
  if (order.length) out.orderBy = order;
  return out;
}

// ─── snapshots ───────────────────────────────────────────────────────────────

const META = Object.freeze({ fromCache: false, hasPendingWrites: false, isEqual: () => true });

export class DocumentSnapshot {
  readonly metadata = META;
  constructor(
    readonly ref: DocumentReference,
    private readonly _data: Record<string, unknown> | null,
  ) {}
  get id(): string {
    return this.ref.id;
  }
  exists(): boolean {
    return this._data !== null;
  }
  data(): Record<string, unknown> | undefined {
    return this._data ?? undefined;
  }
  get(field: string | FieldPathV): unknown {
    let cur: unknown = this._data;
    for (const s of fieldName(field).split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[s] : undefined;
    return cur;
  }
}
export type QueryDocumentSnapshot = DocumentSnapshot;

interface Change {
  type: 'added' | 'modified' | 'removed';
  doc: DocumentSnapshot;
  oldIndex: number;
  newIndex: number;
}

export class QuerySnapshot {
  readonly metadata = META;
  constructor(
    readonly query: Query,
    readonly docs: DocumentSnapshot[],
    private readonly changes: Change[],
  ) {}
  get size(): number {
    return this.docs.length;
  }
  get empty(): boolean {
    return this.docs.length === 0;
  }
  forEach(cb: (d: DocumentSnapshot) => void): void {
    this.docs.forEach(cb);
  }
  docChanges(): Change[] {
    return this.changes;
  }
}

const docSnap = (path: string, data: unknown) => new DocumentSnapshot(new DocumentReference(path), data === null ? null : (fromWire(data) as Record<string, unknown>));

function diff(prev: Map<string, string>, docs: { path: string; data: unknown }[], snaps: DocumentSnapshot[]): Change[] {
  const changes: Change[] = [];
  const seen = new Set<string>();
  const oldIndex = new Map([...prev.keys()].map((k, i) => [k, i]));
  docs.forEach((d, i) => {
    seen.add(d.path);
    const before = prev.get(d.path);
    const json = JSON.stringify(d.data);
    if (before === undefined) changes.push({ type: 'added', doc: snaps[i]!, oldIndex: -1, newIndex: i });
    else if (before !== json) changes.push({ type: 'modified', doc: snaps[i]!, oldIndex: oldIndex.get(d.path)!, newIndex: i });
  });
  for (const [path] of prev)
    if (!seen.has(path)) changes.unshift({ type: 'removed', doc: docSnap(path, null), oldIndex: oldIndex.get(path)!, newIndex: -1 });
  return changes;
}

// ─── reads ───────────────────────────────────────────────────────────────────

export async function getDoc(ref: DocumentReference): Promise<DocumentSnapshot> {
  const r = await request<{ exists: boolean; data: unknown }>({ op: 'get', path: ref.path });
  return docSnap(ref.path, r.exists ? r.data : null);
}
export const getDocFromServer = getDoc;

export async function getDocs(q: Query): Promise<QuerySnapshot> {
  const r = await request<{ docs: { path: string; data: unknown }[] }>({ op: 'query', q: spec(q) });
  const snaps = r.docs.map((d) => docSnap(d.path, d.data));
  return new QuerySnapshot(q, snaps, diff(new Map(), r.docs, snaps));
}
export const getDocsFromServer = getDocs;

export async function getDocsFromCache(_q: Query): Promise<QuerySnapshot> {
  throw new LiveError('unavailable', 'This build keeps no offline cache');
}
export async function getDocFromCache(_r: DocumentReference): Promise<DocumentSnapshot> {
  throw new LiveError('unavailable', 'This build keeps no offline cache');
}

type Observer<T> = { next?: (v: T) => void; error?: (e: Error) => void };

export function onSnapshot(
  target: DocumentReference | Query,
  ...args: unknown[]
): () => void {
  // onSnapshot(target, [options,] next | observer, error?)
  const rest = args.filter((a) => typeof a === 'function' || (a && typeof a === 'object' && ('next' in (a as object) || 'error' in (a as object))));
  const first = rest[0];
  const obs: Observer<unknown> =
    typeof first === 'function'
      ? { next: first as (v: unknown) => void, error: rest[1] as ((e: Error) => void) | undefined }
      : ((first ?? {}) as Observer<unknown>);
  if (target instanceof DocumentReference) {
    return subscribe({ op: 'listen', path: target.path }, (f) => {
      if (f.error) {
        const e = f.error as { code: string; message: string };
        obs.error?.(new LiveError(e.code, e.message));
        return;
      }
      const s = f.snap as { exists: boolean; data: unknown };
      obs.next?.(docSnap(target.path, s.exists ? s.data : null));
    });
  }
  let prev = new Map<string, string>();
  return subscribe({ op: 'listen', q: spec(target) }, (f) => {
    if (f.error) {
      const e = f.error as { code: string; message: string };
      obs.error?.(new LiveError(e.code, e.message));
      return;
    }
    const docs = (f.snap as { docs: { path: string; data: unknown }[] }).docs;
    const snaps = docs.map((d) => docSnap(d.path, d.data));
    const changes = diff(prev, docs, snaps);
    prev = new Map(docs.map((d) => [d.path, JSON.stringify(d.data)]));
    obs.next?.(new QuerySnapshot(target, snaps, changes));
  });
}

// ─── writes ──────────────────────────────────────────────────────────────────

interface Write {
  path: string;
  kind: 'set' | 'update' | 'create' | 'delete';
  data?: unknown;
  merge?: boolean;
  mergeFields?: string[];
}

function updateData(args: unknown[]): Record<string, unknown> {
  if (typeof args[0] === 'string' || args[0] instanceof FieldPathV) {
    const out: Record<string, unknown> = {};
    for (let i = 0; i + 1 < args.length; i += 2) out[fieldName(args[i] as string)] = args[i + 1];
    return out;
  }
  return args[0] as Record<string, unknown>;
}

const commit = (writes: Write[]) => request<null>({ op: 'commit', writes }).then(() => undefined);

export function setDoc(ref: DocumentReference, data: unknown, options?: { merge?: boolean; mergeFields?: string[] }): Promise<void> {
  return commit([{ path: ref.path, kind: 'set', data: toWire(data), ...(options?.merge ? { merge: true } : {}), ...(options?.mergeFields ? { mergeFields: options.mergeFields } : {}) }]);
}
export function updateDoc(ref: DocumentReference, ...args: unknown[]): Promise<void> {
  return commit([{ path: ref.path, kind: 'update', data: toWire(updateData(args)) }]);
}
export function deleteDoc(ref: DocumentReference): Promise<void> {
  return commit([{ path: ref.path, kind: 'delete' }]);
}
export async function addDoc(col: CollectionReference, data: unknown): Promise<DocumentReference> {
  const ref = doc(col);
  await commit([{ path: ref.path, kind: 'create', data: toWire(data) }]);
  return ref;
}

export function writeBatch(_db?: Firestore) {
  const writes: Write[] = [];
  const batch = {
    set(ref: DocumentReference, data: unknown, options?: { merge?: boolean }) {
      writes.push({ path: ref.path, kind: 'set', data: toWire(data), ...(options?.merge ? { merge: true } : {}) });
      return batch;
    },
    update(ref: DocumentReference, ...args: unknown[]) {
      writes.push({ path: ref.path, kind: 'update', data: toWire(updateData(args)) });
      return batch;
    },
    delete(ref: DocumentReference) {
      writes.push({ path: ref.path, kind: 'delete' });
      return batch;
    },
    commit: () => commit(writes),
  };
  return batch;
}

export { LiveError as FirestoreError };
export const _plain = plain;
