/**
 * THE BROKER (docs/plan/artifacts.html §D3, §E3) — the host page's half of the
 * driver protocol. An artifact is somebody else's code in a sandboxed iframe;
 * this turns each message it posts into ONE call, as the signed-in viewer, on
 * a path built HERE from the artifact id the host page holds.
 *
 * What it promises, whatever the iframe sends:
 *   · only `event.source === frame()` is heard, and only tagged messages;
 *   · every location comes out of the shared fence (@tm/shared artifacts/paths)
 *     with OUR artifactId — an id or a prefix inside a message is just more
 *     path, and '..' is refused;
 *   · a malformed message is answered with invalid-argument, never thrown;
 *   · a read-only viewer's writes are refused before any call is made;
 *   · at most ARTIFACT_MAX_LISTENERS live listeners, all dropped on stop(),
 *     on revoke() and when the iframe loads a new document (a fresh 'ready').
 *
 * It is NOT the security boundary — the viewer can edit this file's behaviour
 * in devtools — the rules are (§E4). It is what a well-behaved host sends.
 *
 * Pure: Firebase arrives as `backend` (./firebaseBackend in the app, a fake in
 * broker.test.ts), so nothing here imports the SDK.
 */
import {
  ARTIFACT_MAX_LISTENERS,
  ARTIFACT_UPLOAD_MAX_BYTES,
  artifactFirestoreCollection,
  artifactFirestoreDoc,
  artifactFirestoreRelative,
  artifactKvDoc,
  artifactPrefix,
  artifactRtdbPath,
  artifactStorageFile,
  artifactStoragePrefix,
  DRIVER_PROTOCOL_VERSION,
  DRIVER_TAG,
  DRIVER_WRITE_OPS,
  isDriverMessage,
  isDriverOp,
  LIST_LIMIT_MAX,
  WHERE_OPS,
  type ArtifactBoardAccess,
  type ArtifactRole,
  type DriverArtifact,
  type DriverDoc,
  type DriverError,
  type DriverErrorCode,
  type DriverMe,
  type DriverOp,
  type FromHost,
  type SignalMsg,
  type WhereOp,
} from '@tm/shared';
import { createTicketOps, isTicketOp, type TicketBackend } from './brokerTickets';
import { fromStored, isPlainObject, toStored, toStoredObject, type WriteCodec } from './convert';

export const LIST_LIMIT_DEFAULT = 100;

/** A query after the broker has checked it: what a backend may trust. */
export interface CheckedQuery {
  where: [field: string, op: WhereOp, value: unknown][];
  orderBy: [field: string, dir: 'asc' | 'desc'] | null;
  limit: number;
  /** A document id in the listed collection. */
  startAfter: string | null;
}

export interface StoredDoc {
  exists: boolean;
  data: Record<string, unknown> | null;
}
export interface StoredRow {
  id: string;
  data: Record<string, unknown>;
}
export interface StoredFile {
  path: string;
  size: number;
  contentType: string | null;
  updatedAt: number;
}
type Stop = () => void;
type OnError = (error: unknown) => void;

/**
 * The stores, as the signed-in viewer. Every `path` it is given is a FULL
 * path the broker built through the fence; values are already converted with
 * the codecs below. `files` takes paths in the artifact's own view, because
 * those go to commands that prefix them server-side.
 */
export interface BrokerBackend {
  fs: {
    codec: WriteCodec;
    /** The store's timestamp → Date, anything else → null. */
    asDate(v: unknown): Date | null;
    get(path: string): Promise<StoredDoc>;
    set(path: string, data: Record<string, unknown>, merge: boolean): Promise<void>;
    update(path: string, patch: Record<string, unknown>): Promise<void>;
    delete(path: string): Promise<void>;
    /** → the new document's id. */
    add(collection: string, data: Record<string, unknown>): Promise<string>;
    list(collection: string, query: CheckedQuery): Promise<StoredRow[]>;
    onDoc(path: string, next: (doc: StoredDoc) => void, error: OnError): Stop;
    onList(
      collection: string,
      query: CheckedQuery,
      next: (rows: StoredRow[]) => void,
      error: OnError,
    ): Stop;
  };
  rtdb: {
    codec: WriteCodec;
    get(path: string): Promise<unknown>;
    set(path: string, value: unknown): Promise<void>;
    update(path: string, patch: Record<string, unknown>): Promise<void>;
    /** → the new child's key. */
    push(path: string, value: unknown): Promise<string>;
    remove(path: string): Promise<void>;
    on(path: string, next: (value: unknown) => void, error: OnError): Stop;
  };
  storage: {
    upload(path: string, blob: Blob, contentType: string): Promise<void>;
  };
  files: {
    url(path: string): Promise<{ url: string; expiresAt: number }>;
    list(path: string): Promise<StoredFile[]>;
    delete(path: string): Promise<void>;
  };
  /** §K: boards' tickets, as the viewer (./brokerTickets). */
  tickets: TicketBackend;
}

