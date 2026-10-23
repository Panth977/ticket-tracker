/* eslint-disable @typescript-eslint/no-explicit-any -- the SDK's write signatures, passed through */
/**
 * 'firebase/firestore', with what is KEPT IN GOOGLE DRIVE answered by the api
 * (docs/plan/bucket.html §L, §L5). vite.config.ts aliases every import of
 * 'firebase/firestore' here; this module re-exports the real SDK (or the VM
 * shim) and wraps the reads — and an artifact's data writes.
 *
 * A board, dictionary or artifact whose `storage.kind` is 'drive' keeps its
 * tickets / views / templates / webhooks / integrations / entries / data in
 * Drive, and a board its settings (merged into the board document). Firestore
 * has none of that to give, so for those paths this asks the `driveDocs`
 * command instead and answers with snapshots of the SDK's shape:
 *
 *   live          refetched when a driveRev of the entity moves (the server's
 *                 ping after every write), and once a minute regardless (an
 *                 edit made by hand in Drive)
 *   from cache    nothing is cached: an empty answer (a cache miss)
 *   writes        an artifact's data (setDoc / updateDoc / deleteDoc / addDoc)
 *                 go through `driveDocWrite`; everything else is written by
 *                 commands already
 *
 * Every other read and write is the SDK's own call, untouched.
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
  startAfter?: unknown[];
  /** A constraint this layer cannot replay: answered as a full list. */
  loose?: boolean;
}
type Part =
  | { k: 'where'; f: Filter }
  | { k: 'orderBy'; f: string; d: 'asc' | 'desc' }
  | { k: 'limit'; n: number }
  | { k: 'startAfter'; values: unknown[] }
  | { k: 'startAfterSnap'; snap: { id: string; data(): unknown } }
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
export function startAfter(...args: unknown[]) {
  const c = (R.startAfter as (...a: unknown[]) => QueryConstraint)(...args);
  const [first] = args;
  const isSnap =
    args.length === 1 &&
    !!first &&
    typeof first === 'object' &&
    typeof (first as { data?: unknown }).data === 'function';
  parts.set(
    c,
    isSnap
      ? { k: 'startAfterSnap', snap: first as { id: string; data(): unknown } }
      : { k: 'startAfter', values: args },
  );
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

function getAt(o: unknown, field: string): unknown {
  let cur = o;
  for (const s of field.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
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
      else if (p.k === 'startAfter') s.startAfter = p.values;
      else if (p.k === 'startAfterSnap')
        s.startAfter = s.orderBy.length
          ? s.orderBy.map(([f]) => (f === '__name__' ? p.snap.id : getAt(p.snap.data(), f)))
          : [p.snap.id];
      else s.loose = true;
    }
    specs.set(q, s);
  }
  return q;
}

// ─── which paths are kept in Drive ──────────────────────────────────────────

type EntityKind = 'boards' | 'dictionaries' | 'artifacts';
interface Ent {
  kind: EntityKind;
  id: string;
}
/** Subtrees kept as files (backend db/drive/entities.ts), and how deep they go. */
const SUBTREES: Record<EntityKind, Record<string, number>> = {
  boards: { tickets: 99, views: 2, templates: 2, webhooks: 2, integrations: 2 },
  dictionaries: { content: 2 },
  artifacts: { db: 99 },
};

/** The Drive-able entity a path belongs to, when it is one of its kept paths. */
function entityOf(
  path: string,
  isDoc: boolean,
): (Ent & { merge?: boolean; ticket?: string }) | null {
  const s = path.split('/');
  const kind = s[0] as EntityKind;
  if (!(kind in SUBTREES) || !s[1]) return null;
  if (isDoc && s.length === 2) return kind === 'boards' ? { kind, id: s[1], merge: true } : null;
  if (s.length < 3 || s.length % 2 !== (isDoc ? 0 : 1)) return null;
  const depth = SUBTREES[kind][s[2]!];
  if (!depth || s.length - 2 > depth) return null;
  return {
    kind,
    id: s[1],
    ...(kind === 'boards' && s[2] === 'tickets' && isDoc && s.length === 4 ? { ticket: s[3] } : {}),
  };
}

const kinds = new Map<string, { at: number; drive: Promise<boolean> }>();
/** Is this entity kept in Drive? (its document says; cached briefly) */
export function isDriveEntity(db: Firestore, e: Ent): Promise<boolean> {
  const key = `${e.kind}/${e.id}`;
  const hit = kinds.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.drive;
  const drive = R.getDoc(R.doc(db, key))
    .then(
      (s) => (s.data() as { storage?: { kind?: string } } | undefined)?.storage?.kind === 'drive',
    )
    .catch(() => false);
  kinds.set(key, { at: Date.now(), drive });
  return drive;
}
/** Is this board's ticket store Drive? */
export const isDriveBoard = (db: Firestore, boardId: string) =>
  isDriveEntity(db, { kind: 'boards', id: boardId });
