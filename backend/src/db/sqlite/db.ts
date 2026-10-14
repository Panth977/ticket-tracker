/**
 * The SQLite implementation of the port: refs, queries, snapshots,
 * transactions, batches, bulk writers, recursive delete.
 *
 * TRANSACTIONS are optimistic, like Firestore's: every document a
 * transaction reads is remembered with its version (`v`); at commit every
 * shard it touches is locked (BEGIN IMMEDIATE, in a fixed order), the
 * versions are checked, and on a mismatch everything rolls back and the
 * function runs again (up to maxAttempts, then ABORTED). A write is a
 * read-modify-write of the row inside that lock, so sentinels (increment,
 * arrayUnion …) are exact. node:sqlite is synchronous, so a commit is never
 * interleaved with another in this process; other processes (a second
 * server, the functions emulator in tests) are kept out by the file locks.
 *
 * A commit that spans shards (a board file and root.sqlite) commits them
 * one after another under the same locks: atomic against every other
 * writer, but a crash between the two COMMITs can keep one side. Commands
 * that care write the document that decides (e.g. the ticket) last.
 *
 * After a commit, each changed document is announced to the change
 * listeners (onChange) — what Firestore triggers and realtime listeners
 * hang off on this store.
 */
import { randomBytes } from 'node:crypto';
import type * as P from '../types.js';
import { applyWrite, mergeFieldSegments, updatePairs, type WriteOp } from './mutate.js';
import { Plan, type Cursor, type LoadedRow, type Op, type QueryState } from './query.js';
import type { Store } from './store.js';
import { ROOT, SHARD_KINDS, shardOf, tableName, type Row, type Shard } from './store.js';
import type { FieldPath } from './values.js';
import {
  CODES,
  DbError,
  decode,
  documentSize,
  MAX_DOC_BYTES,
  segmentsOf,
  Timestamp,
  type PathLike,
} from './values.js';

type Json = Record<string, unknown>;
type Conv = P.FirestoreDataConverter<unknown> | null;

// ─── paths ───────────────────────────────────────────────────────────────────

function splitPath(path: string): string[] {
  const segs = path.split('/');
  if (!path || segs.some((s) => s === '' || s === '.' || s === '..'))
    throw new DbError(
      'INVALID_ARGUMENT',
      `Paths must be non-empty strings without empty segments: ${JSON.stringify(path)}`,
    );
  return segs;
}
function assertDocPath(path: string): string[] {
  const segs = splitPath(path);
  if (segs.length % 2 !== 0)
    throw new DbError(
      'INVALID_ARGUMENT',
      `Value for argument "documentPath" must point to a document, but was "${path}". Your path does not contain an even number of components.`,
    );
  return segs;
}
function assertColPath(path: string): string[] {
  const segs = splitPath(path);
  if (segs.length % 2 !== 1)
    throw new DbError(
      'INVALID_ARGUMENT',
      `Value for argument "collectionPath" must point to a collection, but was "${path}". Your path does not contain an odd number of components.`,
    );
  return segs;
}
/** A document path → where its row lives. */
function locate(path: string): { shard: string; collectionId: string; parent: string; id: string } {
  const segs = assertDocPath(path);
  return {
    shard: shardOf(path),
    collectionId: segs[segs.length - 2]!,
    parent: segs.slice(0, -2).join('/'),
    id: segs[segs.length - 1]!,
  };
}

const AUTO_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function autoId(): string {
  const bytes = randomBytes(40);
  let id = '';
  for (let i = 0; i < bytes.length && id.length < 20; i++) {
    const b = bytes[i]!;
    if (b < 248) id += AUTO_ID_CHARS[b % 62];
  }
  return id.padEnd(20, 'A');
}

// ─── change feed ─────────────────────────────────────────────────────────────

export interface DocChange {
  /** Unique per change (an event id). */
  id: string;
  path: string;
  collectionId: string;
  /** Epoch ms of the commit. */
  time: number;
  before: Json | undefined;
  after: Json | undefined;
}
export type ChangeListener = (changes: DocChange[], db: SqliteDb) => void;

// ─── snapshots ───────────────────────────────────────────────────────────────

const tsOf = (ms: number) => Timestamp.fromMillis(ms);

