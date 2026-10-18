/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * THE TICKET ROUTER — the database port (../types.ts), with every path under
 * boards/{b}/tickets/ sent to where that board keeps its tickets.
 *
 *   a board without `storage`        → the database adapter, untouched
 *   a board with storage.kind 'drive' → its Drive folder (files.ts)
 *
 * Nothing above the port changes: commands, triggers and readers keep
 * calling db().doc(paths.ticket(b, t)), tx.get, tx.update, queries on
 * paths.tickets(b) and collectionGroup('tickets'). For a managed board every
 * call is the adapter's own (the only cost: one cached board read per few
 * seconds). For a Drive board:
 *
 *   reads        files.ts (one listing + changed files; the rest cached)
 *   queries      evaluated in memory with the SQLite adapter's exact
 *                Firestore semantics (sqlite/query.ts); a list carries
 *                meta.json only — no thread
 *   collectionGroup('tickets')   the database's answer merged with every
 *                Drive board's, then ordered and limited as one
 *   writes       staged; at the end of the transaction the Drive tickets it
 *                changes are leased and checked (lease.ts), the database
 *                commits, the files are written, the lease is given back
 *                with a new version (the ping open screens refetch on), and
 *                onTicketWritten runs as Firestore would have run it
 */
import { randomUUID } from 'node:crypto';
import { errors } from '@tm/shared';
import { applyWrite, updatePairs, type WriteOp } from '../sqlite/mutate.js';
import { Plan, type QueryState } from '../sqlite/query.js';
import { DOC_ID, Timestamp as SqlTimestamp } from '../sqlite/values.js';
import type * as P from '../types.js';
import {
  assertNotMoving,
  driveBoardIds,
  driveBoardOf,
  driveOf,
} from './board.js';
import {
  listTickets,
  readMeta,
  readPage,
  readPages,
  readTicket,
  trashTicket,
  writePage,
  writeTicket,
  type DriveBoard,
  type TicketFiles,
} from './files.js';
import { acquire, pointersOf, readRev, release, REV_COLLECTION } from './lease.js';
import { decodeJson, encodeJson, foreignSegments, isRefValue, toLocal } from './values.js';

type Json = Record<string, unknown>;
type Conv = P.FirestoreDataConverter<any> | null;

// ─── paths ───────────────────────────────────────────────────────────────────

/** boards/{b}/tickets/{t}[/{sub}/{subId}…] */
interface DocLoc {
  boardId: string;
  ticketId: string;
  /** null = the ticket document; 'data' = a page; anything else is a legacy subcollection. */
  sub: string | null;
  subId: string | null;
}

export function docLoc(path: string): DocLoc | null {
  const s = path.split('/');
  if (s[0] !== 'boards' || s[2] !== 'tickets' || s.length < 4 || s.length % 2 !== 0) return null;
  return {
    boardId: s[1]!,
    ticketId: s[3]!,
    sub: s.length >= 6 ? s[4]! : null,
    subId: s.length >= 6 ? s[5]! : null,
  };
}

/** boards/{b}/tickets, or boards/{b}/tickets/{t}/{sub} */
function colLoc(path: string): { boardId: string; ticketId: string | null; sub: string | null } | null {
  const s = path.split('/');
  if (s[0] !== 'boards' || s[2] !== 'tickets' || s.length % 2 !== 1) return null;
  if (s.length === 3) return { boardId: s[1]!, ticketId: null, sub: null };
  return { boardId: s[1]!, ticketId: s[3]!, sub: s[4] ?? null };
}

const keyOf = (l: { boardId: string; ticketId: string }) => `${l.boardId}/${l.ticketId}`;
const lastSeg = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));

function segsOf(field: unknown): string[] {
  if (typeof field === 'string') return field.split('.');
  const s = foreignSegments(field);
  if (!s) throw errors.invalid('Invalid field path');
  return s;
}

class DriveRetry extends Error {
  constructor() {
    super('A Drive ticket changed while this transaction ran');
  }
}

function getAt(doc: unknown, segs: readonly string[]): unknown {
  let cur = doc;
  for (const s of segs) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Json)[s];
  }
  return cur;
}

// ─── snapshots ───────────────────────────────────────────────────────────────

class RDocSnap<T = P.DocumentData> implements P.QueryDocumentSnapshot<T> {
  readonly exists: boolean;
  readonly createTime: P.Timestamp;
  readonly updateTime: P.Timestamp;
  readonly readTime: P.Timestamp;
  private decoded: Json | undefined;
  constructor(
    readonly ref: RDocRef<T>,
    /** Encoded document; undefined = missing. */
    readonly raw: Json | undefined,
  ) {
    this.exists = raw !== undefined;
    const now = ref.db.Ts.now();
    this.createTime = now;
    this.updateTime = now;
    this.readTime = now;
  }
  get id(): string {
    return this.ref.id;
  }
  rawData(): Json | undefined {
    if (this.raw === undefined) return undefined;
    this.decoded ??= decodeJson(this.raw, this.ref.db.Ts) as Json;
    return this.decoded;
  }
  data(): T {
    if (!this.exists) return undefined as T;
    if (this.ref.conv) {
      const plain = new RDocSnap(this.ref.withConverter(null) as RDocRef<any>, this.raw);
      return this.ref.conv.fromFirestore(plain as unknown as P.QueryDocumentSnapshot) as T;
    }
    return this.rawData() as T;
  }
  get(field: string | P.FieldPath): any {
    const segs = segsOf(field);
    return getAt(this.rawData(), segs);
  }
}

