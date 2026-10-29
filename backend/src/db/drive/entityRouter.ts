/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * THE ROUTER'S OTHER ROUTE (docs/plan/bucket.html §L5) — everything an entity
 * keeps in Drive that is not a ticket: its settings fields, and the documents
 * of its Drive subtrees (entities.ts says which).
 *
 *   boards/{b}                 the database's document + settings.json
 *   boards/{b}/views/{v}       views/{v}.json
 *   dictionaries/{d}/content/… content/….enc.json (sealed: keyring.ts)
 *   artifacts/{a}/db/data/…    db/data/….json
 *
 * Same contract as tickets (router.ts): a transaction reads freely; before the
 * database commits, every Drive document it changes is leased and checked
 * against the version it read (driveRev/{key}); after the commit the files
 * are written and the version moves (the ping). An entity document's write is
 * split by field: its settings go to the file, everything else stays a
 * database write in the same transaction — so counters and access stay atomic.
 */
import { applyWrite, updatePairs, type WriteOp } from '../engine/mutate.js';
import { Timestamp as SqlTimestamp } from '../engine/values.js';
import type * as P from '../types.js';
import {
  assertEntityNotMoving,
  driveEntityOf,
  driveOf,
  forgetEntityStorage,
  noteEntity,
  type DriveEntity,
} from './board.js';
import { readDocFile, writeDocFile, listDocFiles, type Sealer } from './docfiles.js';
import {
  ENTITY_SPECS,
  entityRevKey,
  splitFields,
  type EntityColLoc,
  type EntityLoc,
} from './entities.js';
import { sealerFor } from './keyring.js';
import { acquireAt, readRevAt, releaseAt, entityRevPath } from './lease.js';
import { refreshManifest } from './manifest.js';
import {
  DriveRetry,
  getAt,
  lastSeg,
  parentOf,
  RDocSnap,
  segsOf,
  toOp,
  WRITE_RESULT,
  type Conv,
  type Json,
  type Method,
} from './snap.js';
import type { RoutedDb } from './router.js';
import { decodeJson, encodeJson, foreignSegments, isRefValue, toLocal } from './values.js';

// ─── the reference ───────────────────────────────────────────────────────────

export class EDocRef<T = P.DocumentData> implements P.DocumentReference<T> {
  constructor(
    readonly db: RoutedDb,
    readonly path: string,
    readonly conv: Conv,
    readonly loc: EntityLoc,
  ) {}
  get id(): string {
    return lastSeg(this.path);
  }
  get parent(): P.CollectionReference<T> {
    return this.db.collection(parentOf(this.path)) as any;
  }
  collection(sub: string): P.CollectionReference<P.DocumentData> {
    return this.db.collection(`${this.path}/${sub}`);
  }
  /** The database's document, with the caller's converter. */
  baseRef(): P.DocumentReference<T> {
    const r = this.db.base.doc(this.path);
    return (this.conv ? r.withConverter(this.conv) : r) as P.DocumentReference<T>;
  }
  plainRef(): P.DocumentReference<P.DocumentData> {
    return this.db.base.doc(this.path);
  }
  listCollections(): Promise<P.CollectionReference<P.DocumentData>[]> {
    return this.db.base.doc(this.path).listCollections();
  }
  get(): Promise<P.DocumentSnapshot<T>> {
    return readEntityRef(this.db, this, null, null) as Promise<P.DocumentSnapshot<T>>;
  }
  private async write(method: Method, args: unknown[]): Promise<P.WriteResult> {
    await this.db.writeNow([[this as any, method, args]]);
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
    return new EDocRef<U>(this.db, this.path, converter as Conv, this.loc);
  }
}

// ─── reads ───────────────────────────────────────────────────────────────────

/** What a transaction read of a Drive document: its version and contents (for the write check). */
export type EReads = Map<string, { v: number | null; doc: Json | undefined }>;

const revOf = (l: EntityLoc) => entityRevPath(l.kind, l.id, entityRevKey(l));
const settingsRel = (l: EntityLoc) => [ENTITY_SPECS[l.kind].settingsFile];

function driveFromStorage(l: EntityLoc, storage: any): DriveEntity | null {
  return storage?.kind === 'drive' && storage.uid && storage.folderId
    ? { kind: l.kind, id: l.id, uid: storage.uid, folderId: storage.folderId }
    : null;
}