export class DocSnap<T = P.DocumentData> implements P.QueryDocumentSnapshot<T> {
  readonly exists: boolean;
  readonly readTime: Timestamp;
  readonly createTime!: Timestamp;
  readonly updateTime!: Timestamp;
  private decoded: Json | undefined;

  constructor(
    readonly ref: DocRef<T>,
    /** Encoded document, undefined when missing. */
    readonly raw: Json | undefined,
    row: Pick<Row, 'ct' | 'ut'> | undefined,
    private readonly mask?: string[][],
  ) {
    this.exists = raw !== undefined;
    this.readTime = Timestamp.now();
    if (row) {
      (this as { createTime: Timestamp }).createTime = tsOf(Number(row.ct));
      (this as { updateTime: Timestamp }).updateTime = tsOf(Number(row.ut));
    }
  }
  get id(): string {
    return this.ref.id;
  }
  /** The stored data, decoded, without a converter. */
  rawData(): Json | undefined {
    if (!this.raw) return undefined;
    if (!this.decoded) {
      let src = this.raw;
      if (this.mask) {
        src = {};
        for (const segs of this.mask) {
          let cur: unknown = this.raw;
          for (const s of segs) cur = cur && typeof cur === 'object' ? (cur as Json)[s] : undefined;
          if (cur === undefined) continue;
          let dst = src;
          for (const s of segs.slice(0, -1)) dst = (dst[s] ??= {}) as Json;
          dst[segs[segs.length - 1]!] = cur;
        }
      }
      this.decoded = decode(src, (p) => this.ref.db.doc(p)) as Json;
    }
    return this.decoded;
  }
  data(): T {
    if (!this.exists) return undefined as T;
    const conv = this.ref.conv;
    if (conv)
      return conv.fromFirestore(this.withoutConverter() as unknown as P.QueryDocumentSnapshot) as T;
    return this.rawData() as T;
  }
  withoutConverter(): DocSnap<P.DocumentData> {
    const s = new DocSnap<P.DocumentData>(
      this.ref.withConverter(null),
      this.raw,
      undefined,
      this.mask,
    );
    (s as { createTime: Timestamp }).createTime = this.createTime;
    (s as { updateTime: Timestamp }).updateTime = this.updateTime;
    return s;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(field: string | P.FieldPath): any {
    let cur: unknown = this.rawData();
    for (const s of segmentsOf(field as string | FieldPath)) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = (cur as Json)[s];
    }
    return cur;
  }
}

class QuerySnap<T> implements P.QuerySnapshot<T> {
  readonly readTime = Timestamp.now();
  constructor(readonly docs: DocSnap<T>[]) {}
  get size(): number {
    return this.docs.length;
  }
  get empty(): boolean {
    return this.docs.length === 0;
  }
  forEach(cb: (d: P.QueryDocumentSnapshot<T>) => void): void {
    this.docs.forEach(cb);
  }
}

// ─── refs ────────────────────────────────────────────────────────────────────

export class DocRef<T = P.DocumentData> implements P.DocumentReference<T> {
  readonly id: string;
  constructor(
    readonly db: SqliteDb,
    readonly path: string,
    readonly conv: Conv = null,
  ) {
    const segs = assertDocPath(path);
    this.id = segs[segs.length - 1]!;
  }
  get parent(): ColRef<T> {
    return new ColRef<T>(this.db, this.path.split('/').slice(0, -1).join('/'), this.conv);
  }
  collection(path: string): ColRef<P.DocumentData> {
    return new ColRef(this.db, `${this.path}/${path}`);
  }
  listCollections(): Promise<ColRef<P.DocumentData>[]> {
    return Promise.resolve(this.db.subcollections(this.path));
  }
  async get(): Promise<DocSnap<T>> {
    return this.db.readDoc(this);
  }
  create(data: P.WithFieldValue<T>): Promise<P.WriteResult> {
    return this.db.commitOne(this, { kind: 'create', data: toStore(this, data) });
  }
  set(
    data: P.WithFieldValue<T> | P.PartialWithFieldValue<T>,
    options?: P.SetOptions,
  ): Promise<P.WriteResult> {
    return this.db.commitOne(this, setOp(this, data, options));
  }
  update(...args: unknown[]): Promise<P.WriteResult> {
    return this.db.commitOne(this, { kind: 'update', ...updatePairs(args) });
  }
  delete(precondition?: P.Precondition): Promise<P.WriteResult> {
    return this.db.commitOne(this, { kind: 'delete', precondition });
  }
  isEqual(other: P.DocumentReference<T>): boolean {
    return other instanceof DocRef && other.path === this.path;
  }
  withConverter<U>(converter: P.FirestoreDataConverter<U> | null): DocRef<U> {
    return new DocRef<U>(this.db, this.path, converter as Conv);
  }
}

