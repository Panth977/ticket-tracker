/**
 * THE LIVE DATA ENGINE — what the browser gets from Firestore on Firebase,
 * served by this server on a VM: one-shot reads, queries, live listeners and
 * client writes, every one of them checked against firestore.rules (the
 * interpreter in src/rules), over any transport (the WebSocket door wraps it).
 *
 *   const s = new DataSession(auth, (msg) => socket.send(JSON.stringify(msg)));
 *   await s.handle(JSON.parse(frame));
 *
 * Messages (client → server; `id` is echoed on the answer):
 *   { id, op: 'get', path }
 *   { id, op: 'query', q }                         q: QuerySpec (below)
 *   { id, op: 'listen', lid, path | q }            then { lid, snap } on every change
 *   { id, op: 'unlisten', lid }
 *   { id, op: 'commit', writes: [WriteSpec …] }    all or nothing
 * Answers: { id, ok: true, result } | { id, ok: false, error: { code, message } }
 * Listener frames: { lid, snap: { exists, path, data } | { docs: [{ path, data }] } }
 *                  { lid, error: { code, message } } (the listener is then gone)
 *
 * QUERIES AND RULES. Firestore refuses a query that COULD return a document
 * the rules deny. Here the query runs, and every document it returns must
 * pass the `list` rule, else the whole query is refused — the same answer
 * whenever the result is not empty. (An empty result is answered as empty.)
 * A listener re-checks on every change and ends with permission-denied the
 * moment it would show something the rules deny.
 */
import { db, type DocumentData, type Query, type WhereFilterOp } from '../db/index.js';
import { sqliteDb, type DocChange } from '../db/sqlite/index.js';
import { firestoreAllows, type RulesAuth } from '../rules/firestore.js';
import { RtdbDenied, RtdbSession } from './rtdb.js';
import { fromWire, resolveForRules, toWire } from './wire.js';

export interface QuerySpec {
  /** A collection path, or (with group) a collection id. */
  path: string;
  group?: boolean;
  where?: [field: string, op: WhereFilterOp, value: unknown][];
  orderBy?: [field: string, dir?: 'asc' | 'desc'][];
  limit?: number;
  limitToLast?: number;
  startAt?: unknown[];
  startAfter?: unknown[];
  endAt?: unknown[];
  endBefore?: unknown[];
}

export interface WriteSpec {
  path: string;
  kind: 'set' | 'update' | 'create' | 'delete';
  data?: Record<string, unknown>;
  merge?: boolean;
  mergeFields?: string[];
}

type Msg =
  | { id: string; op: 'get'; path: string }
  | { id: string; op: 'query'; q: QuerySpec }
  | { id: string; op: 'listen'; lid: string; path?: string; q?: QuerySpec }
  | { id: string; op: 'unlisten'; lid: string }
  | { id: string; op: 'commit'; writes: WriteSpec[] };

export class LiveError extends Error {
  constructor(
    readonly code:
      'permission-denied' | 'invalid-argument' | 'not-found' | 'already-exists' | 'internal',
    message: string,
  ) {
    super(message);
  }
}
const denied = () => new LiveError('permission-denied', 'Missing or insufficient permissions.');

const isDocPath = (p: string) =>
  !!p && !p.split('/').some((s) => !s) && p.split('/').length % 2 === 0;
const isColPath = (p: string) =>
  !!p && !p.split('/').some((s) => !s) && p.split('/').length % 2 === 1;

function buildQuery(q: QuerySpec): Query {
  if (q.group ? q.path.includes('/') : !isColPath(q.path))
    throw new LiveError('invalid-argument', 'Bad query path');
  let query: Query = q.group ? db().collectionGroup(q.path) : db().collection(q.path);
  for (const [f, op, v] of q.where ?? []) query = query.where(f, op, fromWire(v));
  for (const [f, d] of q.orderBy ?? []) query = query.orderBy(f, d ?? 'asc');
  if (q.startAt) query = query.startAt(...(q.startAt.map(fromWire) as unknown[]));
  if (q.startAfter) query = query.startAfter(...(q.startAfter.map(fromWire) as unknown[]));
  if (q.endAt) query = query.endAt(...(q.endAt.map(fromWire) as unknown[]));
  if (q.endBefore) query = query.endBefore(...(q.endBefore.map(fromWire) as unknown[]));
  if (q.limit !== undefined) query = query.limit(q.limit);
  if (q.limitToLast !== undefined) query = query.limitToLast(q.limitToLast);
  return query;
}