/** After a storage move: ask again. A board id, or 'kind/id'. */
export function forgetBoardKind(key: string): void {
  kinds.delete(key.includes('/') ? key : `boards/${key}`);
}

type Target =
  | { kind: 'doc'; path: string; ent: Ent & { merge?: boolean; ticket?: string } }
  | { kind: 'query'; path: string; ent: Ent; spec: Spec }
  | { kind: 'group'; spec: Spec };

function targetOf(t: unknown): Target | null {
  const r = t as { type?: string; path?: string };
  if (r?.type === 'document' && typeof r.path === 'string') {
    const ent = entityOf(r.path, true);
    return ent ? { kind: 'doc', path: r.path, ent } : null;
  }
  const s = specOf(t);
  if (!s) return null;
  if (s.group === 'tickets') return { kind: 'group', spec: s };
  if (s.path) {
    const ent = entityOf(s.path, false);
    return ent ? { kind: 'query', path: s.path, ent, spec: s } : null;
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

/** The api's encoding → the SDK's values (a Timestamp travels as { __ts: ms }). */
function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === '__ts' && typeof o.__ts === 'number')
      return R.Timestamp.fromMillis(o.__ts);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = decode(o[k]);
    return out;
  }
  return v;
}

/** The SDK's values → the api's encoding (and the server's time as { __sv: 'now' }). */
function encode(v: unknown): unknown {
  if (v instanceof R.Timestamp) return { __ts: v.toMillis() };
  if (v instanceof Date) return { __ts: v.getTime() };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') {
    const name = (v as { _methodName?: string })._methodName;
    if (name === 'serverTimestamp') return { __sv: 'now' };
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = encode(x);
    return out;
  }
  return v;
}

/** A failure worth retrying: the network, or the server busy — not a refusal. */
function isTransient(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return !code || ['unavailable', 'internal', 'rate_limited', 'conflict'].includes(code);
}

async function ask(t: Target): Promise<Answer> {
  const { command } = await import('$lib/api');
  const shape =
    t.kind === 'doc' || t.spec.loose
      ? {}
      : {
          ...(t.spec.where.length ? { where: t.spec.where } : {}),
          ...(t.spec.orderBy.length ? { orderBy: t.spec.orderBy } : {}),
          ...(t.spec.limit ? { limit: t.spec.limit } : {}),
          ...(t.spec.startAfter ? { startAfter: t.spec.startAfter } : {}),
        };
  const target = t.kind === 'group' ? { kind: 'group' as const } : { kind: t.kind, path: t.path };
  const a = (await command(
    'driveDocs',
    { target, ...shape } as never,
    // A read: no 'Saving…' pill, however slow Drive is.
    { toast: false, background: true } as never,
  )) as unknown as Answer;
  return {
    ...a,
    docs: a.docs.map((d) => ({ ...d, data: decode(d.data) as Record<string, unknown> })),
  };
}

const META = { fromCache: false, hasPendingWrites: false, isEqual: () => false } as const;

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
    return this.row ? (decode(this.row.data) as DocumentData) : undefined;
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
      changes.push({
        type: 'removed',
        doc: new FakeDoc(R.doc(db, p) as DocumentReference, null),
      });
  return {
    snap: new FakeQuerySnap(q, docs, changes) as unknown as QuerySnapshot,
    seen: now,
    changed: changes.length > 0 || prev?.size !== now.size,
  };
}

// ─── the boards collection: a Drive board's settings merged in ──────────────

/** Fields a Drive board keeps in its settings.json (backend entities.ts). */
const BOARD_SETTINGS = [
  'stages',
  'priorities',
  'tags',
  'fields',
  'aggFields',
  'defaultViewId',
  'settings',
];
const boardSettings = new Map<
  string,
  { at: number; data: Promise<Record<string, unknown> | null> }
>();

/** A Drive board's settings, from the api (cached until its _entity rev moves). */
function settingsOf(boardId: string, fresh = false): Promise<Record<string, unknown> | null> {
  const hit = boardSettings.get(boardId);
  if (hit && !fresh && Date.now() - hit.at < DRIVE_POLL_MS) return hit.data;
  const data = ask({
    kind: 'doc',
    path: `boards/${boardId}`,
    ent: { kind: 'boards', id: boardId, merge: true },
  })
    .then((a) => {
      const d = a.docs[0]?.data;
      if (!d) return null;
      const out: Record<string, unknown> = {};
      for (const f of BOARD_SETTINGS) if (d[f] !== undefined) out[f] = d[f];
      goodSettings.set(boardId, out);
      return out;
    })
    // A failed read keeps the last settings it had (and asks again soon).
    .catch(() => {
      boardSettings.set(boardId, {
        at: 0,
        data: Promise.resolve(goodSettings.get(boardId) ?? null),
      });
      return goodSettings.get(boardId) ?? null;
    });
  boardSettings.set(boardId, { at: Date.now(), data });
  return data;
}
const goodSettings = new Map<string, Record<string, unknown>>();