function toStore<T>(ref: DocRef<T>, data: unknown, options?: P.SetOptions): Json {
  const out = ref.conv
    ? options
      ? ref.conv.toFirestore(data as P.PartialWithFieldValue<unknown>, options)
      : ref.conv.toFirestore(data as P.WithFieldValue<unknown>)
    : data;
  if (!out || typeof out !== 'object' || Array.isArray(out))
    throw new DbError(
      'INVALID_ARGUMENT',
      'Value for argument "data" is not a valid Firestore document. Input is not a plain JavaScript object.',
    );
  return out as Json;
}
function setOp<T>(ref: DocRef<T>, data: unknown, options?: P.SetOptions): WriteOp {
  const d = toStore(ref, data, options);
  if (options?.mergeFields)
    return {
      kind: 'set',
      data: d,
      mergeFields: mergeFieldSegments(options.mergeFields as (string | FieldPath)[]),
    };
  return { kind: 'set', data: d, merge: !!options?.merge };
}

type CursorInput = [P.DocumentSnapshot<unknown>] | unknown[];

export class SqlQuery<T = P.DocumentData> implements P.Query<T> {
  constructor(
    readonly db: SqliteDb,
    readonly state: QueryState,
    readonly conv: Conv = null,
  ) {}

  protected next(patch: Partial<QueryState>): SqlQuery<T> {
    return new SqlQuery<T>(this.db, { ...this.state, ...patch }, this.conv);
  }
  where(field: string | P.FieldPath, op: P.WhereFilterOp, value: unknown): SqlQuery<T> {
    const ops: Op[] = [
      '<',
      '<=',
      '==',
      '!=',
      '>=',
      '>',
      'array-contains',
      'in',
      'not-in',
      'array-contains-any',
    ];
    if (!ops.includes(op as Op))
      throw new DbError(
        'INVALID_ARGUMENT',
        `Value for argument "opStr" is invalid. Acceptable values are: ${ops.join(', ')}`,
      );
    if (value === undefined)
      throw new DbError(
        'INVALID_ARGUMENT',
        'Value for argument "value" is not a valid query constraint. Cannot use "undefined" as a Firestore value.',
      );
    return this.next({
      filters: [
        ...this.state.filters,
        { segs: segmentsOf(field as string | FieldPath), op: op as Op, value },
      ],
    });
  }
  orderBy(field: string | P.FieldPath, dir: P.OrderByDirection = 'asc'): SqlQuery<T> {
    if (this.state.start || this.state.end)
      throw new DbError(
        'INVALID_ARGUMENT',
        'Cannot specify an orderBy() constraint after calling startAt(), startAfter(), endBefore() or endAt().',
      );
    return this.next({
      orders: [...this.state.orders, { segs: segmentsOf(field as string | FieldPath), dir }],
    });
  }
  limit(n: number): SqlQuery<T> {
    return this.next({ limit: n, limitToLast: undefined });
  }
  limitToLast(n: number): SqlQuery<T> {
    return this.next({ limitToLast: n, limit: undefined });
  }
  offset(n: number): SqlQuery<T> {
    return this.next({ offset: n });
  }
  private cursor(args: CursorInput, inclusive: boolean): Cursor {
    const [first] = args;
    if (args.length === 1 && first instanceof DocSnap)
      return { snapshot: { path: first.ref.path, doc: first.raw }, inclusive };
    return { values: args as unknown[], inclusive };
  }
  startAt(...args: CursorInput): SqlQuery<T> {
    return this.next({ start: this.cursor(args, true) });
  }
  startAfter(...args: CursorInput): SqlQuery<T> {
    return this.next({ start: this.cursor(args, false) });
  }
  endAt(...args: CursorInput): SqlQuery<T> {
    return this.next({ end: this.cursor(args, true) });
  }
  endBefore(...args: CursorInput): SqlQuery<T> {
    return this.next({ end: this.cursor(args, false) });
  }
  select(...fields: (string | P.FieldPath)[]): SqlQuery<P.DocumentData> {
    return new SqlQuery<P.DocumentData>(
      this.db,
      { ...this.state, select: fields.map((f) => segmentsOf(f as string | FieldPath)) },
      null,
    );
  }
  async get(): Promise<QuerySnap<T>> {
    return this.db.runQuery(this);
  }
  count(): P.AggregateQuery {
    return { get: async () => ({ data: () => ({ count: this.db.countQuery(this) }) }) };
  }
  withConverter<U>(converter: P.FirestoreDataConverter<U> | null): SqlQuery<U> {
    return new SqlQuery<U>(this.db, this.state, converter as Conv);
  }
}