interface Listener {
  path?: string;
  q?: QuerySpec;
  /** Collection id the listener depends on (to skip unrelated changes). */
  collectionId: string;
  last: string;
  busy: Promise<void>;
}

export class DataSession {
  private readonly listeners = new Map<string, Listener>();
  private offChanges: (() => void) | undefined;
  /** The Realtime-Database half of the same socket (ops named rtdb.*). */
  private readonly rtdb: RtdbSession;

  constructor(
    readonly auth: RulesAuth | null,
    private readonly send: (msg: unknown) => void,
  ) {
    this.rtdb = new RtdbSession(auth, send);
  }

  // ─── reads ─────────────────────────────────────────────────────────────────

  async getDoc(path: string): Promise<{ exists: boolean; path: string; data: unknown }> {
    if (!isDocPath(path)) throw new LiveError('invalid-argument', 'Bad document path');
    const snap = await db().doc(path).get();
    const data = snap.exists ? (snap.data() as DocumentData) : null;
    if (!(await firestoreAllows(this.auth, 'get', path, data))) throw denied();
    return { exists: snap.exists, path, data: data ? toWire(data) : null };
  }

  async runQuery(q: QuerySpec): Promise<{ docs: { path: string; data: unknown }[] }> {
    const snap = await buildQuery(q).get();
    const docs: { path: string; data: unknown }[] = [];
    for (const d of snap.docs) {
      const data = d.data() as DocumentData;
      if (!(await firestoreAllows(this.auth, 'list', d.ref.path, data))) throw denied();
      docs.push({ path: d.ref.path, data: toWire(data) });
    }
    return { docs };
  }

  // ─── listeners ─────────────────────────────────────────────────────────────

  private async listen(lid: string, path?: string, q?: QuerySpec): Promise<void> {
    if (this.listeners.has(lid)) throw new LiveError('invalid-argument', 'Listener id in use');
    const collectionId = path
      ? path.split('/').slice(-2)[0]!
      : q!.group
        ? q!.path
        : q!.path.split('/').pop()!;
    const l: Listener = { path, q, collectionId, last: '', busy: Promise.resolve() };
    this.listeners.set(lid, l);
    this.ensureFeed();
    await this.refresh(lid, l);
  }

  private async refresh(lid: string, l: Listener): Promise<void> {
    try {
      const snap = l.path ? await this.getDoc(l.path) : await this.runQuery(l.q!);
      const json = JSON.stringify(snap);
      if (json === l.last || !this.listeners.has(lid)) return;
      l.last = json;
      this.send({ lid, snap });
    } catch (e) {
      this.listeners.delete(lid);
      const err = e instanceof LiveError ? e : new LiveError('internal', 'Listener failed');
      this.send({ lid, error: { code: err.code, message: err.message } });
    }
  }

  /** On a store change: refresh the listeners that could be affected (serially per listener). */
  private onChanges = (changes: DocChange[]) => {
    const ids = new Set(changes.map((c) => c.collectionId));
    for (const [lid, l] of this.listeners) {
      // A rules-relevant document (a board, a profile) can change what a listener may see.
      if (
        !ids.has(l.collectionId) &&
        !ids.has('boards') &&
        !ids.has('users') &&
        !ids.has('artifacts') &&
        !ids.has('memories')
      )
        continue;
      l.busy = l.busy.then(() => this.refresh(lid, l));
    }
  };

  private ensureFeed(): void {
    this.offChanges ??= sqliteDb().onChange(this.onChanges);
  }

  // ─── writes ────────────────────────────────────────────────────────────────