class RQuerySnap<T> implements P.QuerySnapshot<T> {
  readonly readTime: P.Timestamp;
  constructor(
    readonly docs: P.QueryDocumentSnapshot<T>[],
    Ts: P.TimestampStatic,
  ) {
    this.readTime = Ts.now();
  }
  get size() {
    return this.docs.length;
  }
  get empty() {
    return this.docs.length === 0;
  }
  forEach(cb: (d: P.QueryDocumentSnapshot<T>) => void) {
    this.docs.forEach(cb);
  }
}

// ─── writes ──────────────────────────────────────────────────────────────────

type Method = 'create' | 'set' | 'update' | 'delete';

/** A write call on a routed ref → the SQLite adapter's WriteOp (local value classes). */
function toOp(ref: RDocRef<any>, method: Method, args: unknown[]): WriteOp {
  switch (method) {
    case 'create': {
      const data = ref.conv ? ref.conv.toFirestore(args[0] as any) : args[0];
      return { kind: 'create', data: toLocal(data) as Json };
    }
    case 'set': {
      const options = args[1] as P.SetOptions | undefined;
      const data = ref.conv
        ? options
          ? ref.conv.toFirestore(args[0] as any, options)
          : ref.conv.toFirestore(args[0] as any)
        : args[0];
      return {
        kind: 'set',
        data: toLocal(data) as Json,
        ...(options?.merge ? { merge: true } : {}),
        ...(options?.mergeFields ? { mergeFields: options.mergeFields.map(segsOf) } : {}),
      };
    }
    case 'update': {
      const { pairs, precondition } = updatePairs(args.map(toLocal));
      return { kind: 'update', pairs, ...(precondition ? { precondition } : {}) };
    }
    case 'delete':
      return { kind: 'delete', ...(args[0] ? { precondition: args[0] as { exists?: boolean } } : {}) };
  }
}

/** All the staged writes to ONE Drive ticket (its document and its pages). */
interface Work {
  b: DriveBoard;
  boardId: string;
  ticketId: string;
  ticketOps: { path: string; op: WriteOp }[];
  pageOps: Map<string, WriteOp[]>;
  /** What the transaction read (its version and files), if it did. */
  read?: { v: number | null; files: TicketFiles | null };
}

/** A prepared write: leased, checked, computed; written after the database commits. */
interface Prepared {
  work: Work;
  before: TicketFiles | null;
  beforeDoc: Json | undefined;
  afterDoc: Json | undefined;
  ticketChanged: boolean;
  pages: { id: string; doc: Json | undefined }[];
}

// ─── the database ────────────────────────────────────────────────────────────

export class RoutedDb implements P.Db {
  constructor(
    readonly base: P.Db,
    readonly Ts: P.TimestampStatic,
  ) {}

  mode(boardId: string): Promise<DriveBoard | null> {
    return driveBoardOf(this.base, boardId);
  }

  doc(path: string): P.DocumentReference<P.DocumentData> {
    return docLoc(path) ? new RDocRef(this, path, null) : this.base.doc(path);
  }
  collection(path: string): P.CollectionReference<P.DocumentData> {
    return colLoc(path) ? new RColRef(this, path, null) : this.base.collection(path);
  }
  collectionGroup(id: string): P.CollectionGroup<P.DocumentData> {
    return id === 'tickets' ? new RQuery(this, { group: 'tickets' }, [], null) : this.base.collectionGroup(id);
  }

  async getAll<T>(...args: Array<P.DocumentReference<T> | P.ReadOptions>): Promise<P.DocumentSnapshot<T>[]> {
    const refs = args.filter((a): a is P.DocumentReference<T> => typeof (a as any)?.path === 'string');
    const opts = args.filter((a) => typeof (a as any)?.path !== 'string') as P.ReadOptions[];
    const baseRefs = refs.filter((r) => !(r instanceof RDocRef));
    const baseSnaps = baseRefs.length ? await this.base.getAll<T>(...baseRefs, ...opts) : [];
    const byPath = new Map(baseSnaps.map((s) => [s.ref.path, s]));
    return Promise.all(
      refs.map(async (r) => (r instanceof RDocRef ? r.get() : byPath.get(r.path)!)),
    ) as Promise<P.DocumentSnapshot<T>[]>;
  }