export class ColRef<T = P.DocumentData> extends SqlQuery<T> implements P.CollectionReference<T> {
  readonly id: string;
  constructor(
    db: SqliteDb,
    readonly path: string,
    conv: Conv = null,
  ) {
    const segs = assertColPath(path);
    super(
      db,
      {
        collectionId: segs[segs.length - 1]!,
        parent: segs.slice(0, -1).join('/'),
        filters: [],
        orders: [],
      },
      conv,
    );
    this.id = segs[segs.length - 1]!;
  }
  get parent(): DocRef<P.DocumentData> | null {
    const segs = this.path.split('/');
    return segs.length > 1 ? new DocRef(this.db, segs.slice(0, -1).join('/')) : null;
  }
  doc(id?: string): DocRef<T> {
    return new DocRef<T>(this.db, `${this.path}/${id ?? autoId()}`, this.conv);
  }
  async add(data: P.WithFieldValue<T>): Promise<DocRef<T>> {
    const ref = this.doc();
    await ref.create(data);
    return ref;
  }
  listDocuments(): Promise<DocRef<T>[]> {
    return Promise.resolve(
      this.db.documentsOf(this.path).map((p) => new DocRef<T>(this.db, p, this.conv)),
    );
  }
  override withConverter<U>(converter: P.FirestoreDataConverter<U> | null): ColRef<U> {
    return new ColRef<U>(this.db, this.path, converter as Conv);
  }
}

// ─── transactions, batches ───────────────────────────────────────────────────

interface PendingWrite {
  ref: DocRef<unknown>;
  op: WriteOp;
}

const isReadOptions = (x: unknown): x is P.ReadOptions =>
  !!x && typeof x === 'object' && !(x instanceof DocRef);

class Tx implements P.Transaction {
  readonly reads = new Map<string, number>();
  readonly writes: PendingWrite[] = [];
  constructor(private readonly db: SqliteDb) {}