async function sealerOf(e: DriveEntity, secret: boolean): Promise<Sealer | null> {
  return secret ? sealerFor(e) : null;
}

/** Only the fields an entity keeps in Drive. */
function pickSettings(kind: EntityLoc['kind'], doc: Json | undefined): Json {
  const out: Json = {};
  if (!doc) return out;
  for (const f of ENTITY_SPECS[kind].settingsFields) if (doc[f] !== undefined) out[f] = doc[f];
  return out;
}

export async function readEntityRef(
  db: RoutedDb,
  ref: EDocRef<any>,
  btx: P.Transaction | null,
  reads: EReads | null,
): Promise<P.DocumentSnapshot<any>> {
  const l = ref.loc;
  if (l.t === 'entity') {
    const snap = btx ? await btx.get(ref.baseRef()) : await ref.baseRef().get();
    const storage = snap.exists ? snap.get('storage') : undefined;
    noteEntity(l.kind, l.id, snap.exists ? { storage, move: snap.get('move') } : undefined);
    const e = driveFromStorage(l, storage);
    if (!e || !ENTITY_SPECS[l.kind].settingsFields.length) return snap;
    const plain = btx ? await btx.get(ref.plainRef()) : await ref.plainRef().get();
    const rev = await readRevAt(db.base, revOf(l));
    const { doc: settings } = await readDocFile(await driveOf(e), e.folderId, settingsRel(l), null);
    reads?.set(revOf(l), { v: rev?.v ?? null, doc: settings });
    // Settings from the file; a field the file does not have yet falls back to the database's.
    const merged = {
      ...(plain.data() as Json),
      ...(decodeJson(pickSettings(l.kind, settings), db.Ts) as Json),
    };
    return new RDocSnap(ref as any, encodeJson(merged) as Json);
  }
  const e = await driveEntityOf(db.base, l.kind, l.id);
  if (!e) return btx ? btx.get(ref.baseRef()) : ref.baseRef().get();
  const rev = await readRevAt(db.base, revOf(l));
  const { doc } = await readDocFile(
    await driveOf(e),
    e.folderId,
    l.rel,
    await sealerOf(e, l.secret),
  );
  reads?.set(revOf(l), { v: rev?.v ?? null, doc });
  return new RDocSnap(ref as any, doc);
}

/** Rows of a Drive subtree collection, for the in-memory planner; null = it is in the database. */
export async function entityRows(
  db: RoutedDb,
  l: Extract<EntityColLoc, { t: 'files' }>,
  colPath: string,
): Promise<{ id: string; path: string; data: Json }[] | null> {
  const e = await driveEntityOf(db.base, l.kind, l.id);
  if (!e) return null;
  const rows = await listDocFiles(await driveOf(e), e.folderId, l.rel, await sealerOf(e, l.secret));
  return rows.map((r) => ({ id: r.id, path: `${colPath}/${r.id}`, data: r.doc }));
}

/**
 * An entity collection (boards, dictionaries…): the database's answer, with
 * each Drive entity's settings merged in. Filters on a settings field see
 * the database's copy only — none of the app's queries filter on one.
 */
export async function mergeEntityRows(
  db: RoutedDb,
  kind: EntityLoc['kind'],
  snap: P.QuerySnapshot<any>,
): Promise<{ id: string; path: string; data: Json }[] | null> {
  if (!ENTITY_SPECS[kind].settingsFields.length) return null;
  const drives = snap.docs.map((d) =>
    driveFromStorage({ t: 'entity', kind, id: d.id }, d.get('storage')),
  );
  if (!drives.some(Boolean)) return null;
  return Promise.all(
    snap.docs.map(async (d, i) => {
      const e = drives[i];
      const plain = d.data() as Json;
      if (!e) return { id: d.id, path: d.ref.path, data: encodeJson(plain) as Json };
      try {
        const { doc } = await readDocFile(
          await driveOf(e),
          e.folderId,
          [ENTITY_SPECS[kind].settingsFile],
          null,
        );
        const merged = { ...plain, ...(decodeJson(pickSettings(kind, doc), db.Ts) as Json) };
        return { id: d.id, path: d.ref.path, data: encodeJson(merged) as Json };
      } catch (err) {
        console.warn(`[drive] ${kind}/${d.id}: settings not read`, err);
        return { id: d.id, path: d.ref.path, data: encodeJson(plain) as Json };
      }
    }),
  );
}

// ─── writes ──────────────────────────────────────────────────────────────────

