/**
 * THE DATABASE PORT — the one document-database API every module talks to.
 *
 * It is Firestore-SHAPED on purpose: documents in collections, refs, queries,
 * transactions, batches. That shape is what the whole backend was written
 * against, and it maps cleanly onto any store that can hold "a JSON document
 * at a path": Firestore itself, SQLite ({parent, id, doc} rows), Postgres
 * (jsonb), … A new store is a new ADAPTER (src/db/<name>/) that implements
 * these interfaces; no command, trigger or job changes.
 *
 * Rules for code above the port:
 *   - import types and values (FieldValue, FieldPath, Timestamp …) from
 *     'src/db/index.js', never from 'firebase-admin/firestore';
 *   - get the database with db(); never construct a store client;
 *   - use only what is declared here. If a module needs more, add it here
 *     AND to every adapter (and to test/db/port.test.ts).
 *
 * The declarations mirror the subset of the Admin SDK the code uses, so the
 * Firestore adapter is the SDK itself with no wrapper (src/db/firestore.ts).
 */

// ─── values ──────────────────────────────────────────────────────────────────

/** A point in time with nanosecond precision; stored as a timestamp. */
export interface Timestamp {
  readonly seconds: number;
  readonly nanoseconds: number;
  toDate(): Date;
  toMillis(): number;
  isEqual(other: Timestamp): boolean;
  valueOf(): string;
}
export interface TimestampStatic {
  new (seconds: number, nanoseconds: number): Timestamp;
  readonly prototype: Timestamp;
  now(): Timestamp;
  fromDate(date: Date): Timestamp;
  fromMillis(millis: number): Timestamp;
}

/** A write sentinel: increment, arrayUnion, arrayRemove, delete, serverTimestamp. */
export interface FieldValue {
  isEqual(other: FieldValue): boolean;
}
export interface FieldValueStatic {
  /** Not for construction — present so `x instanceof FieldValue` type-checks. */
  new (...args: never[]): FieldValue;
  readonly prototype: FieldValue;
  increment(n: number): FieldValue;
  arrayUnion(...elements: unknown[]): FieldValue;
  arrayRemove(...elements: unknown[]): FieldValue;
  delete(): FieldValue;
  serverTimestamp(): FieldValue;
}

/** A field path given as segments (keys may contain dots), or the document id. */
export interface FieldPath {
  isEqual(other: FieldPath): boolean;
}
export interface FieldPathStatic {
  new (...segments: string[]): FieldPath;
  readonly prototype: FieldPath;
  documentId(): FieldPath;
}

export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
  isEqual(other: GeoPoint): boolean;
}
export interface GeoPointStatic {
  new (latitude: number, longitude: number): GeoPoint;
  readonly prototype: GeoPoint;
}

// ─── documents ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DocumentData = { [field: string]: any };

type Primitive = string | number | boolean | undefined | null;

/** A full document, any field of which may be a sentinel. */
export type WithFieldValue<T> =
  | T
  | (T extends Primitive
      ? T
      : T extends object
        ? { [K in keyof T]: WithFieldValue<T[K]> | FieldValue }
        : never);

/** A partial document (merge set), any field of which may be a sentinel. */
export type PartialWithFieldValue<T> =
  | Partial<T>
  | (T extends Primitive
      ? T
      : T extends object
        ? { [K in keyof T]?: PartialWithFieldValue<T[K]> | FieldValue }
        : never);

/** update(): top-level keys, or dotted paths ('counts.active'), to values or sentinels. */
export type UpdateData<T> =
  | (T extends Primitive
      ? T
      : T extends object
        ? { [K in keyof T]?: UpdateData<T[K]> | FieldValue }
        : Partial<T>)
  | { [path: string]: unknown };

export interface SetOptions {
  readonly merge?: boolean;
  readonly mergeFields?: Array<string | FieldPath>;
}
export interface Precondition {
  readonly lastUpdateTime?: Timestamp;
  readonly exists?: boolean;
}
export interface WriteResult {
  readonly writeTime: Timestamp;
}

export interface FirestoreDataConverter<T> {
  toFirestore(modelObject: WithFieldValue<T>): DocumentData;
  toFirestore(modelObject: PartialWithFieldValue<T>, options: SetOptions): DocumentData;
  fromFirestore(snapshot: QueryDocumentSnapshot): T;
}