  private noReadsAfterWrites(): void {
    if (this.writes.length)
      throw new DbError(
        'INVALID_ARGUMENT',
        'Firestore transactions require all reads to be executed before all writes.',
      );
  }
  private remember(snap: DocSnap<unknown>, v: number): void {
    this.reads.set(snap.ref.path, v);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async get(target: any): Promise<any> {
    this.noReadsAfterWrites();
    if (target instanceof DocRef) {
      const { snap, v } = this.db.readDocVersioned(target);
      this.remember(snap, v);
      return snap;
    }
    if (target instanceof SqlQuery) {
      const { snaps, versions } = this.db.queryVersioned(target);
      snaps.forEach((s, i) => this.remember(s, versions[i]!));
      return new QuerySnap(snaps);
    }
    return (target as P.AggregateQuery).get();
  }
  async getAll<T>(...args: Array<P.DocumentReference<T> | P.ReadOptions>): Promise<DocSnap<T>[]> {
    this.noReadsAfterWrites();
    const opts = args.find(isReadOptions);
    return args
      .filter((a): a is DocRef<T> => a instanceof DocRef)
      .map((ref) => {
        const { snap, v } = this.db.readDocVersioned(ref, opts?.fieldMask);
        this.remember(snap, v);
        return snap;
      });
  }
  create<T>(ref: P.DocumentReference<T>, data: P.WithFieldValue<T>): this {
    const r = ref as DocRef<T>;
    this.writes.push({ ref: r as DocRef<unknown>, op: { kind: 'create', data: toStore(r, data) } });
    return this;
  }
  set<T>(
    ref: P.DocumentReference<T>,
    data: P.WithFieldValue<T> | P.PartialWithFieldValue<T>,
    options?: P.SetOptions,
  ): this {
    const r = ref as DocRef<T>;
    this.writes.push({ ref: r as DocRef<unknown>, op: setOp(r, data, options) });
    return this;
  }
  update(ref: P.DocumentReference<unknown>, ...args: unknown[]): this {
    this.writes.push({ ref: ref as DocRef<unknown>, op: { kind: 'update', ...updatePairs(args) } });
    return this;
  }
  delete(ref: P.DocumentReference<unknown>, precondition?: P.Precondition): this {
    this.writes.push({ ref: ref as DocRef<unknown>, op: { kind: 'delete', precondition } });
    return this;
  }
}

class Batch implements P.WriteBatch {
  private readonly tx: Tx;
  private committed = false;
  constructor(private readonly db: SqliteDb) {
    this.tx = new Tx(db);
  }
  create<T>(ref: P.DocumentReference<T>, data: P.WithFieldValue<T>): this {
    this.tx.create(ref, data);
    return this;
  }
  set<T>(
    ref: P.DocumentReference<T>,
    data: P.WithFieldValue<T> | P.PartialWithFieldValue<T>,
    options?: P.SetOptions,
  ): this {
    this.tx.set(ref, data, options);
    return this;
  }
  update(ref: P.DocumentReference<unknown>, ...args: unknown[]): this {
    (this.tx.update as (r: P.DocumentReference<unknown>, ...a: unknown[]) => Tx)(ref, ...args);
    return this;
  }
  delete(ref: P.DocumentReference<unknown>, precondition?: P.Precondition): this {
    this.tx.delete(ref, precondition);
    return this;
  }
  async commit(): Promise<P.WriteResult[]> {
    if (this.committed)
      throw new DbError(
        'FAILED_PRECONDITION',
        'Cannot modify a WriteBatch that has been committed.',
      );
    this.committed = true;
    return this.db.commit(this.tx.writes, new Map());
  }
}

class Bulk implements P.BulkWriter {
  private readonly pending: Promise<unknown>[] = [];
  private retry: ((e: P.BulkWriterError) => boolean) | undefined;
  constructor(private readonly db: SqliteDb) {}
  private run(ref: DocRef<unknown>, op: WriteOp): Promise<P.WriteResult> {
    const attempt = async (n: number): Promise<P.WriteResult> => {
      try {
        return (await this.db.commit([{ ref, op }], new Map()))[0]!;
      } catch (e) {
        const err = e as DbError;
        const info = {
          code: err.code ?? 2,
          message: err.message,
          documentRef: ref,
          failedAttempts: n + 1,
        };
        if (this.retry?.(info) && n < 10) return attempt(n + 1);
        throw e;
      }
    };
    const p = attempt(0);
    this.pending.push(p.catch(() => undefined));
    return p;
  }
  create<T>(ref: P.DocumentReference<T>, data: P.WithFieldValue<T>): Promise<P.WriteResult> {
    const r = ref as DocRef<T>;
    return this.run(r as DocRef<unknown>, { kind: 'create', data: toStore(r, data) });
  }
  set<T>(
    ref: P.DocumentReference<T>,
    data: P.WithFieldValue<T> | P.PartialWithFieldValue<T>,
    options?: P.SetOptions,
  ): Promise<P.WriteResult> {
    const r = ref as DocRef<T>;
    return this.run(r as DocRef<unknown>, setOp(r, data, options));
  }
  update<T>(ref: P.DocumentReference<T>, ...args: unknown[]): Promise<P.WriteResult> {
    return this.run(ref as DocRef<unknown>, { kind: 'update', ...updatePairs(args) });
  }
  delete(ref: P.DocumentReference<unknown>, precondition?: P.Precondition): Promise<P.WriteResult> {
    return this.run(ref as DocRef<unknown>, { kind: 'delete', precondition });
  }
  onWriteError(cb: (e: P.BulkWriterError) => boolean): void {
    this.retry = cb;
  }
  async flush(): Promise<void> {
    await Promise.all(this.pending);
  }
  async close(): Promise<void> {
    await this.flush();
  }
}

// ─── the database ────────────────────────────────────────────────────────────

export class SqliteDb implements P.Db {
  private readonly listeners = new Set<ChangeListener>();

  constructor(readonly store: Store) {}

