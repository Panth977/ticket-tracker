/**
 * 'firebase/firestore', with the tickets of DRIVE BOARDS answered by the api
 * (docs/plan/bucket.html §L). vite.config.ts aliases every import of
 * 'firebase/firestore' here; this module re-exports the real SDK (or the VM
 * shim) and wraps only the reads.
 *
 * A board whose `storage.kind` is 'drive' keeps its tickets in Google Drive,
 * so Firestore has none to give. For any read under boards/{b}/tickets/ of
 * such a board — a live listener, a one-off get, or the Drive boards' share
 * of collectionGroup('tickets') — this asks the `ticketDocs` command instead,
 * and answers with snapshots of the same shape the SDK's would have:
 *
 *   live          refetched when the ticket's boards/{b}/driveRev/{t} moves
 *                 (the server's ping after every write, any board query on
 *                 any rev of the board), and once a minute regardless (an
 *                 edit made by hand in Drive)
 *   from cache    nothing is cached: an empty answer (a cache miss)
 *
 * Every other read is the SDK's own call, untouched.
 */
import * as R from 'tm-real-firestore';
import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Query,
  QueryConstraint,
  QuerySnapshot,
  WhereFilterOp,
} from 'tm-real-firestore';

export * from 'tm-real-firestore';

// ─── what a query asks for (the SDK's objects are opaque) ───────────────────

type Filter = [field: string, op: WhereFilterOp, value: unknown];
interface Spec {
  path?: string;
  group?: string;
  where: Filter[];
  orderBy: [string, 'asc' | 'desc'][];
  limit?: number;
  /** A constraint this layer cannot replay (cursors…): answered as a full list. */
  loose?: boolean;
}
type Part =
  | { k: 'where'; f: Filter }
  | { k: 'orderBy'; f: string; d: 'asc' | 'desc' }
  | { k: 'limit'; n: number }
  | { k: 'loose' };

const specs = new WeakMap<object, Spec>();
const parts = new WeakMap<object, Part>();
const docIdPaths = new WeakSet<object>();

const fieldName = (f: unknown): string | null =>
  typeof f === 'string' ? f : f && typeof f === 'object' && docIdPaths.has(f) ? '__name__' : null;

export function documentId(): ReturnType<typeof R.documentId> {
  const p = R.documentId();
  docIdPaths.add(p);
  return p;
}
export function where(field: string | R.FieldPath, op: WhereFilterOp, value: unknown) {
  const c = R.where(field, op, value);
  const f = fieldName(field);
  parts.set(c, f ? { k: 'where', f: [f, op, value] } : { k: 'loose' });
  return c;
}
export function orderBy(field: string | R.FieldPath, dir: 'asc' | 'desc' = 'asc') {
  const c = R.orderBy(field, dir);
  const f = fieldName(field);
  parts.set(c, f ? { k: 'orderBy', f, d: dir } : { k: 'loose' });
  return c;
}
export function limit(n: number) {
  const c = R.limit(n);
  parts.set(c, { k: 'limit', n });
  return c;
}
export function collectionGroup(db: Firestore, id: string): Query<DocumentData> {
  const q = R.collectionGroup(db, id);
  specs.set(q, { group: id, where: [], orderBy: [] });
  return q;
}
function specOf(target: unknown): Spec | null {
  const s = specs.get(target as object);
  if (s) return s;
  const t = target as { type?: string; path?: string };
  if (t?.type === 'collection' && typeof t.path === 'string')
    return { path: t.path, where: [], orderBy: [] };
  return null;
}
export function query<T>(base: Query<T>, ...cs: (QueryConstraint | unknown)[]): Query<T> {
  const q = (R.query as (b: Query<T>, ...c: unknown[]) => Query<T>)(base, ...cs);
  const from = specOf(base);
  if (from) {
    const s: Spec = { ...from, where: [...from.where], orderBy: [...from.orderBy] };
    for (const c of cs) {
      const p = parts.get(c as object);
      if (!p) s.loose = true;
      else if (p.k === 'where') s.where.push(p.f);
      else if (p.k === 'orderBy') s.orderBy.push([p.f, p.d]);
      else if (p.k === 'limit') s.limit = p.n;
      else s.loose = true;
    }
    specs.set(q, s);
  }
  return q;
}