/** Anything with postMessage — the iframe's contentWindow. */
export interface FrameWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}
export interface BrokerEvent {
  source: unknown;
  data: unknown;
}

export interface BrokerOptions {
  /** THE id. Held by the host page (from its own URL); nothing in a message can change it. */
  artifactId: string;
  uid: string;
  /** The iframe's window, asked on every message — it is null until the iframe exists. */
  frame: () => FrameWindow | null;
  /** Name and build for the handshake (live: a rename shows on the next hello). */
  artifact: () => Omit<DriverArtifact, 'id'>;
  viewer: () => Pick<DriverMe, 'name' | 'email' | 'photoURL'>;
  role: ArtifactRole;
  /** True when THIS viewer may not write (artifactCan.writeData is false). */
  readOnly: boolean;
  backend: BrokerBackend;
  /** §K: the artifact's live board grants (artifact.boards); none when absent. */
  boards?: () => Readonly<Record<string, ArtifactBoardAccess>>;
  /** The app's origin, for ticket links (location.origin). */
  origin?: string;
  maxListeners?: number;
  now?: () => number;
}

export interface Broker {
  /** The window 'message' handler. Never throws. */
  handle(event: BrokerEvent): void;
  /** window.addEventListener('message', …) + the matching stop(). */
  attach(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): Stop;
  /** The viewer's role or write access changed: tell the artifact, and behave accordingly. */
  setAccess(role: ArtifactRole, readOnly: boolean): void;
  /** The viewer lost access: tell the artifact, drop every listener, refuse everything after. */
  revoke(): void;
  /** A newer build was published. */
  announceBuild(buildId: string): void;
  /** Close every live listener (the iframe went away). */
  stop(): void;
  readonly listeners: number;
  readonly revoked: boolean;
}