  readonly isRef = (v: unknown): v is PathLike => v instanceof DocRef;

  doc(path: string): DocRef<P.DocumentData> {
    return new DocRef(this, path);
  }
  collection(path: string): ColRef<P.DocumentData> {
    return new ColRef(this, path);
  }
  collectionGroup(collectionId: string): SqlQuery<P.DocumentData> {
    if (collectionId.includes('/'))
      throw new DbError(
        'INVALID_ARGUMENT',
        `Invalid collectionId '${collectionId}'. Collection IDs must not contain '/'.`,
      );
    return new SqlQuery(this, { collectionId, parent: null, filters: [], orders: [] });
  }
  async getAll<T>(...args: Array<P.DocumentReference<T> | P.ReadOptions>): Promise<DocSnap<T>[]> {
    const opts = args.find(isReadOptions);
    return args
      .filter((a): a is DocRef<T> => a instanceof DocRef)
      .map((ref) => this.readDocVersioned(ref, opts?.fieldMask).snap);
  }
  async runTransaction<T>(
    fn: (tx: P.Transaction) => Promise<T>,
    opts?: { maxAttempts?: number } | { readOnly?: boolean },
  ): Promise<T> {
    const max = (opts && 'maxAttempts' in opts && opts.maxAttempts) || 5;
    let last: unknown;
    for (let attempt = 0; attempt < max; attempt++) {
      const tx = new Tx(this);
      const result = await fn(tx);
      try {
        this.commit(tx.writes, tx.reads);
        return result;
      } catch (e) {
        if ((e as DbError).code !== CODES.ABORTED) throw e;
        last = e;
      }
    }
    throw last;
  }
  batch(): Batch {
    return new Batch(this);
  }
  bulkWriter(): Bulk {
    return new Bulk(this);
  }
  async recursiveDelete(
    ref: P.DocumentReference<unknown> | P.CollectionReference<unknown>,
  ): Promise<void> {
    if (ref instanceof DocRef) this.deleteTree(ref.path, true);
    else this.deleteCollectionTree((ref as ColRef<unknown>).path);
  }
  listCollections(): Promise<ColRef<P.DocumentData>[]> {
    const root = this.store.shard(ROOT);
    return Promise.resolve(
      root
        .collections()
        .filter((c) =>
          root.stmt(`SELECT 1 AS x FROM ${tableName(c)} WHERE parent = '' LIMIT 1`).get(),
        )
        .sort()
        .map((c) => new ColRef(this, c)),
    );
  }

  // ─── change feed ───────────────────────────────────────────────────────────

  /** Listen to every committed change. Returns the unsubscribe. */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(changes: DocChange[]): void {
    if (!changes.length) return;
    for (const l of this.listeners) {
      try {
        l(changes, this);
      } catch (e) {
        console.error('[db] change listener failed', e);
      }
    }
  }

  // ─── reads ─────────────────────────────────────────────────────────────────

  readDocVersioned<T>(
    ref: DocRef<T>,
    mask?: (string | P.FieldPath)[],
  ): { snap: DocSnap<T>; v: number } {
    const at = locate(ref.path);
    const shard = this.store.existing(at.shard);
    const row = shard?.read(at.collectionId, at.parent, at.id);
    const raw = row ? (JSON.parse(row.doc) as Json) : undefined;
    const snap = new DocSnap<T>(
      ref,
      raw,
      row,
      mask?.map((f) => segmentsOf(f as string | FieldPath)),
    );
    return { snap, v: row ? Number(row.v) : 0 };
  }
  /** An encoded document (as a change carries it) → its decoded data. */
  decodeDoc(path: string, raw: Json): Json {
    return new DocSnap(this.doc(path), raw, undefined).data() as Json;
  }
  readDoc<T>(ref: DocRef<T>): DocSnap<T> {
    return this.readDocVersioned(ref).snap;
  }

  private shardsFor(q: QueryState): Shard[] {
    if (q.parent === null) return this.store.all().filter((s) => s.has(q.collectionId));
    const s = this.store.existing(shardOf(`${q.parent ? `${q.parent}/` : ''}${q.collectionId}`));
    return s && s.has(q.collectionId) ? [s] : [];
  }