export interface DocumentSnapshot<T = DocumentData> {
  readonly exists: boolean;
  readonly ref: DocumentReference<T>;
  readonly id: string;
  readonly createTime?: Timestamp;
  readonly updateTime?: Timestamp;
  readonly readTime: Timestamp;
  data(): T | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(field: string | FieldPath): any;
}
export interface QueryDocumentSnapshot<T = DocumentData> extends DocumentSnapshot<T> {
  readonly createTime: Timestamp;
  readonly updateTime: Timestamp;
  data(): T;
}

export interface DocumentReference<T = DocumentData> {
  readonly id: string;
  readonly path: string;
  readonly parent: CollectionReference<T>;
  collection(collectionPath: string): CollectionReference<DocumentData>;
  listCollections(): Promise<CollectionReference<DocumentData>[]>;
  get(): Promise<DocumentSnapshot<T>>;
  create(data: WithFieldValue<T>): Promise<WriteResult>;
  set(data: WithFieldValue<T>): Promise<WriteResult>;
  set(data: PartialWithFieldValue<T>, options: SetOptions): Promise<WriteResult>;
  update(data: UpdateData<T>, precondition?: Precondition): Promise<WriteResult>;
  update(
    field: string | FieldPath,
    value: unknown,
    ...moreFieldsOrPrecondition: unknown[]
  ): Promise<WriteResult>;
  delete(precondition?: Precondition): Promise<WriteResult>;
  isEqual(other: DocumentReference<T>): boolean;
  withConverter<U>(converter: FirestoreDataConverter<U>): DocumentReference<U>;
  withConverter(converter: null): DocumentReference<DocumentData>;
}

// ─── queries ─────────────────────────────────────────────────────────────────

export type WhereFilterOp =
  '<' | '<=' | '==' | '!=' | '>=' | '>' | 'array-contains' | 'in' | 'not-in' | 'array-contains-any';
export type OrderByDirection = 'desc' | 'asc';

export interface QuerySnapshot<T = DocumentData> {
  readonly docs: QueryDocumentSnapshot<T>[];
  readonly size: number;
  readonly empty: boolean;
  readonly readTime: Timestamp;
  forEach(callback: (result: QueryDocumentSnapshot<T>) => void): void;
}

export interface AggregateQuerySnapshot {
  data(): { count: number };
}
export interface AggregateQuery {
  get(): Promise<AggregateQuerySnapshot>;
}

export interface Query<T = DocumentData> {
  where(fieldPath: string | FieldPath, opStr: WhereFilterOp, value: unknown): Query<T>;
  orderBy(fieldPath: string | FieldPath, directionStr?: OrderByDirection): Query<T>;
  limit(limit: number): Query<T>;
  limitToLast(limit: number): Query<T>;
  offset(offset: number): Query<T>;
  startAt(snapshot: DocumentSnapshot<unknown>): Query<T>;
  startAt(...fieldValues: unknown[]): Query<T>;
  startAfter(snapshot: DocumentSnapshot<unknown>): Query<T>;
  startAfter(...fieldValues: unknown[]): Query<T>;
  endBefore(snapshot: DocumentSnapshot<unknown>): Query<T>;
  endBefore(...fieldValues: unknown[]): Query<T>;
  endAt(snapshot: DocumentSnapshot<unknown>): Query<T>;
  endAt(...fieldValues: unknown[]): Query<T>;
  select(...field: (string | FieldPath)[]): Query<DocumentData>;
  get(): Promise<QuerySnapshot<T>>;
  count(): AggregateQuery;
  withConverter<U>(converter: FirestoreDataConverter<U>): Query<U>;
  withConverter(converter: null): Query<DocumentData>;
}

export interface CollectionReference<T = DocumentData> extends Query<T> {
  readonly id: string;
  readonly path: string;
  readonly parent: DocumentReference<DocumentData> | null;
  doc(documentPath?: string): DocumentReference<T>;
  add(data: WithFieldValue<T>): Promise<DocumentReference<T>>;
  listDocuments(): Promise<DocumentReference<T>[]>;
  withConverter<U>(converter: FirestoreDataConverter<U>): CollectionReference<U>;
  withConverter(converter: null): CollectionReference<DocumentData>;
}

export type CollectionGroup<T = DocumentData> = Query<T>;

// ─── writes ──────────────────────────────────────────────────────────────────

export interface ReadOptions {
  readonly fieldMask?: (string | FieldPath)[];
}