// ─── which reads are a Drive board's ────────────────────────────────────────

const ticketBoard = (path: string): string | null => {
  const s = path.split('/');
  return s[0] === 'boards' && s[2] === 'tickets' && s[1] ? s[1] : null;
};

const kinds = new Map<string, { at: number; drive: Promise<boolean> }>();
/** Is this board's ticket store Drive? (its board document says; cached briefly) */
export function isDriveBoard(db: Firestore, boardId: string): Promise<boolean> {
  const hit = kinds.get(boardId);
  if (hit && Date.now() - hit.at < 30_000) return hit.drive;
  const drive = R.getDoc(R.doc(db, `boards/${boardId}`))
    .then(
      (s) => (s.data() as { storage?: { kind?: string } } | undefined)?.storage?.kind === 'drive',
    )
    .catch(() => false);
  kinds.set(boardId, { at: Date.now(), drive });
  return drive;
}
/** After a storage move: ask again. */
export function forgetBoardKind(boardId: string): void {
  kinds.delete(boardId);
}

type Target =
  | { kind: 'doc'; path: string; board: string }
  | { kind: 'query'; path: string; board: string; spec: Spec }
  | { kind: 'group'; spec: Spec };

function targetOf(t: unknown): Target | null {
  const r = t as { type?: string; path?: string };
  if (r?.type === 'document' && typeof r.path === 'string') {
    const board = ticketBoard(r.path);
    return board ? { kind: 'doc', path: r.path, board } : null;
  }
  const s = specOf(t);
  if (!s) return null;
  if (s.group === 'tickets') return { kind: 'group', spec: s };
  if (s.path) {
    const board = ticketBoard(s.path);
    return board ? { kind: 'query', path: s.path, board, spec: s } : null;
  }
  return null;
}

// ─── answers from the api ───────────────────────────────────────────────────

interface Row {
  path: string;
  id: string;
  data: Record<string, unknown>;
}
interface Answer {
  docs: Row[];
  exists?: boolean;
  boards: string[];
}

async function ask(t: Target): Promise<Answer> {
  const { command } = await import('$lib/api');
  const shape =
    t.kind === 'doc'
      ? {}
      : {
          ...(t.spec.where.length && !t.spec.loose ? { where: t.spec.where } : {}),
          ...(t.spec.orderBy.length && !t.spec.loose ? { orderBy: t.spec.orderBy } : {}),
          ...(t.spec.limit && !t.spec.loose ? { limit: t.spec.limit } : {}),
        };
  const target = t.kind === 'group' ? { kind: 'group' as const } : { kind: t.kind, path: t.path };
  return (await command(
    'ticketDocs',
    { target, ...shape } as never,
    {
      toast: false,
    } as never,
  )) as unknown as Answer;
}

const META = { fromCache: false, hasPendingWrites: false, isEqual: () => false } as const;