  async runTransaction<T>(
    fn: (tx: P.Transaction) => Promise<T>,
    options?: { maxAttempts?: number } | { readOnly?: boolean },
  ): Promise<T> {
    const holder = randomUUID();
    const leased = new Map<string, Work>();
    for (let attempt = 1; ; attempt++) {
      let prepared: Prepared[] = [];
      try {
        const result = await this.base.runTransaction(async (btx) => {
          const rtx = new RTx(this, btx);
          const out = await fn(rtx);
          prepared = await rtx.flush(holder, leased);
          return out;
        }, options as any);
        await this.finish(prepared, holder, leased);
        return result;
      } catch (e) {
        await Promise.all(
          [...leased.values()].map((w) => release(this.base, w.boardId, w.ticketId, holder, null)),
        );
        leased.clear();
        if (e instanceof DriveRetry && attempt < 6) continue;
        if (e instanceof DriveRetry)
          throw errors.unavailable('This ticket keeps changing; try again in a moment');
        throw e;
      }
    }
  }

  batch(): P.WriteBatch {
    return new RBatch(this, this.base.batch());
  }
  bulkWriter(options?: P.BulkWriterOptions): P.BulkWriter {
    return new RBulk(this, this.base.bulkWriter(options));
  }

  async recursiveDelete(
    ref: P.DocumentReference<unknown> | P.CollectionReference<unknown>,
    bulkWriter?: P.BulkWriter,
  ): Promise<void> {
    if (ref instanceof RDocRef) {
      const l = docLoc(ref.path)!;
      const b = await this.mode(l.boardId);
      if (!b) return this.base.recursiveDelete(this.base.doc(ref.path), bulkWriter);
      if (l.sub === null) await this.writeNow([[ref, 'delete', []]]);
      else if (l.sub === 'data') await this.writeNow([[ref, 'delete', []]]);
      return;
    }
    if (ref instanceof RColRef) {
      const l = colLoc(ref.path)!;
      const b = await this.mode(l.boardId);
      if (!b) return this.base.recursiveDelete(this.base.collection(ref.path), bulkWriter);
      const snap = await ref.get();
      await this.writeNow(snap.docs.map((d) => [d.ref as RDocRef<any>, 'delete', []]));
      return;
    }
    const s = ref.path.split('/');
    const b = s.length === 2 && s[0] === 'boards' ? await this.mode(s[1]!) : null;
    await this.base.recursiveDelete(ref, bulkWriter);
    // A Drive board's tickets go to Drive's trash with it (restorable there for 30 days).
    if (b) {
      const drive = await driveOf(b);
      const { ticketsFolder } = await import('./files.js');
      await drive.trash(await ticketsFolder(drive, b)).catch(() => undefined);
    }
  }

  listCollections(): Promise<P.CollectionReference<P.DocumentData>[]> {
    return this.base.listCollections();
  }

  // ─── Drive reads ───────────────────────────────────────────────────────────

  /** The encoded document at a routed path of a Drive board (+ what a writer needs). */
  async readDrive(
    b: DriveBoard,
    l: DocLoc,
  ): Promise<{ doc: Json | undefined; v: number | null; files: TicketFiles | null }> {
    const rev = await readRev(this.base, l.boardId, l.ticketId);
    const v = rev?.v ?? null;
    if (l.sub !== null && l.sub !== 'data') return { doc: undefined, v, files: null };
    const drive = await driveOf(b);
    if (l.sub === 'data') {
      const doc = rev && !rev.folderId && rev.v ? undefined : await readPage(drive, b, l.ticketId, l.subId!);
      return { doc, v, files: null };
    }
    if (rev && !rev.folderId && rev.v) return { doc: undefined, v, files: null }; // deleted
    const files = await readTicket(drive, b, l.ticketId, pointersOf(rev));
    return { doc: files?.doc, v, files };
  }

  /** Rows of a routed collection of a Drive board, for the in-memory planner. */
  async driveRows(b: DriveBoard, colPath: string): Promise<{ id: string; path: string; data: Json }[]> {
    const l = colLoc(colPath)!;
    const drive = await driveOf(b);
    if (l.ticketId === null) {
      const listed = await listTickets(drive, b);
      const seen = new Set(listed.map((t) => t.id));
      const rows = listed.map((t) => ({ id: t.id, path: `${colPath}/${t.id}`, data: t.doc }));
      // Drive's search can trail a just-made file by a little: the revs written lately fill the gap.
      const recent = await this.base
        .collection(`boards/${l.boardId}/${REV_COLLECTION}`)
        .where('at', '>', Date.now() - 120_000)
        .get();
      const missing = recent.docs.filter((d) => !seen.has(d.id) && (d.data() as any).metaId);
      const extra = await Promise.all(
        missing.map(async (d) => ({ id: d.id, doc: await readMeta(drive, (d.data() as any).metaId) })),
      );
      for (const x of extra)
        if (x.doc) rows.push({ id: x.id, path: `${colPath}/${x.id}`, data: x.doc });
      // …and a ticket deleted a moment ago may still be found: its rev says so.
      const gone = new Set(
        recent.docs.filter((d) => !(d.data() as any).folderId).map((d) => d.id),
      );
      return rows.filter((r) => !gone.has(r.id));
    }
    if (l.sub === 'data') {
      const pages = await readPages(drive, b, l.ticketId);
      return pages.map((p) => ({ id: p.id, path: `${colPath}/${p.id}`, data: p.doc }));
    }
    return [];
  }