/** Staged writes to ONE Drive document. */
export interface EWork {
  e: DriveEntity;
  loc: EntityLoc;
  rel: string[];
  sealer: Sealer | null;
  rev: string;
  ops: WriteOp[];
  read?: { v: number | null; doc: Json | undefined };
}
export interface EPrepared {
  work: EWork;
  before: Json | undefined;
  after: Json | undefined;
  changed: boolean;
}

/** Where the database's half of a write goes. */
export type BaseSink =
  { kind: 'tx'; btx: P.Transaction } | { kind: 'batch'; bb: P.WriteBatch } | { kind: 'direct' };

async function toBase(
  sink: BaseSink,
  ref: P.DocumentReference<any>,
  method: Method,
  args: unknown[],
) {
  if (sink.kind === 'tx') (sink.btx as any)[method](ref, ...args);
  else if (sink.kind === 'batch') (sink.bb as any)[method](ref, ...args);
  else await (ref as any)[method](...args);
}

/** update()'s arguments → [settings pairs, the rest] as update() arguments again. */
function splitUpdate(
  kind: EntityLoc['kind'],
  args: unknown[],
): [unknown[] | null, unknown[] | null] {
  const keep = new Set(ENTITY_SPECS[kind].settingsFields);
  const top = (f: unknown) =>
    typeof f === 'string' ? f.split('.')[0]! : (foreignSegments(f) ?? [''])[0]!;
  const [first, ...rest] = args;
  if (typeof first === 'string' || foreignSegments(first)) {
    const list = [first, ...rest];
    const pre = list.length % 2 === 1 ? list.pop() : undefined;
    const d: unknown[] = [];
    const b: unknown[] = [];
    for (let i = 0; i < list.length; i += 2)
      (keep.has(top(list[i])) ? d : b).push(list[i], list[i + 1]);
    return [d.length ? d : null, b.length ? (pre ? [...b, pre] : b) : null];
  }
  const obj = first as Json;
  const d: Json = {};
  const b: Json = {};
  for (const [k, v] of Object.entries(obj)) (keep.has(top(k)) ? d : b)[k] = v;
  return [
    Object.keys(d).length ? [d] : null,
    Object.keys(b).length ? (rest[0] ? [b, rest[0]] : [b]) : null,
  ];
}

/**
 * Turn staged writes into database writes (to `sink`) and Drive work. A write
 * to a database-kept entity is the adapter's own, untouched.
 */
export async function planEntityWrites(
  db: RoutedDb,
  calls: [EDocRef<any>, Method, unknown[]][],
  sink: BaseSink,
  reads: EReads | null,
): Promise<{ works: EWork[]; manifests: DriveEntity[] }> {
  const works = new Map<string, EWork>();
  const manifests = new Map<string, DriveEntity>();
  const workFor = async (e: DriveEntity, l: EntityLoc, rel: string[], secret: boolean) => {
    const rev = revOf(l);
    let w = works.get(rev);
    if (!w) {
      w = { e, loc: l, rel, sealer: await sealerOf(e, secret), rev, ops: [] };
      const r = reads?.get(rev);
      if (r) w.read = r;
      works.set(rev, w);
    }
    return w;
  };

  // An entity made (or re-pointed) in this same write: its subtree writes follow it.
  const fresh = new Map<string, DriveEntity>();
  for (const [ref, method, args] of calls) {
    if (ref.loc.t !== 'entity' || (method !== 'create' && method !== 'set')) continue;
    const e = driveFromStorage(ref.loc, (args[0] as any)?.storage);
    if (e) fresh.set(`${ref.loc.kind}/${ref.loc.id}`, e);
  }
  for (const [ref, method, args] of calls) {
    const l = ref.loc;
    if (l.t === 'file') {
      const e = fresh.get(`${l.kind}/${l.id}`) ?? (await driveEntityOf(db.base, l.kind, l.id));
      if (!e) {
        await assertEntityNotMoving(db.base, l.kind, l.id);
        await toBase(sink, ref.baseRef(), method, args);
        continue;
      }
      (await workFor(e, l, l.rel, l.secret)).ops.push(toOp(ref, method, args));
      continue;
    }
    // The entity's own document.
    let data: any = args[0];
    if ((method === 'create' || method === 'set') && ref.conv)
      data = args[1] ? ref.conv.toFirestore(data, args[1] as any) : ref.conv.toFirestore(data);
    const fromData =
      method === 'create' || method === 'set' ? driveFromStorage(l, data?.storage) : null;
    const e = fromData ?? (await driveEntityOf(db.base, l.kind, l.id));
    if (fromData || method === 'delete') forgetEntityStorage(l.kind, l.id);
    if (!e) {
      await toBase(sink, ref.baseRef(), method, args);
      continue;
    }
    manifests.set(`${l.kind}/${l.id}`, e);
    if (!ENTITY_SPECS[l.kind].settingsFields.length) {
      await toBase(sink, ref.baseRef(), method, args);
      continue;
    }
    const plain = ref.plainRef();
    if (method === 'delete') {
      await toBase(sink, plain, 'delete', args);
      continue; // the folder stays: nothing in a person's Drive is deleted by the app
    }
    if (method === 'update') {
      const [d, b] = splitUpdate(l.kind, args);
      if (b) await toBase(sink, plain, 'update', b);
      if (d) {
        const { pairs } = updatePairs(d.map(toLocal));
        (await workFor(e, l, settingsRel(l), false)).ops.push({ kind: 'update', pairs });
      }
      continue;
    }
    const options = method === 'set' ? (args[1] as P.SetOptions | undefined) : undefined;
    const [d, b] = splitFields(l.kind, data as Json);
    if (method === 'create') await toBase(sink, plain, 'create', [b]);
    else await toBase(sink, plain, 'set', options ? [b, options] : [b]);
    if (Object.keys(d).length || !options?.merge)
      (await workFor(e, l, settingsRel(l), false)).ops.push({
        kind: 'set',
        data: toLocal(d) as Json,
        ...(options?.merge ? { merge: true } : {}),
      });
  }
  return { works: [...works.values()], manifests: [...manifests.values()] };
}