/** An error the broker raises itself, with the code the artifact will see. */
export class BrokerError extends Error {
  constructor(
    readonly code: DriverErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}

const DRIVER_CODES: readonly DriverErrorCode[] = [
  'permission-denied',
  'not-found',
  'invalid-argument',
  'quota',
  'unavailable',
];
const CODE_MAP: Record<string, DriverErrorCode> = {
  // Firestore / RTDB (FirebaseError.code, with or without a product prefix)
  'permission-denied': 'permission-denied',
  permission_denied: 'permission-denied',
  unauthenticated: 'permission-denied',
  'not-found': 'not-found',
  'invalid-argument': 'invalid-argument',
  // A query that needs an index, or an inequality Firestore does not allow:
  // something about the CALL is wrong, and the message says what.
  'failed-precondition': 'invalid-argument',
  'out-of-range': 'invalid-argument',
  'already-exists': 'invalid-argument',
  'resource-exhausted': 'quota',
  // Storage
  unauthorized: 'permission-denied',
  'object-not-found': 'not-found',
  'quota-exceeded': 'quota',
  'invalid-argument-count': 'invalid-argument',
  // The app's own commands (AppError.code)
  forbidden: 'permission-denied',
  not_found: 'not-found',
  gone: 'not-found',
  invalid: 'invalid-argument',
  unprocessable: 'invalid-argument',
  too_large: 'quota',
  rate_limited: 'quota',
};

/** Whatever a store, a command or this file threw → what the artifact is told. */
export function toDriverError(e: unknown): DriverError {
  const o = (e && typeof e === 'object' ? e : {}) as { code?: unknown; message?: unknown };
  const message = typeof o.message === 'string' && o.message ? o.message : 'Something went wrong';
  const raw = typeof o.code === 'string' ? o.code : '';
  if (DRIVER_CODES.includes(raw as DriverErrorCode))
    return { code: raw as DriverErrorCode, message };
  // 'firestore/permission-denied', 'storage/unauthorized', 'PERMISSION_DENIED' …
  const key = raw.slice(raw.lastIndexOf('/') + 1);
  const code = CODE_MAP[key] ?? CODE_MAP[key.toLowerCase()] ?? 'unavailable';
  return { code, message };
}

const bad = (message: string): never => {
  throw new BrokerError('invalid-argument', message);
};

export function createBroker(o: BrokerOptions): Broker {
  const { artifactId: id, uid, backend } = o;
  const max = o.maxListeners ?? ARTIFACT_MAX_LISTENERS;
  const now = o.now ?? Date.now;
  let role = o.role;
  let readOnly = o.readOnly;
  let revoked = false;
  let subSeq = 0;
  const subs = new Map<string, Stop>();

  // ── out ────────────────────────────────────────────────────────────────────
  /**
   * targetOrigin '*': a sandboxed frame's origin is opaque, there is no name to
   * target. That is safe because the RECEIVER is fixed — this only ever posts to
   * the window of the iframe the host page created.
   */
  function post(msg: Record<string, unknown>): boolean {
    const frame = o.frame();
    if (!frame) return false;
    try {
      frame.postMessage({ tag: DRIVER_TAG, v: DRIVER_PROTOCOL_VERSION, ...msg } as FromHost, '*');
      return true;
    } catch {
      // DataCloneError: something in a stored value could not be cloned.
      return false;
    }
  }
  const respond = (reqId: string, value: unknown) => {
    if (!post({ type: 'res', id: reqId, ok: true, value }))
      respondError(
        reqId,
        new BrokerError('unavailable', 'The result could not be sent to the artifact'),
      );
  };
  const respondError = (reqId: string, e: unknown) =>
    void post({ type: 'res', id: reqId, ok: false, error: toDriverError(e) });
  const signal = (name: SignalMsg['name'], value: unknown) =>
    void post({ type: 'signal', name, value });

  const me = (): DriverMe => ({ uid, ...o.viewer(), role, readOnly });
  const hello = () => void post({ type: 'hello', artifact: { id, ...o.artifact() }, me: me() });

  function stop() {
    for (const s of subs.values()) {
      try {
        s();
      } catch {
        /* a listener that will not close is still forgotten */
      }
    }
    subs.clear();
  }

  // ── subscriptions ──────────────────────────────────────────────────────────
  /** Answers { sub } FIRST, then starts — so no snapshot can reach the iframe before its id does. */
  function subscribe(
    reqId: string,
    start: (next: (value: unknown) => void, error: OnError) => Stop,
  ) {
    if (subs.size >= max)
      throw new BrokerError(
        'quota',
        `An artifact may hold at most ${max} live listeners; unsubscribe the ones you no longer need`,
      );
    const sub = `s${++subSeq}`;
    // Reserve the slot before starting: a listener may call back synchronously.
    subs.set(sub, () => {});
    respond(reqId, { sub });
    try {
      const off = start(
        (value) => {
          if (!subs.has(sub)) return;
          if (!post({ type: 'event', sub, ok: true, value }))
            fail(new BrokerError('unavailable', 'A snapshot could not be sent to the artifact'));
        },
        (e) => fail(e),
      );
      // It failed (or was unsubscribed) while starting: close what start() returned.
      if (subs.has(sub)) subs.set(sub, off);
      else off();
    } catch (e) {
      fail(e);
    }
    /** An error ends the subscription: say so once and free the slot. */
    function fail(e: unknown) {
      const off = subs.get(sub);
      if (!off) return;
      subs.delete(sub);
      try {
        off();
      } catch {
        /* already closed */
      }
      post({ type: 'event', sub, ok: false, error: toDriverError(e) });
    }
  }

  // ── argument checks (the iframe is untrusted: nothing is assumed) ──────────
  const relDoc = (full: string) => artifactFirestoreRelative(id, full);
  const idOf = (full: string) => full.slice(full.lastIndexOf('/') + 1);
  const toDoc = (full: string, snap: StoredDoc): DriverDoc => ({
    id: idOf(full),
    path: relDoc(full),
    exists: snap.exists,
    data:
      snap.exists && snap.data
        ? (fromStored(snap.data, backend.fs.asDate) as Record<string, unknown>)
        : null,
  });
  const toDocs = (collection: string, rows: StoredRow[]): DriverDoc[] =>
    rows.map((r) => toDoc(`${collection}/${r.id}`, { exists: true, data: r.data }));

  function checkQuery(collectionArg: unknown, q: unknown): CheckedQuery {
    if (q === undefined || q === null)
      return { where: [], orderBy: null, limit: LIST_LIMIT_DEFAULT, startAfter: null };
    if (!isPlainObject(q)) return bad('A query must be an object');
    const where: CheckedQuery['where'] = [];
    if (q.where !== undefined) {
      if (!Array.isArray(q.where) || q.where.length > 30)
        return bad('where must be an array of at most 30 [field, op, value]');
      for (const w of q.where as unknown[]) {
        if (!Array.isArray(w) || w.length !== 3)
          return bad('where must be an array of [field, op, value]');
        const [field, op, value] = w as [unknown, unknown, unknown];
        if (typeof field !== 'string' || !field || field.length > 1024)
          return bad('where: the field must be a non-empty string');
        if (!WHERE_OPS.includes(op as WhereOp))
          return bad(`where: unknown operator ${JSON.stringify(op) ?? String(op)}`);
        // A Date in a filter compares against timestamps; serverTime has no meaning here.
        where.push([
          field,
          op as WhereOp,
          toStored(value, {
            ...backend.fs.codec,
            serverTime: () => bad('serverTime cannot be used in a query'),
          }),
        ]);
      }
    }
    let orderBy: CheckedQuery['orderBy'] = null;
    if (q.orderBy !== undefined) {
      const ob = q.orderBy;
      if (!Array.isArray(ob) || typeof ob[0] !== 'string' || !ob[0] || ob.length > 2)
        return bad("orderBy must be [field, 'asc' | 'desc']");
      if (ob[1] !== undefined && ob[1] !== 'asc' && ob[1] !== 'desc')
        return bad("orderBy's direction is 'asc' or 'desc'");
      orderBy = [ob[0], ob[1] ?? 'asc'];
    }
    let limit = LIST_LIMIT_DEFAULT;
    if (q.limit !== undefined) {
      if (typeof q.limit !== 'number' || !Number.isFinite(q.limit) || q.limit < 1)
        return bad('limit must be a positive number');
      limit = Math.min(Math.floor(q.limit), LIST_LIMIT_MAX);
    }
    let startAfter: string | null = null;
    if (q.startAfter !== undefined) {
      if (typeof q.startAfter !== 'string' || q.startAfter.includes('/'))
        return bad('startAfter must be a document id in this collection');
      // Through the fence like any other id: '..' and '__x__' are refused.
      startAfter = idOf(artifactFirestoreDoc(id, `${String(collectionArg)}/${q.startAfter}`));
    }
    return { where, orderBy, limit, startAfter };
  }

  /** rtdb.update's keys may be paths ('a/b'): each one goes through the fence, relative to `base`. */
  function rtdbPatch(base: string, patch: unknown): Record<string, unknown> {
    if (!isPlainObject(patch)) return bad('patch must be an object');
    const out: Record<string, unknown> = {};
    const root = artifactPrefix.rtdb(id);
    const rel = base === root ? '' : base.slice(root.length + 1);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      const full = artifactRtdbPath(id, `${rel}/${k}`);
      const key = full.slice(base.length + 1);
      if (!key) return bad('A patch key cannot be empty');
      out[key] = toStored(v, backend.rtdb.codec);
    }
    return out;
  }