  // ─── Drive writes ──────────────────────────────────────────────────────────

  /** Group staged writes by ticket. */
  workOf(b: DriveBoard, ref: RDocRef<any>, op: WriteOp, works: Map<string, Work>): void {
    const l = docLoc(ref.path)!;
    if (l.sub !== null && l.sub !== 'data')
      throw errors.invalid(`A Drive board keeps no ${l.sub}/ documents`);
    const key = keyOf(l);
    let w = works.get(key);
    if (!w) {
      w = { b, boardId: l.boardId, ticketId: l.ticketId, ticketOps: [], pageOps: new Map() };
      works.set(key, w);
    }
    if (l.sub === null) w.ticketOps.push({ path: ref.path, op });
    else {
      const list = w.pageOps.get(l.subId!) ?? [];
      list.push(op);
      w.pageOps.set(l.subId!, list);
    }
  }

  /** Lease every ticket (path order), check what was read is current, compute the new files. */
  async prepare(works: Work[], holder: string, leased: Map<string, Work>): Promise<Prepared[]> {
    const out: Prepared[] = [];
    const sorted = [...works].sort((a, z) => (keyOf(a) < keyOf(z) ? -1 : 1));
    for (const w of sorted) {
      await assertNotMoving(this.base, w.boardId);
      const rev = await acquire(this.base, w.boardId, w.ticketId, holder);
      leased.set(keyOf(w), w);
      const v = rev?.v ?? null;
      if (w.read && w.read.v !== v) throw new DriveRetry();
      const drive = await driveOf(w.b);
      const deleted = !!rev && !rev.folderId && !!rev.v;
      const before =
        w.read?.files ?? (deleted ? null : await readTicket(drive, w.b, w.ticketId, pointersOf(rev)));
      const beforeDoc = before?.doc;
      const now = SqlTimestamp.now();
      let doc = beforeDoc;
      for (const { path, op } of w.ticketOps) doc = applyWrite(path, doc, op, now, isRefValue);
      const pages: Prepared['pages'] = [];
      for (const [id, ops] of w.pageOps) {
        let page = deleted ? undefined : await readPage(drive, w.b, w.ticketId, id);
        const path = `boards/${w.boardId}/tickets/${w.ticketId}/data/${id}`;
        for (const op of ops) page = applyWrite(path, page, op, now, isRefValue);
        pages.push({ id, doc: page });
      }
      out.push({
        work: w,
        before,
        beforeDoc,
        afterDoc: doc,
        ticketChanged: w.ticketOps.length > 0 && JSON.stringify(beforeDoc) !== JSON.stringify(doc),
        pages,
      });
    }
    return out;
  }

  /** After the database committed: write the files, give the leases back with a new version, fire onTicketWritten. */
  async finish(prepared: Prepared[], holder: string, leased: Map<string, Work>): Promise<void> {
    let failed: unknown = null;
    await Promise.all(
      prepared.map(async (p) => {
        const { b, boardId, ticketId } = p.work;
        try {
          const drive = await driveOf(b);
          let ptr = p.before?.ptr ?? null;
          for (const page of p.pages) await writePage(drive, b, ticketId, page.id, page.doc);
          if (p.ticketChanged) {
            if (p.afterDoc === undefined) await trashTicket(drive, b, ticketId, p.before?.ptr);
            else ptr = await writeTicket(drive, b, ticketId, p.before, p.afterDoc);
          }
          const changed = p.ticketChanged || p.pages.length > 0;
          await release(
            this.base,
            boardId,
            ticketId,
            holder,
            changed ? (p.ticketChanged && p.afterDoc === undefined ? { deleted: true } : { ptr }) : null,
          );
          if (p.ticketChanged) void this.fire(boardId, ticketId, p.beforeDoc, p.afterDoc);
        } catch (e) {
          console.error(`[drive] writing ${boardId}/${ticketId} failed`, e);
          failed = e;
          await release(this.base, boardId, ticketId, holder, null);
        } finally {
          leased.delete(`${boardId}/${ticketId}`);
        }
      }),
    );
    // Leased but nothing to write (read in the tx, unchanged): just give back.
    await Promise.all(
      [...leased.values()].map((w) => release(this.base, w.boardId, w.ticketId, holder, null)),
    );
    leased.clear();
    if (failed)
      throw errors.unavailable(
        'Google Drive did not take the change in full; reload the ticket and try again',
      );
  }