/** Lease (in key order), check, compute. */
export async function prepareEntityWorks(
  db: RoutedDb,
  works: EWork[],
  holder: string,
  leased: Map<string, string>,
): Promise<EPrepared[]> {
  const out: EPrepared[] = [];
  for (const w of [...works].sort((a, z) => (a.rev < z.rev ? -1 : 1))) {
    await assertEntityNotMoving(db.base, w.loc.kind, w.loc.id);
    const rev = await acquireAt(db.base, w.rev, holder);
    leased.set(w.rev, w.rev);
    if (w.read && w.read.v !== (rev?.v ?? null)) throw new DriveRetry();
    const before =
      w.read?.doc ?? (await readDocFile(await driveOf(w.e), w.e.folderId, w.rel, w.sealer)).doc;
    const now = SqlTimestamp.now();
    let after = before;
    for (const op of w.ops) {
      // A settings file is created by its first write, whatever kind of write that is.
      const cur = op.kind === 'update' && w.loc.t === 'entity' ? (after ?? {}) : after;
      after = applyWrite(w.rev, cur, op, now, isRefValue);
    }
    out.push({ work: w, before, after, changed: JSON.stringify(before) !== JSON.stringify(after) });
  }
  return out;
}

/** After the database committed: write the files, move the versions. */
export async function finishEntityWorks(
  db: RoutedDb,
  prepared: EPrepared[],
  manifests: DriveEntity[],
  holder: string,
  leased: Map<string, string>,
): Promise<unknown> {
  let failed: unknown = null;
  await Promise.all(
    prepared.map(async (p) => {
      const w = p.work;
      try {
        if (p.changed)
          await writeDocFile(await driveOf(w.e), w.e.folderId, w.rel, p.after, w.sealer);
        await releaseAt(db.base, w.rev, holder, p.changed ? {} : null);
      } catch (e) {
        console.error(`[drive] writing ${w.rev} failed`, e);
        failed = e;
        await releaseAt(db.base, w.rev, holder, null);
      } finally {
        leased.delete(w.rev);
        // Its document was read (moving?) before it existed or changed: read it afresh next time.
        if (w.loc.t === 'entity') forgetEntityStorage(w.loc.kind, w.loc.id);
      }
    }),
  );
  for (const e of manifests) {
    forgetEntityStorage(e.kind, e.id);
    void refreshManifest(db.base, e);
  }
  return failed;
}

// ─── deletes of a whole subtree ──────────────────────────────────────────────

export const isEntityRef = (r: unknown): r is EDocRef<any> => r instanceof EDocRef;
export { getAt, segsOf };