  async commit(writes: WriteSpec[]): Promise<void> {
    if (!Array.isArray(writes) || !writes.length || writes.length > 500)
      throw new LiveError('invalid-argument', 'A commit carries 1–500 writes');
    // Check every write against the rules first: all or nothing.
    for (const w of writes) {
      if (!isDocPath(w.path)) throw new LiveError('invalid-argument', 'Bad document path');
      const snap = await db().doc(w.path).get();
      const before = snap.exists ? (snap.data() as DocumentData) : null;
      const data = w.data ? (fromWire(w.data) as Record<string, unknown>) : {};
      let method: 'create' | 'update' | 'delete';
      let after: Record<string, unknown> | null = null;
      if (w.kind === 'delete') method = 'delete';
      else if (w.kind === 'update') {
        if (!before) throw new LiveError('not-found', `No document to update: ${w.path}`);
        method = 'update';
        after = { ...before };
        for (const [k, v] of Object.entries(data)) {
          const segs = k.split('.');
          let cur = after as Record<string, unknown>;
          for (const s of segs.slice(0, -1)) {
            cur[s] = typeof cur[s] === 'object' && cur[s] !== null ? { ...(cur[s] as object) } : {};
            cur = cur[s] as Record<string, unknown>;
          }
          const last = segs[segs.length - 1]!;
          const r = resolveForRules(v, cur[last]);
          if (r === undefined) delete cur[last];
          else cur[last] = r;
        }
      } else {
        if (w.kind === 'create' && before)
          throw new LiveError('already-exists', `Document already exists: ${w.path}`);
        method = before ? 'update' : 'create';
        after = (
          w.merge ? resolveForRules(data, before ?? {}) : resolveForRules(data, {})
        ) as Record<string, unknown>;
        if (w.merge && before) after = { ...before, ...after };
      }
      if (!(await firestoreAllows(this.auth, method, w.path, before, after))) throw denied();
    }
    const batch = db().batch();
    for (const w of writes) {
      const ref = db().doc(w.path);
      const data = w.data ? (fromWire(w.data) as Record<string, unknown>) : {};
      if (w.kind === 'delete') batch.delete(ref);
      else if (w.kind === 'update') batch.update(ref, data);
      else if (w.kind === 'create') batch.create(ref, data);
      else
        batch.set(ref, data, w.mergeFields ? { mergeFields: w.mergeFields } : { merge: !!w.merge });
    }
    await batch.commit();
  }

  // ─── messages ──────────────────────────────────────────────────────────────

  async handle(msg: Msg): Promise<void> {
    const reply = (result: unknown) => this.send({ id: msg.id, ok: true, result });
    try {
      if (typeof msg.op === 'string' && (msg.op as string).startsWith('rtdb.'))
        return reply(await this.rtdb.handle(msg as never));
      switch (msg.op) {
        case 'get':
          return reply(await this.getDoc(msg.path));
        case 'query':
          return reply(await this.runQuery(msg.q));
        case 'listen':
          await this.listen(msg.lid, msg.path, msg.q);
          return reply(null);
        case 'unlisten':
          this.listeners.delete(msg.lid);
          return reply(null);
        case 'commit':
          await this.commit(msg.writes);
          return reply(null);
        default:
          throw new LiveError('invalid-argument', 'Unknown op');
      }
    } catch (e) {
      const err =
        e instanceof LiveError
          ? e
          : e instanceof RtdbDenied
            ? new LiveError('permission-denied', e.message)
            : /invalid key|undefined|Cannot store/.test(String((e as Error)?.message))
              ? new LiveError('invalid-argument', (e as Error).message)
              : (e as { code?: number }).code === 5
                ? new LiveError('not-found', (e as Error).message)
                : (e as { code?: number }).code === 6
                  ? new LiveError('already-exists', (e as Error).message)
                  : (e as { code?: number }).code === 3
                    ? new LiveError('invalid-argument', (e as Error).message)
                    : new LiveError('internal', 'Internal error');
      this.send({ id: msg.id, ok: false, error: { code: err.code, message: err.message } });
    }
  }

  close(): void {
    this.rtdb.close();
    this.listeners.clear();
    this.offChanges?.();
    this.offChanges = undefined;
  }
}