  /** onTicketWritten, as Firestore would deliver it (counts; a Drive board is not search-indexed). */
  async fire(boardId: string, ticketId: string, before: Json | undefined, after: Json | undefined) {
    try {
      const { handleTicketWritten } = await import('../../triggers/onTicketWritten.js');
      const path = `boards/${boardId}/tickets/${ticketId}`;
      const snap = (raw: Json | undefined) => new RDocSnap(new RDocRef(this, path, null), raw);
      await handleTicketWritten({
        id: randomUUID(),
        time: new Date().toISOString(),
        params: { boardId, ticketId },
        data: { before: snap(before), after: snap(after) },
      } as any);
    } catch (e) {
      console.error(`[drive] onTicketWritten ${boardId}/${ticketId} failed`, e);
    }
  }

  /** Writes outside a transaction (a ref's own set/update, a batch, a bulk writer): lease, read, write. */
  async writeNow(calls: [RDocRef<any>, Method, unknown[]][]): Promise<void> {
    const works = new Map<string, Work>();
    const managed: [RDocRef<any>, Method, unknown[]][] = [];
    for (const [ref, method, args] of calls) {
      const b = await this.mode(docLoc(ref.path)!.boardId);
      if (!b) managed.push([ref, method, args]);
      else this.workOf(b, ref, toOp(ref, method, args), works);
    }
    for (const [ref, method, args] of managed) await (ref.baseRef() as any)[method](...args);
    if (!works.size) return;
    const holder = randomUUID();
    const leased = new Map<string, Work>();
    try {
      const prepared = await this.prepare([...works.values()], holder, leased);
      await this.finish(prepared, holder, leased);
    } catch (e) {
      await Promise.all(
        [...leased.values()].map((w) => release(this.base, w.boardId, w.ticketId, holder, null)),
      );
      throw e;
    }
  }
}

// ─── references ──────────────────────────────────────────────────────────────

const WRITE_RESULT = (Ts: P.TimestampStatic): P.WriteResult => ({ writeTime: Ts.now() });

export class RDocRef<T = P.DocumentData> implements P.DocumentReference<T> {
  constructor(
    readonly db: RoutedDb,
    readonly path: string,
    readonly conv: Conv,
  ) {}
  get id(): string {
    return lastSeg(this.path);
  }
  get parent(): P.CollectionReference<T> {
    return new RColRef<T>(this.db, parentOf(this.path), this.conv);
  }
  collection(sub: string): P.CollectionReference<P.DocumentData> {
    return this.db.collection(`${this.path}/${sub}`);
  }
  baseRef(): P.DocumentReference<T> {
    const r = this.db.base.doc(this.path);
    return (this.conv ? r.withConverter(this.conv) : r) as P.DocumentReference<T>;
  }
  async listCollections(): Promise<P.CollectionReference<P.DocumentData>[]> {
    const b = await this.db.mode(docLoc(this.path)!.boardId);
    return b ? [] : this.db.base.doc(this.path).listCollections();
  }
  async get(): Promise<P.DocumentSnapshot<T>> {
    const l = docLoc(this.path)!;
    const b = await this.db.mode(l.boardId);
    if (!b) return this.baseRef().get();
    const { doc } = await this.db.readDrive(b, l);
    return new RDocSnap<T>(this, doc);
  }
  private async write(method: Method, args: unknown[]): Promise<P.WriteResult> {
    const b = await this.db.mode(docLoc(this.path)!.boardId);
    if (!b) return (this.baseRef() as any)[method](...args);
    await this.db.writeNow([[this, method, args]]);
    return WRITE_RESULT(this.db.Ts);
  }
  create(data: P.WithFieldValue<T>): Promise<P.WriteResult> {
    return this.write('create', [data]);
  }
  set(data: any, options?: P.SetOptions): Promise<P.WriteResult> {
    return this.write('set', options ? [data, options] : [data]);
  }
  update(...args: unknown[]): Promise<P.WriteResult> {
    return this.write('update', args);
  }
  delete(precondition?: P.Precondition): Promise<P.WriteResult> {
    return this.write('delete', precondition ? [precondition] : []);
  }
  isEqual(other: P.DocumentReference<T>): boolean {
    return other?.path === this.path;
  }
  withConverter<U>(converter: P.FirestoreDataConverter<U> | null): any {
    return new RDocRef<U>(this.db, this.path, converter as Conv);
  }
}

type QOp = [method: string, args: unknown[]];