  private load(shard: Shard, collectionId: string, sql: string, params: unknown[]): LoadedRow[] {
    return (shard.stmt(sql).all(...(params as (string | number | null)[])) as unknown as Row[]).map(
      (r) => ({
        ...r,
        data: JSON.parse(r.doc) as Json,
        path: `${r.parent ? `${r.parent}/` : ''}${collectionId}/${r.id}`,
      }),
    );
  }

  queryVersioned<T>(query: SqlQuery<T>): { snaps: DocSnap<T>[]; versions: number[] } {
    const plan = new Plan(query.state, this.isRef);
    const shards = this.shardsFor(query.state);
    const single = shards.length === 1;
    let rows: LoadedRow[] = [];
    for (const shard of shards) {
      const { sql, params } = plan.sql(tableName(query.state.collectionId), { paged: single });
      rows = rows.concat(this.load(shard, query.state.collectionId, sql, params));
    }
    rows = plan.finish(rows, single);
    const mask = query.state.select;
    const snaps = rows.map(
      (r) => new DocSnap<T>(new DocRef<T>(this, r.path, query.conv), r.data, r, mask),
    );
    return { snaps, versions: rows.map((r) => Number(r.v)) };
  }
  runQuery<T>(query: SqlQuery<T>): QuerySnap<T> {
    return new QuerySnap(this.queryVersioned(query).snaps);
  }
  countQuery(query: SqlQuery<unknown>): number {
    const plan = new Plan(query.state, this.isRef);
    const shards = this.shardsFor(query.state);
    if (
      plan.pureSql &&
      (shards.length <= 1 || (query.state.limit === undefined && !query.state.offset))
    ) {
      let n = 0;
      for (const shard of shards) {
        const { sql, params } = plan.sql(tableName(query.state.collectionId), {
          count: true,
          paged: true,
        });
        n += Number(shard.stmt(sql).get(...(params as (string | number | null)[]))?.n ?? 0);
      }
      return n;
    }
    return this.queryVersioned(query).snaps.length;
  }

  /** Paths of the documents in a collection, including "missing" ones that only have subcollections. */
  documentsOf(colPath: string): string[] {
    const segs = assertColPath(colPath);
    const collectionId = segs[segs.length - 1]!;
    const parent = segs.slice(0, -1).join('/');
    const ids = new Set<string>();
    const home = this.store.existing(shardOf(colPath));
    if (home?.has(collectionId))
      for (const r of home
        .stmt(`SELECT id FROM ${tableName(collectionId)} WHERE parent = ?`)
        .all(parent))
        ids.add(String(r.id));
    // Missing parents: rows below colPath/<id>/… (same shard, or the shard files themselves).
    const prefix = `${colPath}/`;
    if (home)
      for (const c of home.collections())
        for (const r of home
          .stmt(`SELECT DISTINCT parent FROM ${tableName(c)} WHERE substr(parent, 1, ?) = ?`)
          .all(prefix.length, prefix))
          ids.add(String(r.parent).slice(prefix.length).split('/')[0]!);
    if (segs.length === 1 && (SHARD_KINDS as readonly string[]).includes(collectionId))
      for (const s of this.store.all())
        if (s.key.startsWith(prefix)) ids.add(s.key.slice(prefix.length));
    return [...ids].sort().map((id) => `${colPath}/${id}`);
  }

  subcollections(docPath: string): ColRef<P.DocumentData>[] {
    const shard = this.store.existing(shardOf(`${docPath}/x/y`));
    if (!shard) return [];
    return shard
      .collections()
      .filter((c) =>
        shard.stmt(`SELECT 1 AS x FROM ${tableName(c)} WHERE parent = ? LIMIT 1`).get(docPath),
      )
      .sort()
      .map((c) => new ColRef(this, `${docPath}/${c}`));
  }

  // ─── writes ────────────────────────────────────────────────────────────────