export interface Transaction {
  get<T>(query: Query<T>): Promise<QuerySnapshot<T>>;
  get<T>(documentRef: DocumentReference<T>): Promise<DocumentSnapshot<T>>;
  get(aggregateQuery: AggregateQuery): Promise<AggregateQuerySnapshot>;
  getAll<T>(
    ...documentRefsOrReadOptions: Array<DocumentReference<T> | ReadOptions>
  ): Promise<DocumentSnapshot<T>[]>;
  create<T>(documentRef: DocumentReference<T>, data: WithFieldValue<T>): Transaction;
  set<T>(documentRef: DocumentReference<T>, data: WithFieldValue<T>): Transaction;
  set<T>(
    documentRef: DocumentReference<T>,
    data: PartialWithFieldValue<T>,
    options: SetOptions,
  ): Transaction;
  update<T>(
    documentRef: DocumentReference<T>,
    data: UpdateData<T>,
    precondition?: Precondition,
  ): Transaction;
  update(
    documentRef: DocumentReference<unknown>,
    field: string | FieldPath,
    value: unknown,
    ...fieldsOrPrecondition: unknown[]
  ): Transaction;
  delete(documentRef: DocumentReference<unknown>, precondition?: Precondition): Transaction;
}

export interface WriteBatch {
  create<T>(documentRef: DocumentReference<T>, data: WithFieldValue<T>): WriteBatch;
  set<T>(documentRef: DocumentReference<T>, data: WithFieldValue<T>): WriteBatch;
  set<T>(
    documentRef: DocumentReference<T>,
    data: PartialWithFieldValue<T>,
    options: SetOptions,
  ): WriteBatch;
  update<T>(
    documentRef: DocumentReference<T>,
    data: UpdateData<T>,
    precondition?: Precondition,
  ): WriteBatch;
  update(
    documentRef: DocumentReference<unknown>,
    field: string | FieldPath,
    value: unknown,
    ...fieldsOrPrecondition: unknown[]
  ): WriteBatch;
  delete(documentRef: DocumentReference<unknown>, precondition?: Precondition): WriteBatch;
  commit(): Promise<WriteResult[]>;
}

export interface BulkWriterError {
  readonly code: number;
  readonly message: string;
  readonly documentRef: DocumentReference<unknown>;
  readonly failedAttempts: number;
}

export interface BulkWriter {
  create<T>(documentRef: DocumentReference<T>, data: WithFieldValue<T>): Promise<WriteResult>;
  set<T>(documentRef: DocumentReference<T>, data: WithFieldValue<T>): Promise<WriteResult>;
  set<T>(
    documentRef: DocumentReference<T>,
    data: PartialWithFieldValue<T>,
    options: SetOptions,
  ): Promise<WriteResult>;
  update<T>(
    documentRef: DocumentReference<T>,
    data: UpdateData<T>,
    precondition?: Precondition,
  ): Promise<WriteResult>;
  delete(
    documentRef: DocumentReference<unknown>,
    precondition?: Precondition,
  ): Promise<WriteResult>;
  onWriteError(shouldRetryCallback: (error: BulkWriterError) => boolean): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface BulkWriterOptions {
  readonly throttling?: boolean | { initialOpsPerSecond?: number; maxOpsPerSecond?: number };
}

// ─── the database ────────────────────────────────────────────────────────────

export interface Db {
  doc(documentPath: string): DocumentReference<DocumentData>;
  collection(collectionPath: string): CollectionReference<DocumentData>;
  collectionGroup(collectionId: string): CollectionGroup<DocumentData>;
  getAll<T>(
    ...documentRefsOrReadOptions: Array<DocumentReference<T> | ReadOptions>
  ): Promise<DocumentSnapshot<T>[]>;
  runTransaction<T>(
    updateFunction: (transaction: Transaction) => Promise<T>,
    transactionOptions?: { maxAttempts?: number } | { readOnly?: boolean },
  ): Promise<T>;
  batch(): WriteBatch;
  bulkWriter(options?: BulkWriterOptions): BulkWriter;
  /** Delete a document or collection and EVERYTHING below it. */
  recursiveDelete(
    ref: DocumentReference<unknown> | CollectionReference<unknown>,
    bulkWriter?: BulkWriter,
  ): Promise<void>;
  listCollections(): Promise<CollectionReference<DocumentData>[]>;
}

/** What an adapter supplies: the database plus its value classes. */
export interface DbAdapter {
  readonly name: string;
  db(): Db;
  readonly Timestamp: TimestampStatic;
  readonly FieldValue: FieldValueStatic;
  readonly FieldPath: FieldPathStatic;
  readonly GeoPoint: GeoPointStatic;
  /** The constructor `instanceof` matches a document reference stored as a VALUE. */
  readonly DocumentReference: {
    new (...args: never[]): DocumentReference<unknown>;
    readonly prototype: DocumentReference<unknown>;
  };
}