export class RQuery<T = P.DocumentData> implements P.Query<T> {
  constructor(
    readonly db: RoutedDb,
    readonly target: { path?: string; group?: 'tickets' },
    readonly ops: QOp[],
    readonly conv: Conv,
  ) {}
  protected with(op: QOp): RQuery<T> {
    return new RQuery<T>(this.db, this.target, [...this.ops, op], this.conv);
  }
  where(f: string | P.FieldPath, op: P.WhereFilterOp, v: unknown) {
    return this.with(['where', [f, op, v]]);
  }
  orderBy(f: string | P.FieldPath, dir?: P.OrderByDirection) {
    return this.with(['orderBy', dir ? [f, dir] : [f]]);
  }
  limit(n: number) {
    return this.with(['limit', [n]]);
  }
  limitToLast(n: number) {
    return this.with(['limitToLast', [n]]);
  }
  offset(n: number) {
    return this.with(['offset', [n]]);
  }
  startAt(...a: unknown[]) {
    return this.with(['startAt', a]);
  }
  startAfter(...a: unknown[]) {
    return this.with(['startAfter', a]);
  }
  endBefore(...a: unknown[]) {
    return this.with(['endBefore', a]);
  }
  endAt(...a: unknown[]) {
    return this.with(['endAt', a]);
  }
  select(...fields: (string | P.FieldPath)[]): P.Query<P.DocumentData> {
    return this.with(['select', fields]) as unknown as P.Query<P.DocumentData>;
  }
  withConverter<U>(converter: P.FirestoreDataConverter<U> | null): any {
    return new RQuery<U>(this.db, this.target, this.ops, converter as Conv);
  }

  /**
   * The same query on the database adapter. `merging` (a collection group
   * merged with Drive boards): the in-memory pass applies the offset, so the
   * adapter returns offset + limit rows from the start, and a cursor that is
   * a routed snapshot becomes the values of its explicit orderBy fields.
   */
  baseQuery(merging = false): P.Query<any> {
    let q: any = this.target.group
      ? this.db.base.collectionGroup(this.target.group)
      : this.db.base.collection(this.target.path!);
    const offset = Number(this.ops.find(([m]) => m === 'offset')?.[1][0] ?? 0);
    const orderFields = this.ops.filter(([m]) => m === 'orderBy').map(([, a]) => segsOf(a[0]));
    for (const [m, args] of this.ops) {
      let a = args;
      if (merging && m === 'offset') continue;
      if (merging && m === 'limit') a = [Number(args[0]) + offset];
      if (/^(start|end)/.test(m) && args.length === 1 && args[0] instanceof RDocSnap) {
        if (!orderFields.length) continue;
        const data = (args[0] as RDocSnap).rawData();
        a = orderFields.map((segs) => getAt(data, segs));
      }
      q = q[m](...a);
    }
    return this.conv ? q.withConverter(this.conv) : q;
  }

  /** The adapter's state for the in-memory planner. */
  private state(collectionId: string, parent: string | null): QueryState {
    const st: QueryState = { collectionId, parent, filters: [], orders: [] };
    const cursor = (args: unknown[], inclusive: boolean) => {
      const [first] = args;
      if (args.length === 1 && first && typeof first === 'object' && 'ref' in (first as object)) {
        const s = first as any;
        const raw = s instanceof RDocSnap ? s.raw : (encodeJson(s.data()) as Json);
        return { snapshot: { path: s.ref.path, doc: raw }, inclusive };
      }
      return { values: args.map(toLocal), inclusive };
    };
    for (const [m, a] of this.ops) {
      if (m === 'where')
        st.filters.push({ segs: segsOf(a[0]), op: a[1] as any, value: toLocal(a[2]) });
      else if (m === 'orderBy')
        st.orders.push({ segs: segsOf(a[0]), dir: (a[1] as 'asc' | 'desc') ?? 'asc' });
      else if (m === 'limit') {
        st.limit = a[0] as number;
        delete st.limitToLast;
      } else if (m === 'limitToLast') {
        st.limitToLast = a[0] as number;
        delete st.limit;
      } else if (m === 'offset') st.offset = a[0] as number;
      else if (m === 'startAt') st.start = cursor(a, true);
      else if (m === 'startAfter') st.start = cursor(a, false);
      else if (m === 'endAt') st.end = cursor(a, true);
      else if (m === 'endBefore') st.end = cursor(a, false);
      else if (m === 'select') st.select = a.map(segsOf);
    }
    return st;
  }

  private plan(rows: { id: string; path: string; data: Json }[], collectionId: string, parent: string | null) {
    const st = this.state(collectionId, parent);
    const plan = new Plan(st, isRefValue, true);
    const loaded = rows.map((r) => ({
      parent: parentOf(r.path),
      id: r.id,
      doc: '',
      v: 0,
      ct: 0,
      ut: 0,
      data: r.data,
      path: r.path,
    }));
    let out = plan.finish(loaded, false);
    if (st.select) {
      const mask = st.select.filter((s) => !(s.length === 1 && s[0] === DOC_ID));
      out = out.map((r) => {
        const data: Json = {};
        for (const segs of mask) {
          const v = getAt(r.data, segs);
          if (v === undefined) continue;
          let dst = data;
          for (const s of segs.slice(0, -1)) dst = (dst[s] ??= {}) as Json;
          dst[segs[segs.length - 1]!] = v;
        }
        return { ...r, data };
      });
    }
    return out;
  }