  commitOne(ref: DocRef<unknown>, op: WriteOp): Promise<P.WriteResult> {
    try {
      return Promise.resolve(this.commit([{ ref, op }], new Map())[0]!);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** Lock, verify the reads, apply the writes, commit — synchronously. */
  commit(writes: PendingWrite[], reads: Map<string, number>): P.WriteResult[] {
    const keys = new Set<string>();
    for (const p of reads.keys()) keys.add(locate(p).shard);
    for (const w of writes) keys.add(locate(w.ref.path).shard);
    if (!writes.length) {
      // A read-only transaction still fails if what it read moved — but there is nothing to commit.
      return [];
    }
    const shards = [...keys].sort().map((k) => this.store.shard(k));
    const now = Date.now();
    const nowTs = Timestamp.fromMillis(now);
    const changes: DocChange[] = [];
    const begun: Shard[] = [];
    try {
      for (const s of shards) {
        s.conn.exec('BEGIN IMMEDIATE');
        begun.push(s);
      }
      for (const [path, v] of reads) {
        const at = locate(path);
        if (this.store.shard(at.shard).version(at.collectionId, at.parent, at.id) !== v)
          throw new DbError(
            'ABORTED',
            `Transaction lock timeout / contention on ${path}; retrying.`,
          );
      }
      for (const { ref, op } of writes) {
        const at = locate(ref.path);
        const shard = this.store.shard(at.shard);
        const row = shard.read(at.collectionId, at.parent, at.id);
        const before = row ? (JSON.parse(row.doc) as Json) : undefined;
        const after = applyWrite(ref.path, before, op, nowTs, this.isRef);
        if (after === undefined) {
          if (row) shard.remove(at.collectionId, at.parent, at.id);
        } else {
          const size = documentSize(ref.path, after);
          if (size > MAX_DOC_BYTES)
            throw new DbError(
              'INVALID_ARGUMENT',
              `Document '${ref.path}' cannot be written because its size (${size.toLocaleString('en-US')} bytes) exceeds the maximum allowed size of 1,048,576 bytes.`,
            );
          shard.upsert(at.collectionId, {
            parent: at.parent,
            id: at.id,
            doc: JSON.stringify(after),
            v: (row ? Number(row.v) : 0) + 1,
            ct: row ? Number(row.ct) : now,
            ut: now,
          });
        }
        if (before || after)
          changes.push({
            id: autoId(),
            path: ref.path,
            collectionId: at.collectionId,
            time: now,
            before,
            after,
          });
      }
      for (const s of begun) s.conn.exec('COMMIT');
    } catch (e) {
      for (const s of begun) {
        try {
          s.conn.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
      }
      throw e;
    }
    this.emit(changes);
    return writes.map(() => ({ writeTime: nowTs }));
  }

  // ─── recursive delete ──────────────────────────────────────────────────────

  /** Delete a document and everything below it. */
  private deleteTree(docPath: string, self: boolean): void {
    const changes: DocChange[] = [];
    const now = Date.now();
    if (self) {
      const at = locate(docPath);
      const s = this.store.existing(at.shard);
      const row = s?.read(at.collectionId, at.parent, at.id);
      if (row) {
        s!.remove(at.collectionId, at.parent, at.id);
        changes.push({
          id: autoId(),
          path: docPath,
          collectionId: at.collectionId,
          time: now,
          before: JSON.parse(row.doc) as Json,
          after: undefined,
        });
      }
    }
    const below = shardOf(`${docPath}/x/y`);
    if (below !== ROOT && below === docPath) {
      // The document owns a shard: the whole file goes.
      this.store.drop(below);
    } else {
      const shard = this.store.existing(below);
      if (shard) {
        const prefix = `${docPath}/`;
        shard.conn.exec('BEGIN IMMEDIATE');
        try {
          for (const c of shard.collections()) {
            const t = tableName(c);
            const where = `WHERE parent = ? OR substr(parent, 1, ?) = ?`;
            for (const r of shard
              .stmt(`SELECT parent, id, doc FROM ${t} ${where}`)
              .all(docPath, prefix.length, prefix))
              changes.push({
                id: autoId(),
                path: `${String(r.parent)}/${c}/${String(r.id)}`,
                collectionId: c,
                time: now,
                before: JSON.parse(String(r.doc)) as Json,
                after: undefined,
              });
            shard.stmt(`DELETE FROM ${t} ${where}`).run(docPath, prefix.length, prefix);
          }
          shard.conn.exec('COMMIT');
        } catch (e) {
          shard.conn.exec('ROLLBACK');
          throw e;
        }
      }
    }
    this.emit(changes);
  }

  private deleteCollectionTree(colPath: string): void {
    for (const doc of this.documentsOf(colPath)) this.deleteTree(doc, true);
  }

  /** Remove every document in every shard (tests). */
  wipe(): void {
    this.store.wipe();
  }
}