  // ── the operations ─────────────────────────────────────────────────────────
  const tickets = createTicketOps({
    uid,
    backend: backend.tickets,
    grants: () => o.boards?.() ?? {},
    origin: o.origin ?? '',
    subscribe,
    fail: (code, message) => {
      throw new BrokerError(code, message);
    },
  });

  async function run(op: DriverOp, reqId: string, a: Record<string, unknown>): Promise<unknown> {
    if (isTicketOp(op)) return tickets.run(op, reqId, a);
    const { fs, rtdb } = backend;
    switch (op) {
      case 'fs.get': {
        const path = artifactFirestoreDoc(id, a.path);
        return toDoc(path, await fs.get(path));
      }
      case 'fs.set': {
        const path = artifactFirestoreDoc(id, a.path);
        await fs.set(path, toStoredObject(a.data, fs.codec, 'data'), a.merge === true);
        return { ok: true };
      }
      case 'fs.update': {
        const path = artifactFirestoreDoc(id, a.path);
        await fs.update(path, toStoredObject(a.patch, fs.codec, 'patch'));
        return { ok: true };
      }
      case 'fs.delete': {
        await fs.delete(artifactFirestoreDoc(id, a.path));
        return { ok: true };
      }
      case 'fs.add': {
        const collection = artifactFirestoreCollection(id, a.path);
        const newId = await fs.add(collection, toStoredObject(a.data, fs.codec, 'data'));
        return { id: newId, path: relDoc(`${collection}/${newId}`) };
      }
      case 'fs.list': {
        const collection = artifactFirestoreCollection(id, a.path);
        return toDocs(collection, await fs.list(collection, checkQuery(a.path, a.query)));
      }
      case 'fs.onDoc': {
        const path = artifactFirestoreDoc(id, a.path);
        return subscribe(reqId, (next, error) =>
          fs.onDoc(path, (snap) => next(toDoc(path, snap)), error),
        );
      }
      case 'fs.onList': {
        const collection = artifactFirestoreCollection(id, a.path);
        const query = checkQuery(a.path, a.query);
        return subscribe(reqId, (next, error) =>
          fs.onList(collection, query, (rows) => next(toDocs(collection, rows)), error),
        );
      }
      case 'rtdb.get':
        return (await rtdb.get(artifactRtdbPath(id, a.path))) ?? null;
      case 'rtdb.set': {
        if (a.value === undefined) return bad('set needs a value (null removes)');
        await rtdb.set(artifactRtdbPath(id, a.path), toStored(a.value, rtdb.codec));
        return { ok: true };
      }
      case 'rtdb.update': {
        const path = artifactRtdbPath(id, a.path);
        await rtdb.update(path, rtdbPatch(path, a.patch));
        return { ok: true };
      }
      case 'rtdb.push': {
        if (a.value === undefined) return bad('push needs a value');
        const path = artifactRtdbPath(id, a.path);
        const key = await rtdb.push(path, toStored(a.value, rtdb.codec));
        return { key, path: `/${`${path}/${key}`.slice(artifactPrefix.rtdb(id).length + 1)}` };
      }
      case 'rtdb.remove': {
        await rtdb.remove(artifactRtdbPath(id, a.path));
        return { ok: true };
      }
      case 'rtdb.on': {
        const path = artifactRtdbPath(id, a.path);
        return subscribe(reqId, (next, error) => rtdb.on(path, (v) => next(v ?? null), error));
      }
      case 'st.upload': {
        const path = artifactStorageFile(id, a.path);
        const blob = a.blob as Blob | undefined;
        // A real Blob/File after the clone; duck-typed so a fake can stand in.
        if (
          !blob ||
          typeof blob !== 'object' ||
          typeof blob.size !== 'number' ||
          typeof blob.type !== 'string'
        )
          return bad('upload needs a Blob or File');
        if (blob.size > ARTIFACT_UPLOAD_MAX_BYTES)
          throw new BrokerError(
            'quota',
            `A file may be at most ${Math.round(ARTIFACT_UPLOAD_MAX_BYTES / 1024 / 1024)} MB`,
          );
        if (
          a.contentType !== undefined &&
          (typeof a.contentType !== 'string' || a.contentType.length > 200)
        )
          return bad('contentType must be a short string');
        await backend.storage.upload(
          path,
          blob,
          a.contentType || blob.type || 'application/octet-stream',
        );
        return { path: storageRel(path), size: blob.size };
      }
      case 'st.url':
        return backend.files.url(storageRel(artifactStorageFile(id, a.path)));
      case 'st.list': {
        const prefix = artifactStoragePrefix(id, a.path ?? '');
        const files = await backend.files.list(storageRel(prefix));
        // The command answers in the artifact's view; be sure of it either way.
        return files.map((f) => ({
          ...f,
          path: f.path.startsWith(artifactPrefix.storageFiles(id))
            ? storageRel(f.path)
            : `/${f.path.replace(/^\/+/, '')}`,
        }));
      }
      case 'st.delete': {
        await backend.files.delete(storageRel(artifactStorageFile(id, a.path)));
        return { ok: true };
      }
      case 'kv.get': {
        const snap = await fs.get(artifactKvDoc(id, uid, a.key));
        return snap.exists && snap.data ? fromStored(snap.data.value, fs.asDate) : null;
      }
      case 'kv.set': {
        const path = artifactKvDoc(id, uid, a.key);
        if (a.value === undefined)
          return bad('kv.set needs a value (use kv.delete to remove a key)');
        await fs.set(path, { value: toStored(a.value, fs.codec), updatedAt: now() }, false);
        return { ok: true };
      }
      case 'kv.delete': {
        await fs.delete(artifactKvDoc(id, uid, a.key));
        return { ok: true };
      }
    }
  }
  const storageRel = (full: string) =>
    `/${full.slice(artifactPrefix.storageFiles(id).length).replace(/^\/+/, '')}`;