  private snapOf(path: string, raw: Json): P.QueryDocumentSnapshot<T> {
    return new RDocSnap<T>(new RDocRef<T>(this.db, path, this.conv), raw);
  }

  async run(btx: P.Transaction | null): Promise<P.QuerySnapshot<T>> {
    if (this.target.path) {
      const l = colLoc(this.target.path)!;
      const b = await this.db.mode(l.boardId);
      if (!b) {
        const q = this.baseQuery();
        return (btx ? btx.get(q) : q.get()) as Promise<P.QuerySnapshot<T>>;
      }
      const rows = await this.db.driveRows(b, this.target.path);
      const out = this.plan(rows, lastSeg(this.target.path), parentOf(this.target.path));
      return new RQuerySnap(out.map((r) => this.snapOf(r.path, r.data)), this.db.Ts);
    }
    // collectionGroup('tickets'): the database's answer + every Drive board's, as one.
    const ids = await driveBoardIds(this.db.base);
    if (!ids.length) {
      const q = this.baseQuery();
      return (btx ? btx.get(q) : q.get()) as Promise<P.QuerySnapshot<T>>;
    }
    const plain = (this.baseQuery(true) as any).withConverter(null);
    const baseRows = (await (btx ? btx.get(plain) : plain.get())).docs.map(
      (d: P.QueryDocumentSnapshot<any>) => ({
        id: d.id,
        path: d.ref.path,
        data: encodeJson(d.data()) as Json,
      }),
    );
    const driveRows = (
      await Promise.all(
        ids.map(async (id) => {
          const b = await this.db.mode(id);
          if (!b) return [];
          try {
            return await this.db.driveRows(b, `boards/${id}/tickets`);
          } catch (e) {
            // One board's Drive being unreachable must not take every list down.
            console.warn(`[drive] board ${id} skipped in a collection-group query`, e);
            return [];
          }
        }),
      )
    ).flat();
    const out = this.plan([...baseRows, ...driveRows], 'tickets', null);
    return new RQuerySnap(out.map((r) => this.snapOf(r.path, r.data)), this.db.Ts);
  }

  get(): Promise<P.QuerySnapshot<T>> {
    return this.run(null);
  }
  count(): P.AggregateQuery {
    return {
      get: async () => {
        const n = (await this.get()).size;
        return { data: () => ({ count: n }) };
      },
    };
  }
}

export class RColRef<T = P.DocumentData> extends RQuery<T> implements P.CollectionReference<T> {
  constructor(db: RoutedDb, readonly path: string, conv: Conv) {
    super(db, { path }, [], conv);
  }
  get id(): string {
    return lastSeg(this.path);
  }
  get parent(): P.DocumentReference<P.DocumentData> | null {
    return this.db.doc(parentOf(this.path));
  }
  doc(id?: string): P.DocumentReference<T> {
    return new RDocRef<T>(this.db, `${this.path}/${id ?? this.db.base.collection('_').doc().id}`, this.conv);
  }
  async add(data: P.WithFieldValue<T>): Promise<P.DocumentReference<T>> {
    const ref = this.doc();
    await ref.set(data as any);
    return ref;
  }
  async listDocuments(): Promise<P.DocumentReference<T>[]> {
    const l = colLoc(this.path)!;
    const b = await this.db.mode(l.boardId);
    if (!b) return this.db.base.collection(this.path).listDocuments() as Promise<P.DocumentReference<T>[]>;
    return (await this.db.driveRows(b, this.path)).map((r) => this.doc(r.id));
  }
  override withConverter<U>(converter: P.FirestoreDataConverter<U> | null): any {
    return new RColRef<U>(this.db, this.path, converter as Conv);
  }
}

// ─── transactions, batches, bulk ─────────────────────────────────────────────

class RTx implements P.Transaction {
  private reads = new Map<string, { v: number | null; files: TicketFiles | null }>();
  private staged: [RDocRef<any>, Method, unknown[]][] = [];
  constructor(
    private readonly db: RoutedDb,
    private readonly btx: P.Transaction,
  ) {}