function getAt(o: unknown, field: string): unknown {
  let cur = o;
  for (const s of field.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

class FakeDoc {
  readonly metadata = META;
  constructor(
    readonly ref: DocumentReference,
    private readonly row: Row | null,
  ) {}
  get id() {
    return this.ref.id;
  }
  exists() {
    return this.row !== null;
  }
  data() {
    return this.row ? (structuredClone(this.row.data) as DocumentData) : undefined;
  }
  get(field: string) {
    return this.row ? getAt(this.row.data, field) : undefined;
  }
}

class FakeQuerySnap {
  readonly metadata = META;
  constructor(
    readonly query: unknown,
    readonly docs: FakeDoc[],
    private readonly changes: { type: 'added' | 'modified' | 'removed'; doc: FakeDoc }[],
  ) {}
  get size() {
    return this.docs.length;
  }
  get empty() {
    return this.docs.length === 0;
  }
  forEach(cb: (d: FakeDoc) => void) {
    this.docs.forEach(cb);
  }
  docChanges() {
    return this.changes.map((c, i) => ({ ...c, oldIndex: -1, newIndex: i }));
  }
}

function compare(a: Row, b: Row, order: [string, 'asc' | 'desc'][]): number {
  for (const [f, d] of order) {
    const x = f === '__name__' ? a.path : getAt(a.data, f);
    const y = f === '__name__' ? b.path : getAt(b.data, f);
    if (x === y) continue;
    const c =
      x === undefined || x === null ? -1 : y === undefined || y === null ? 1 : x < y ? -1 : 1;
    return d === 'asc' ? c : -c;
  }
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Rows → a query snapshot, with docChanges against what was last answered. */
function querySnap(db: Firestore, q: unknown, rows: Row[], prev: Map<string, string> | null) {
  const docs = rows.map((r) => new FakeDoc(R.doc(db, r.path) as DocumentReference, r));
  const changes: { type: 'added' | 'modified' | 'removed'; doc: FakeDoc }[] = [];
  const now = new Map(rows.map((r) => [r.path, JSON.stringify(r.data)]));
  for (const [i, r] of rows.entries()) {
    const before = prev?.get(r.path);
    if (before === undefined) changes.push({ type: 'added', doc: docs[i]! });
    else if (before !== now.get(r.path)) changes.push({ type: 'modified', doc: docs[i]! });
  }
  for (const p of prev?.keys() ?? [])
    if (!now.has(p))
      changes.push({ type: 'removed', doc: new FakeDoc(R.doc(db, p) as DocumentReference, null) });
  return { snap: new FakeQuerySnap(q, docs, changes) as unknown as QuerySnapshot, seen: now };
}

// ─── one-off reads ──────────────────────────────────────────────────────────

const firestoreOf = (t: unknown) => (t as { firestore: Firestore }).firestore;

export async function getDoc<T>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  const t = targetOf(ref);
  if (!t || !(await isDriveBoard(firestoreOf(ref), (t as { board: string }).board)))
    return R.getDoc(ref);
  const a = await ask(t);
  return new FakeDoc(ref as DocumentReference, a.docs[0] ?? null) as unknown as DocumentSnapshot<T>;
}
export const getDocFromServer = getDoc;

export async function getDocFromCache<T>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  const t = targetOf(ref);
  if (t && (await isDriveBoard(firestoreOf(ref), (t as { board: string }).board)))
    throw new Error('Failed to get document from cache (a Drive board is never cached)');
  return R.getDocFromCache(ref);
}

/** The Drive boards' rows of a target (the group share, or the board's). */
async function driveRows(
  db: Firestore,
  t: Target,
): Promise<{ rows: Row[]; boards: string[] } | null> {
  if (t.kind !== 'group' && !(await isDriveBoard(db, t.board))) return null;
  const a = await ask(t);
  return { rows: a.docs, boards: a.boards };
}

function mergeGroup(spec: Spec, real: Row[], drive: Row[]): Row[] {
  const byPath = new Map([...real, ...drive].map((r) => [r.path, r]));
  let rows = [...byPath.values()];
  if (spec.orderBy.length) rows.sort((a, b) => compare(a, b, spec.orderBy));
  if (spec.limit) rows = rows.slice(0, spec.limit);
  return rows;
}

const rowsOf = (s: QuerySnapshot): Row[] =>
  s.docs.map((d) => ({ path: d.ref.path, id: d.id, data: d.data() as Record<string, unknown> }));

export async function getDocs<T>(q: Query<T>): Promise<QuerySnapshot<T>> {
  const t = targetOf(q);
  if (!t) return R.getDocs(q);
  const db = firestoreOf(q);
  const drive = await driveRows(db, t);
  if (!drive) return R.getDocs(q);
  const rows =
    t.kind === 'group'
      ? mergeGroup(t.spec, rowsOf((await R.getDocs(q)) as unknown as QuerySnapshot), drive.rows)
      : drive.rows;
  return querySnap(db, q, rows, null).snap as QuerySnapshot<T>;
}
export const getDocsFromServer = getDocs;

export async function getDocsFromCache<T>(q: Query<T>): Promise<QuerySnapshot<T>> {
  const t = targetOf(q);
  if (t && t.kind !== 'group' && (await isDriveBoard(firestoreOf(q), t.board)))
    return querySnap(firestoreOf(q), q, [], null).snap as QuerySnapshot<T>;
  return R.getDocsFromCache(q);
}

// ─── live ───────────────────────────────────────────────────────────────────

/** Panth's pick (ORCH-14): besides the ping, look again once a minute. */
export const DRIVE_POLL_MS = 60_000;

type Next = (s: unknown) => void;
type Fail = (e: Error) => void;

function observerOf(args: unknown[]): { next: Next; error: Fail } {
  const fns = args.filter((a) => typeof a === 'function') as ((x: unknown) => void)[];
  const obj = args.find(
    (a) => a && typeof a === 'object' && ('next' in (a as object) || 'error' in (a as object)),
  ) as { next?: Next; error?: Fail } | undefined;
  return {
    next: (obj?.next ?? fns[0] ?? (() => {})) as Next,
    error: (obj?.error ?? fns[1] ?? ((e: Error) => console.error(e))) as Fail,
  };
}

export function onSnapshot(target: unknown, ...args: unknown[]): () => void {
  const t = targetOf(target);
  const real = R.onSnapshot as unknown as (t: unknown, ...a: unknown[]) => () => void;
  if (!t) return real(target, ...args);

  const db = firestoreOf(target);
  const { next, error } = observerOf(args);
  let stopped = false;
  const offs: (() => void)[] = [];
  const stop = () => {
    stopped = true;
    offs.splice(0).forEach((f) => f());
  };

  void (async () => {
    const drive = t.kind === 'group' ? true : await isDriveBoard(db, t.board);
    if (stopped) return;
    if (!drive) {
      offs.push(real(target, ...args));
      return;
    }

    let seen: Map<string, string> | null = null;
    let realRows: Row[] = [];
    let driveRowsNow: Row[] = [];
    let realReady = t.kind !== 'group';
    let driveReady = false;
    const watched = new Set<string>();

    const emit = () => {
      if (stopped || !realReady || !driveReady) return;
      if (t.kind === 'doc') {
        next(new FakeDoc(R.doc(db, t.path) as DocumentReference, driveRowsNow[0] ?? null));
        return;
      }
      const rows = t.kind === 'group' ? mergeGroup(t.spec, realRows, driveRowsNow) : driveRowsNow;
      const out = querySnap(db, target, rows, seen);
      seen = out.seen;
      next(out.snap);
    };

    // Each Drive board's revs: any move → look again.
    const watch = (board: string) => {
      if (watched.has(board)) return;
      watched.add(board);
      const revs =
        t.kind === 'doc'
          ? R.doc(db, `boards/${board}/driveRev/${t.path.split('/')[3]}`)
          : R.query(
              R.collection(db, `boards/${board}/driveRev`),
              R.where('at', '>', Date.now() - 5_000),
            );
      let first = true;
      offs.push(
        real(
          revs,
          () => {
            if (first) {
              first = false;
              return;
            }
            refetch();
          },
          () => {},
        ),
      );
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight = false;
    let again = false;
    const fetchNow = async () => {
      if (inflight) {
        again = true;
        return;
      }
      inflight = true;
      try {
        const a = await ask(t);
        driveRowsNow = a.docs;
        driveReady = true;
        for (const b of a.boards) watch(b);
        emit();
      } catch (e) {
        if (!stopped) error(e instanceof Error ? e : new Error(String(e)));
      } finally {
        inflight = false;
        if (again && !stopped) {
          again = false;
          void fetchNow();
        }
      }
    };
    const refetch = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void fetchNow(), 250);
    };
    offs.push(() => timer && clearTimeout(timer));
    const poll = setInterval(() => void fetchNow(), DRIVE_POLL_MS);
    offs.push(() => clearInterval(poll));

    if (t.kind === 'group')
      offs.push(
        real(
          target,
          (s: QuerySnapshot) => {
            realRows = rowsOf(s);
            realReady = true;
            emit();
          },
          (e: Error) => error(e),
        ),
      );
    else watch(t.board);
    await fetchNow();
  })();

  return stop;
}