  function request(msg: { id?: unknown; op?: unknown; args?: unknown }) {
    // Without a usable id there is nobody to answer.
    if (typeof msg.id !== 'string' || !msg.id || msg.id.length > 128) return;
    const reqId = msg.id;
    try {
      if (revoked)
        throw new BrokerError('permission-denied', 'You no longer have access to this artifact');
      if (!isDriverOp(msg.op)) return bad('Unknown operation');
      const op = msg.op;
      if (DRIVER_WRITE_OPS.has(op) && readOnly)
        throw new BrokerError('permission-denied', 'This artifact is read-only for you');
      if (!isPlainObject(msg.args)) return bad('args must be an object');
      const isSub =
        op === 'fs.onDoc' || op === 'fs.onList' || op === 'rtdb.on' || op === 'tk.onList';
      run(op, reqId, msg.args).then(
        // subscribe() has already answered with { sub }.
        (value) => isSub || respond(reqId, value),
        (e) => respondError(reqId, e),
      );
    } catch (e) {
      respondError(reqId, e);
    }
  }

  function handle(event: BrokerEvent) {
    try {
      const frame = o.frame();
      // THE SOURCE CHECK. Any window can post to this page; only our iframe is heard.
      if (!frame || event.source !== frame) return;
      if (!isDriverMessage(event.data)) return;
      const msg = event.data as {
        type: string;
        id?: unknown;
        op?: unknown;
        args?: unknown;
        sub?: unknown;
      };
      switch (msg.type) {
        case 'ready':
          // A fresh document in the iframe (first load, a reload, a navigation):
          // whatever the previous one was listening to died with it.
          stop();
          hello();
          return;
        case 'req':
          return request(msg);
        case 'unsub': {
          if (typeof msg.sub !== 'string') return;
          const off = subs.get(msg.sub);
          if (!off) return;
          subs.delete(msg.sub);
          off();
          return;
        }
      }
    } catch {
      /* the iframe is untrusted: nothing it sends may take the broker down */
    }
  }

  return {
    handle,
    attach(target) {
      const listener = (e: MessageEvent) => handle(e);
      target.addEventListener('message', listener as EventListener);
      return () => {
        target.removeEventListener('message', listener as EventListener);
        stop();
      };
    },
    setAccess(nextRole, nextReadOnly) {
      const changed = nextReadOnly !== readOnly;
      role = nextRole;
      readOnly = nextReadOnly;
      if (changed && !revoked) signal('readonly', readOnly);
    },
    revoke() {
      if (revoked) return;
      revoked = true;
      stop();
      signal('revoked', null);
    },
    announceBuild(buildId) {
      if (!revoked) signal('build', buildId);
    },
    stop,
    get listeners() {
      return subs.size;
    },
    get revoked() {
      return revoked;
    },
  };
}