  async get(target: any): Promise<any> {
    if (target instanceof RDocRef) {
      const l = docLoc(target.path)!;
      const b = await this.db.mode(l.boardId);
      if (!b) return this.btx.get(target.baseRef());
      const r = await this.db.readDrive(b, l);
      const key = keyOf(l);
      if (!this.reads.has(key) || l.sub === null)
        this.reads.set(key, { v: r.v, files: l.sub === null ? r.files : this.reads.get(key)?.files ?? null });
      return new RDocSnap(target, r.doc);
    }
    if (target instanceof RQuery) return target.run(this.btx);
    return this.btx.get(target);
  }
  async getAll(...args: any[]): Promise<any[]> {
    const refs = args.filter((a) => typeof a?.path === 'string');
    const opts = args.filter((a) => typeof a?.path !== 'string');
    const baseRefs = refs.filter((r) => !(r instanceof RDocRef));
    const managed: any[] = [];
    for (const r of refs)
      if (r instanceof RDocRef && !(await this.db.mode(docLoc(r.path)!.boardId))) managed.push(r);
    const plain = [...baseRefs, ...managed.map((r) => r.baseRef())];
    const snaps = plain.length ? await this.btx.getAll(...plain, ...opts) : [];
    const byPath = new Map(snaps.map((s: any) => [s.ref.path, s]));
    return Promise.all(
      refs.map((r) => (byPath.has(r.path) ? byPath.get(r.path) : this.get(r))),
    );
  }
  private stage(ref: any, method: Method, args: unknown[]): this {
    if (ref instanceof RDocRef) this.staged.push([ref, method, args]);
    else (this.btx as any)[method](ref, ...args);
    return this;
  }
  create(ref: any, data: any): this {
    return this.stage(ref, 'create', [data]);
  }
  set(ref: any, data: any, options?: P.SetOptions): this {
    return this.stage(ref, 'set', options ? [data, options] : [data]);
  }
  update(ref: any, ...args: unknown[]): this {
    return this.stage(ref, 'update', args);
  }
  delete(ref: any, precondition?: P.Precondition): this {
    return this.stage(ref, 'delete', precondition ? [precondition] : []);
  }

  /** Before the database commits: managed refs join it, Drive ones are leased and computed. */
  async flush(holder: string, leased: Map<string, Work>): Promise<Prepared[]> {
    const works = new Map<string, Work>();
    for (const [ref, method, args] of this.staged) {
      const l = docLoc(ref.path)!;
      const b = await this.db.mode(l.boardId);
      if (!b) {
        (this.btx as any)[method](ref.baseRef(), ...args);
        continue;
      }
      this.db.workOf(b, ref, toOp(ref, method, args), works);
      const w = works.get(keyOf(l))!;
      const read = this.reads.get(keyOf(l));
      if (read) w.read = read;
    }
    if (!works.size) return [];
    return this.db.prepare([...works.values()], holder, leased);
  }
}

class RBatch implements P.WriteBatch {
  private staged: [RDocRef<any>, Method, unknown[]][] = [];
  constructor(
    private readonly db: RoutedDb,
    private readonly bb: P.WriteBatch,
  ) {}
  private stage(ref: any, method: Method, args: unknown[]): this {
    if (ref instanceof RDocRef) this.staged.push([ref, method, args]);
    else (this.bb as any)[method](ref, ...args);
    return this;
  }
  create(ref: any, data: any): this {
    return this.stage(ref, 'create', [data]);
  }
  set(ref: any, data: any, options?: P.SetOptions): this {
    return this.stage(ref, 'set', options ? [data, options] : [data]);
  }
  update(ref: any, ...args: unknown[]): this {
    return this.stage(ref, 'update', args);
  }
  delete(ref: any, precondition?: P.Precondition): this {
    return this.stage(ref, 'delete', precondition ? [precondition] : []);
  }
  async commit(): Promise<P.WriteResult[]> {
    const drive: [RDocRef<any>, Method, unknown[]][] = [];
    for (const s of this.staged) {
      const b = await this.db.mode(docLoc(s[0].path)!.boardId);
      if (b) drive.push(s);
      else (this.bb as any)[s[1]](s[0].baseRef(), ...s[2]);
    }
    const out = await this.bb.commit();
    if (drive.length) await this.db.writeNow(drive);
    return out;
  }
}

class RBulk implements P.BulkWriter {
  private pending: Promise<unknown>[] = [];
  constructor(
    private readonly db: RoutedDb,
    private readonly bw: P.BulkWriter,
  ) {}
  private run(ref: any, method: Method, args: unknown[]): Promise<P.WriteResult> {
    if (!(ref instanceof RDocRef)) return (this.bw as any)[method](ref, ...args);
    const p = this.db.writeNow([[ref, method, args]]).then(() => WRITE_RESULT(this.db.Ts));
    this.pending.push(p.catch(() => undefined));
    return p;
  }
  create(ref: any, data: any) {
    return this.run(ref, 'create', [data]);
  }
  set(ref: any, data: any, options?: P.SetOptions) {
    return this.run(ref, 'set', options ? [data, options] : [data]);
  }
  update(ref: any, ...args: unknown[]) {
    return this.run(ref, 'update', args);
  }
  delete(ref: any, precondition?: P.Precondition) {
    return this.run(ref, 'delete', precondition ? [precondition] : []);
  }
  onWriteError(cb: (e: P.BulkWriterError) => boolean): void {
    this.bw.onWriteError(cb);
  }
  async flush(): Promise<void> {
    await Promise.all([this.bw.flush(), ...this.pending]);
  }
  async close(): Promise<void> {
    await Promise.all(this.pending);
    await this.bw.close();
  }
}