const isBoardsCollection = (q: unknown) => specOf(q)?.path === 'boards';
const isDriveRow = (r: Row) => (r.data.storage as { kind?: string } | undefined)?.kind === 'drive';

async function mergeBoards(rows: Row[]): Promise<Row[]> {
  return Promise.all(
    rows.map(async (r) => {
      if (!isDriveRow(r)) return r;
      const s = await settingsOf(r.id);
      return s ? { ...r, data: { ...r.data, ...s } } : r;
    }),
  );
}

// ─── one-off reads ──────────────────────────────────────────────────────────

const firestoreOf = (t: unknown) => (t as { firestore: Firestore }).firestore;

export async function getDoc<T>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  const t = targetOf(ref);
  if (!t || t.kind !== 'doc' || !(await isDriveEntity(firestoreOf(ref), t.ent)))
    return R.getDoc(ref);
  const a = await ask(t);
  return new FakeDoc(ref as DocumentReference, a.docs[0] ?? null) as unknown as DocumentSnapshot<T>;
}
export const getDocFromServer = getDoc;

export async function getDocFromCache<T>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  const t = targetOf(ref);
  if (t && t.kind === 'doc' && (await isDriveEntity(firestoreOf(ref), t.ent)))
    throw new Error('Failed to get document from cache (Drive is never cached here)');
  return R.getDocFromCache(ref);
}

/** The Drive share of a target (null: it is kept in the database). */
async function driveRows(
  db: Firestore,
  t: Target,
): Promise<{ rows: Row[]; boards: string[] } | null> {
  if (t.kind !== 'group' && !(await isDriveEntity(db, t.ent))) return null;
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
  if (isBoardsCollection(q)) {
    const snap = (await R.getDocs(q)) as unknown as QuerySnapshot;
    const rows = rowsOf(snap);
    if (!rows.some(isDriveRow)) return snap as QuerySnapshot<T>;
    return querySnap(firestoreOf(q), q, await mergeBoards(rows), null).snap as QuerySnapshot<T>;
  }
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
  if (t && t.kind !== 'group' && (await isDriveEntity(firestoreOf(q), t.ent)))
    return querySnap(firestoreOf(q), q, [], null).snap as QuerySnapshot<T>;
  return R.getDocsFromCache(q);
}

// ─── writes: a Drive artifact's data ────────────────────────────────────────

async function driveWrite(
  ref: { path: string; firestore: Firestore },
  method: 'set' | 'update' | 'delete' | 'add',
  data?: unknown,
  merge?: boolean,
): Promise<string | null> {
  const ent = entityOf(method === 'add' ? `${ref.path}/_` : ref.path, true);
  if (!ent || ent.kind !== 'artifacts' || !(await isDriveEntity(ref.firestore, ent))) return null;
  const { command } = await import('$lib/api');
  const r = (await command(
    'driveDocWrite',
    {
      path: ref.path,
      method,
      ...(data !== undefined ? { data: encode(data) } : {}),
      ...(merge ? { merge: true } : {}),
    } as never,
    { toast: false } as never,
  )) as unknown as { id: string };
  return r.id;
}

export async function setDoc(
  ref: DocumentReference<any>,
  data: any,
  options?: { merge?: boolean },
) {
  const done = await driveWrite(ref as never, 'set', data, !!options?.merge);
  if (done === null) return options ? R.setDoc(ref, data, options as never) : R.setDoc(ref, data);
}
export async function updateDoc(ref: DocumentReference<any>, ...args: any[]) {
  const done = args.length === 1 ? await driveWrite(ref as never, 'update', args[0]) : null;
  if (done === null) return (R.updateDoc as (...a: unknown[]) => Promise<void>)(ref, ...args);
}
export async function deleteDoc(ref: DocumentReference<any>) {
  const done = await driveWrite(ref as never, 'delete');
  if (done === null) return R.deleteDoc(ref);
}
export async function addDoc(col: R.CollectionReference<any>, data: any) {
  const id = await driveWrite(col as never, 'add', data);
  if (id === null) return R.addDoc(col, data);
  return R.doc(col, id);
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
  const real = R.onSnapshot as unknown as (t: unknown, ...a: unknown[]) => () => void;
  if (isBoardsCollection(target)) return boardsListener(target, real, args);
  const t = targetOf(target);
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
    const drive = t.kind === 'group' ? true : await isDriveEntity(db, t.ent);
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

    // Only what changed is told: a poll that finds the same rows says nothing
    // (a new snapshot re-renders — an open preview would reload every minute).
    let lastDoc: string | undefined;
    const emit = () => {
      if (stopped || !realReady || !driveReady) return;
      if (t.kind === 'doc') {
        const row = driveRowsNow[0] ?? null;
        const now = JSON.stringify(row?.data ?? null);
        if (now === lastDoc) return;
        lastDoc = now;
        next(new FakeDoc(R.doc(db, t.path) as DocumentReference, row));
        return;
      }
      const rows = t.kind === 'group' ? mergeGroup(t.spec, realRows, driveRowsNow) : driveRowsNow;
      const first = seen === null;
      const out = querySnap(db, target, rows, seen);
      seen = out.seen;
      if (!first && !out.changed) return;
      next(out.snap);
    };

    // The entity's revs: any that moves → look again.
    const watch = (ent: Ent, one?: string) => {
      const key = `${ent.kind}/${ent.id}/${one ?? '*'}`;
      if (watched.has(key)) return;
      watched.add(key);
      const revs = one
        ? R.doc(db, `${ent.kind}/${ent.id}/driveRev/${one}`)
        : R.query(
            R.collection(db, `${ent.kind}/${ent.id}/driveRev`),
            R.where('at', '>', Date.now() - 5_000),
          );
      // Every rev snapshot refetches — the first too: it may already carry a
      // write made after the first fetch went out (a lost ping otherwise).
      offs.push(
        real(
          revs,
          () => refetch(),
          () => {},
        ),
      );
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight = false;
    let again = false;
    let fails = 0;
    const fetchNow = async () => {
      if (inflight) {
        again = true;
        return;
      }
      inflight = true;
      try {
        const a = await ask(t);
        fails = 0;
        driveRowsNow = a.docs;
        driveReady = true;
        for (const b of a.boards) watch({ kind: 'boards', id: b });
        emit();
      } catch (e) {
        // A read that fails after one worked (a phone between networks, a slow
        // Drive) keeps what is shown and tries again; only a first load that
        // keeps failing is an error — never "not found" over good data.
        fails++;
        if (stopped) return;
        if (driveReady || (fails < 3 && isTransient(e))) {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => void fetchNow(), Math.min(30_000, 1_000 * 2 ** fails));
        } else error(e instanceof Error ? e : new Error(String(e)));
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
    else if (t.kind === 'doc' && t.ent.merge) {
      // A Drive board's document: the database's fields live, settings from Drive.
      watch(t.ent, '_entity');
      offs.push(
        real(
          R.doc(db, t.path),
          () => refetch(),
          () => {},
        ),
      );
    } else if (t.kind === 'doc' && t.ent.ticket) watch(t.ent, t.ent.ticket);
    else watch(t.ent);
    await fetchNow();
  })();

  return stop;
}

/**
 * A live query on `boards` (the sidebar, pickers): the SDK's own, with each
 * Drive board's settings merged in — and merged again when its _entity rev moves.
 */
function boardsListener(
  target: unknown,
  real: (t: unknown, ...a: unknown[]) => () => void,
  args: unknown[],
): () => void {
  const db = firestoreOf(target);
  const { next, error } = observerOf(args);
  let rows: Row[] = [];
  let seen: Map<string, string> | null = null;
  let stopped = false;
  let snapAny: QuerySnapshot | null = null;
  const watches = new Map<string, () => void>();
  let gen = 0;

  const emit = async () => {
    const mine = ++gen;
    if (!rows.some(isDriveRow)) {
      if (snapAny && !stopped) next(snapAny);
      return;
    }
    const merged = await mergeBoards(rows);
    if (stopped || mine !== gen) return;
    const first = seen === null;
    const out = querySnap(db, target, merged, seen);
    seen = out.seen;
    if (!first && !out.changed) return;
    next(out.snap);
  };
  const off = real(
    target,
    (snap: QuerySnapshot) => {
      snapAny = snap;
      rows = rowsOf(snap);
      for (const r of rows.filter(isDriveRow))
        if (!watches.has(r.id))
          watches.set(
            r.id,
            real(
              R.doc(db, `boards/${r.id}/driveRev/_entity`),
              () => void settingsOf(r.id, true).then(() => emit()),
              () => {},
            ),
          );
      void emit();
    },
    (e: Error) => error(e),
  );
  return () => {
    stopped = true;
    off();
    for (const w of watches.values()) w();
  };
}
