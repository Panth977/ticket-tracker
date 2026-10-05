/**
 * THE MOCK BACKEND (docs/plan/artifacts.html §E5) — what the driver becomes
 * when it is loaded outside a TaskManager host (vite dev, a file opened from
 * disk): the same operations over an in-memory store saved to localStorage, so
 * an artifact can be built and clicked through without publishing it.
 *
 * It answers the protocol's own operation table, exactly like the host page
 * does, and it validates paths with the SAME fence functions
 * (@tm/shared/artifacts/paths), so a path the mock accepts is one the real
 * backend accepts. What it does not imitate: security rules beyond the
 * read-only switch, indexes, and the 256 KB document limit.
 *
 *   ?role=owner|editor|viewer   who you are (default owner)
 *   ?readonly=1                 the artifact is read-only for viewers (and,
 *                               with no ?role, makes you a viewer — otherwise
 *                               the switch would change nothing you can see)
 */
import {
  DRIVER_WRITE_OPS,
  isServerTime,
  LIST_LIMIT_MAX,
  WHERE_OPS,
  type DriverArgs,
  type DriverDoc,
  type DriverError,
  type DriverMe,
  type DriverOp,
  type DriverResult,
  type ListQuery,
  type TicketInput,
  type TicketQuery,
  type WhereOp,
} from '@tm/shared/artifacts/driver';
import {
  artifactFirestoreCollection,
  artifactFirestoreDoc,
  artifactFirestoreRelative,
  artifactKvDoc,
  artifactPrefix,
  artifactRtdbPath,
  artifactStorageFile,
  artifactStoragePrefix,
} from '@tm/shared/artifacts/paths';
import {
  fail,
  toDriverError,
  type Session,
  type SubOp,
  type Transport,
  type WindowLike,
} from './transport.js';
import {
  commentTicket,
  createTicket,
  listTickets,
  MOCK_BOARD,
  mockBoard,
  seedTickets,
  ticketByKey,
  updateTicket,
  type MockTicketState,
} from './mockTickets.js';
import {
  memoryFile,
  memoryMkdir,
  memoryRemove,
  memoryTree,
  memoryWrite,
  mockMemoryInfo,
  seedMemory,
  type MockMemoryState,
} from './mockMemory.js';

export const MOCK_STORAGE_KEY = 'tm-backend-driver:mock:v1';
/** §E4's upload limit, repeated here so the bundle does not pull in zod with the schema file. */
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const LIST_LIMIT_DEFAULT = 100;
const ID = 'mock';

type Json = Record<string, unknown>;
interface MockState {
  /** '/col/doc' → its fields. */
  fs: Record<string, Json>;
  rtdb: unknown;
  kv: Json;
  /** §K: the DEMO board's tickets. */
  tk: MockTicketState;
  /** memory.html §H: the demo memory (./mockMemory). */
  mem: MockMemoryState;
}
interface MockFile {
  blob: Blob;
  url: string;
  size: number;
  contentType: string | null;
  updatedAt: number;
}

const isPlain = (v: unknown): v is Json =>
  !!v &&
  typeof v === 'object' &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** A deep copy; `now` set = a value being WRITTEN, where db.serverTime becomes the time. */
function copy(v: unknown, now?: () => unknown): unknown {
  if (now && isServerTime(v)) return now();
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map((x) => copy(x, now));
  if (isPlain(v)) {
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = copy(x, now);
    return out;
  }
  return v;
}

// localStorage holds JSON, and JSON has no Date: tag them on the way out.
function encode(v: unknown): unknown {
  if (v instanceof Date) return { __tm: 'date', ms: v.getTime() };
  if (Array.isArray(v)) return v.map(encode);
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  return v;
}
function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (isPlain(v)) {
    if (v.__tm === 'date' && typeof v.ms === 'number') return new Date(v.ms);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
  }
  return v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isPlain(a) && isPlain(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** Firestore's cross-type order, as far as v1's value types go. */
function rank(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'number') return 2;
  if (v instanceof Date) return 3;
  if (typeof v === 'string') return 4;
  if (Array.isArray(v)) return 5;
  return 6;
}
function compare(a: unknown, b: unknown): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return 0;
}

/** 'a.b' reaches into maps, as Firestore field paths do. */
function field(data: Json, path: string): unknown {
  let cur: unknown = data;
  for (const k of path.split('.')) {
    if (!isPlain(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}
function setField(data: Json, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = data;
  for (const k of keys.slice(0, -1)) {
    if (!isPlain(cur[k])) cur[k] = {};
    cur = cur[k] as Json;
  }
  cur[keys[keys.length - 1]!] = value;
}
function merge(into: Json, from: Json): Json {
  for (const [k, v] of Object.entries(from)) {
    if (isPlain(v) && isPlain(into[k])) merge(into[k] as Json, v);
    else into[k] = v;
  }
  return into;
}

function matches(data: Json, [name, op, want]: [string, WhereOp, unknown]): boolean {
  const have = field(data, name);
  const list = Array.isArray(want) ? want : [];
  switch (op) {
    case '==':
      return deepEqual(have, want);
    case '!=':
      // Firestore: != never matches a missing or null field.
      return have !== undefined && have !== null && !deepEqual(have, want);
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (have === undefined || rank(have) !== rank(want)) return false;
      const c = compare(have, want);
      return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
    }
    case 'array-contains':
      return Array.isArray(have) && have.some((x) => deepEqual(x, want));
    case 'array-contains-any':
      return Array.isArray(have) && have.some((x) => list.some((w) => deepEqual(x, w)));
    case 'in':
      return list.some((w) => deepEqual(have, w));
    case 'not-in':
      return have !== undefined && have !== null && !list.some((w) => deepEqual(have, w));
  }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function autoId(): string {
  let s = '';
  for (let i = 0; i < 20; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

const param = (win: WindowLike | undefined, name: string): string | null => {
  try {
    return new URLSearchParams(win?.location?.search ?? '').get(name);
  } catch {
    return null;
  }
};

export function mockMe(win: WindowLike | undefined): DriverMe {
  const asked = param(win, 'role');
  const flag = ['1', 'true'].includes(param(win, 'readonly') ?? '');
  const role =
    asked === 'owner' || asked === 'editor' || asked === 'viewer'
      ? asked
      : flag
        ? 'viewer'
        : 'owner';
  return {
    uid: 'mock-user',
    name: 'Mock User',
    email: 'mock@example.com',
    photoURL: null,
    role,
    // As in the real thing: only a VIEWER is ever read-only.
    readOnly: role === 'viewer' && flag,
  };
}

export function createMock(win: WindowLike | undefined): Session {
  const me = mockMe(win);
  let state: MockState = { fs: {}, rtdb: null, kv: {}, tk: seedTickets(), mem: seedMemory() };
  // Blobs cannot go to localStorage: uploaded files live for this page load only.
  const files = new Map<string, MockFile>();
  /** Blobs written into the demo memory, by path (text files live in state.mem). */
  const memBlobs = new Map<string, { blob: Blob; url: string }>();

  const load = () => {
    try {
      const raw = win?.localStorage?.getItem(MOCK_STORAGE_KEY);
      if (!raw) return;
      const parsed = decode(JSON.parse(raw)) as Partial<MockState>;
      state = {
        fs: isPlain(parsed.fs) ? (parsed.fs as MockState['fs']) : {},
        rtdb: parsed.rtdb ?? null,
        kv: isPlain(parsed.kv) ? parsed.kv : {},
        tk:
          isPlain(parsed.tk) && Array.isArray((parsed.tk as Json).tickets)
            ? (parsed.tk as MockTicketState)
            : seedTickets(),
        mem: isPlain(parsed.mem) ? (parsed.mem as MockMemoryState) : seedMemory(),
      };
    } catch {
      /* no storage (sandbox, private mode) or a corrupt value: start empty */
    }
  };
  const save = () => {
    try {
      win?.localStorage?.setItem(MOCK_STORAGE_KEY, JSON.stringify(encode(state)));
    } catch {
      /* memory only */
    }
  };
  load();

  // ── live listeners: every write re-runs the ones it could have changed ─────
  type Kind = 'fs' | 'rtdb' | 'tk';
  type Listener = { touches: (kind: Kind, path: string) => boolean; fire: () => void };
  const listeners = new Set<Listener>();
  const changed = (kind: Kind | 'all', path = '') => {
    if (kind !== 'all') save();
    for (const l of [...listeners]) {
      if (kind === 'all' || l.touches(kind, path))
        // Like a real snapshot: after the write's own Promise, never inside it.
        void Promise.resolve().then(() => listeners.has(l) && l.fire());
    }
  };
  // Another tab of the same dev server wrote: pick it up and tell everyone.
  win?.addEventListener('storage', ((e: { key?: string | null }) => {
    if (e.key !== MOCK_STORAGE_KEY) return;
    load();
    changed('all');
  }) as (e: never) => void);

  // ── paths: the real fence, with a fixed id, then back to the artifact's view
  const docPath = (p: unknown) => artifactFirestoreRelative(ID, artifactFirestoreDoc(ID, p));
  const colPath = (p: unknown) => artifactFirestoreRelative(ID, artifactFirestoreCollection(ID, p));
  const rtdbSegs = (p: unknown) =>
    artifactRtdbPath(ID, p).slice(artifactPrefix.rtdb(ID).length).split('/').filter(Boolean);
  const filePath = (p: unknown) =>
    artifactStorageFile(ID, p).slice(artifactPrefix.storageFiles(ID).length);
  const idOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));

  const plain = (v: unknown, what: string): Json =>
    isPlain(v) ? v : fail('invalid-argument', `${what} must be an object`);
  const toDoc = (path: string): DriverDoc => {
    const data = state.fs[path];
    return { id: idOf(path), path, exists: !!data, data: data ? (copy(data) as Json) : null };
  };

  function list(col: string, query: ListQuery | undefined | null): DriverDoc[] {
    if (query != null && !isPlain(query)) fail('invalid-argument', 'A query must be an object');
    // The argument came from the artifact's own code: typed as a query, checked as unknown.
    const q: ListQuery = query ?? {};
    const where: [string, WhereOp, unknown][] = Array.isArray(q.where ?? [])
      ? (q.where ?? [])
      : fail('invalid-argument', 'where must be an array of [field, op, value]');
    for (const w of where as unknown[][]) {
      if (!Array.isArray(w) || typeof w[0] !== 'string' || !WHERE_OPS.includes(w[1] as WhereOp))
        fail('invalid-argument', 'where must be an array of [field, op, value]');
    }
    let rows = Object.keys(state.fs)
      .filter((p) => parentOf(p) === col)
      .filter((p) => where.every((w) => matches(state.fs[p]!, w)))
      .sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1));
    if (q.orderBy !== undefined) {
      if (!Array.isArray(q.orderBy) || typeof q.orderBy[0] !== 'string')
        fail('invalid-argument', "orderBy must be [field, 'asc' | 'desc']");
      const [name, dir] = q.orderBy;
      const sign = dir === 'desc' ? -1 : 1;
      // Firestore leaves out documents that do not have the ordered field.
      rows = rows
        .filter((p) => field(state.fs[p]!, name) !== undefined)
        .sort((a, b) => sign * compare(field(state.fs[a]!, name), field(state.fs[b]!, name)));
    }
    if (q.startAfter !== undefined) {
      if (typeof q.startAfter !== 'string')
        fail('invalid-argument', 'startAfter must be a document id');
      const at = rows.findIndex((p) => idOf(p) === q.startAfter);
      if (at >= 0) rows = rows.slice(at + 1);
      else if (q.orderBy === undefined) rows = rows.filter((p) => idOf(p) > q.startAfter!);
      else fail('not-found', `startAfter: no document '${q.startAfter}' in this collection`);
    }
    const limit: unknown = q.limit === undefined ? LIST_LIMIT_DEFAULT : q.limit;
    if (typeof limit !== 'number' || !(limit >= 1))
      return fail('invalid-argument', 'limit must be a positive number');
    return rows.slice(0, Math.min(Math.floor(limit), LIST_LIMIT_MAX)).map(toDoc);
  }

  // ── rtdb: one JSON tree ────────────────────────────────────────────────────
  const rtdbGet = (segs: string[]): unknown => {
    let cur = state.rtdb;
    for (const s of segs) {
      if (!isPlain(cur) && !Array.isArray(cur)) return null;
      cur = (cur as Json)[s];
    }
    return cur === undefined ? null : cur;
  };
  // RTDB has no empty objects and no nulls: both mean "not there".
  const prune = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(prune);
    if (!isPlain(v)) return v;
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) {
      const y = prune(x);
      if (y !== null && y !== undefined) out[k] = y;
    }
    return Object.keys(out).length ? out : null;
  };
  const rtdbSet = (segs: string[], value: unknown) => {
    if (!segs.length) {
      state.rtdb = prune(value);
      return;
    }
    const root: Json = isPlain(state.rtdb) ? state.rtdb : {};
    let cur = root;
    for (const s of segs.slice(0, -1)) {
      if (!isPlain(cur[s])) cur[s] = {};
      cur = cur[s] as Json;
    }
    cur[segs[segs.length - 1]!] = value;
    state.rtdb = prune(root);
  };
  // Dates do not exist in RTDB; the real broker stores them as milliseconds too.
  const rtdbValue = (v: unknown): unknown => {
    const c = copy(v, () => Date.now());
    const walk = (x: unknown): unknown =>
      x instanceof Date
        ? x.getTime()
        : Array.isArray(x)
          ? x.map(walk)
          : isPlain(x)
            ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]))
            : x;
    return walk(c);
  };
  let pushSeq = 0;
  const pushKey = () =>
    `-M${Date.now().toString(36).padStart(9, '0')}${(pushSeq++).toString(36).padStart(3, '0')}${autoId().slice(0, 6)}`;

  const now = () => new Date();

  async function run(op: DriverOp, a: Record<string, unknown>): Promise<unknown> {
    if (DRIVER_WRITE_OPS.has(op) && me.readOnly)
      fail('permission-denied', 'This artifact is read-only for viewers');
    switch (op) {
      case 'fs.get':
        return toDoc(docPath(a.path));
      case 'fs.set': {
        const path = docPath(a.path);
        const data = copy(plain(a.data, 'data'), now) as Json;
        state.fs[path] = a.merge && state.fs[path] ? merge(state.fs[path], data) : data;
        changed('fs', path);
        return { ok: true };
      }
      case 'fs.update': {
        const path = docPath(a.path);
        const cur = state.fs[path] ?? fail('not-found', `No document at ${path}`);
        for (const [k, v] of Object.entries(copy(plain(a.patch, 'patch'), now) as Json))
          setField(cur, k, v);
        changed('fs', path);
        return { ok: true };
      }
      case 'fs.delete': {
        const path = docPath(a.path);
        delete state.fs[path];
        changed('fs', path);
        return { ok: true };
      }
      case 'fs.add': {
        const path = `${colPath(a.path)}/${autoId()}`;
        state.fs[path] = copy(plain(a.data, 'data'), now) as Json;
        changed('fs', path);
        return { id: idOf(path), path };
      }
      case 'fs.list':
        return list(colPath(a.path), a.query as ListQuery | undefined);
      case 'rtdb.get':
        return copy(rtdbGet(rtdbSegs(a.path)));
      case 'rtdb.set': {
        const segs = rtdbSegs(a.path);
        rtdbSet(segs, rtdbValue(a.value));
        changed('rtdb', segs.join('/'));
        return { ok: true };
      }
      case 'rtdb.update': {
        const segs = rtdbSegs(a.path);
        for (const [k, v] of Object.entries(plain(a.patch, 'patch')))
          rtdbSet(rtdbSegs(`${segs.join('/')}/${k}`), rtdbValue(v));
        changed('rtdb', segs.join('/'));
        return { ok: true };
      }
      case 'rtdb.push': {
        const segs = [...rtdbSegs(a.path), pushKey()];
        rtdbSet(segs, rtdbValue(a.value));
        changed('rtdb', segs.join('/'));
        return { key: segs[segs.length - 1], path: `/${segs.join('/')}` };
      }
      case 'rtdb.remove': {
        const segs = rtdbSegs(a.path);
        rtdbSet(segs, null);
        changed('rtdb', segs.join('/'));
        return { ok: true };
      }
      case 'st.upload': {
        const path = filePath(a.path);
        const blob = a.blob as Blob | undefined;
        if (!blob || typeof blob !== 'object' || typeof blob.size !== 'number')
          fail('invalid-argument', 'upload needs a Blob or File');
        if (blob!.size > UPLOAD_MAX_BYTES) fail('quota', 'A file may be at most 25 MB');
        const old = files.get(path);
        if (old) revoke(old.url);
        files.set(path, {
          blob: blob!,
          url: objectUrl(blob!, path),
          size: blob!.size,
          contentType: (typeof a.contentType === 'string' && a.contentType) || blob!.type || null,
          updatedAt: Date.now(),
        });
        return { path, size: blob!.size };
      }
      case 'st.url': {
        const f = files.get(filePath(a.path)) ?? fail('not-found', `No file at ${String(a.path)}`);
        return { url: f.url, expiresAt: Date.now() + 3_600_000 };
      }
      case 'st.list': {
        const prefix = artifactStoragePrefix(ID, a.path ?? '').slice(
          artifactPrefix.storageFiles(ID).length,
        );
        return [...files.entries()]
          .filter(([p]) => p.startsWith(prefix))
          .sort(([x], [y]) => (x < y ? -1 : 1))
          .map(([path, f]) => ({
            path,
            size: f.size,
            contentType: f.contentType,
            updatedAt: f.updatedAt,
          }));
      }
      case 'st.delete': {
        const path = filePath(a.path);
        const f = files.get(path);
        if (f) revoke(f.url);
        files.delete(path);
        return { ok: true };
      }
      case 'kv.get': {
        artifactKvDoc(ID, me.uid, a.key);
        const v = state.kv[a.key as string];
        return v === undefined ? null : copy(v);
      }
      case 'kv.set': {
        artifactKvDoc(ID, me.uid, a.key);
        if (a.value === undefined)
          fail('invalid-argument', 'kv.set needs a value (use kv.delete to remove a key)');
        state.kv[a.key as string] = copy(a.value, now);
        save();
        return { ok: true };
      }
      case 'kv.delete': {
        artifactKvDoc(ID, me.uid, a.key);
        delete state.kv[a.key as string];
        save();
        return { ok: true };
      }
      // §K — the DEMO board (./mockTickets)
      case 'tk.boards':
        return [structuredClone(MOCK_BOARD)];
      case 'tk.list':
        mockBoard(a.board);
        return listTickets(state.tk, a.query as TicketQuery | undefined);
      case 'tk.get':
        return ticketByKey(state.tk, a.key);
      case 'tk.create': {
        mockBoard(a.board);
        const out = createTicket(state.tk, a.ticket as TicketInput);
        changed('tk');
        return out;
      }
      case 'tk.update':
        updateTicket(state.tk, a.key, a.patch as Partial<TicketInput>);
        changed('tk');
        return { ok: true };
      case 'tk.comment':
        commentTicket(state.tk, a.key, a.markdown);
        changed('tk');
        return { ok: true };
      // memory.html §H — the demo memory (./mockMemory)
      case 'mem.list':
        return [mockMemoryInfo(state.mem, me.readOnly)];
      case 'mem.tree':
        return memoryTree(state.mem, a.memory, a.path);
      case 'mem.read': {
        const [path, f] = memoryFile(state.mem, a.memory, a.path);
        const text = f.text ?? (await memBlobs.get(path)?.blob.text()) ?? '';
        return { text: text.slice(0, 1024 * 1024), truncated: text.length > 1024 * 1024 };
      }
      case 'mem.url': {
        const [path, f] = memoryFile(state.mem, a.memory, a.path);
        let entry = memBlobs.get(path);
        if (!entry) {
          const blob = new Blob([f.text ?? ''], { type: f.mime ?? 'text/plain' });
          entry = { blob, url: objectUrl(blob, `/memory/${path}`) };
          memBlobs.set(path, entry);
        }
        return { url: entry.url, expiresAt: Date.now() + 3_600_000 };
      }
      case 'mem.write': {
        const blob = a.blob as Blob | undefined;
        if (a.text === undefined && (!blob || typeof blob.size !== 'number'))
          fail('invalid-argument', 'write needs text or a Blob');
        const contentType = typeof a.contentType === 'string' ? a.contentType : null;
        const path = memoryWrite(
          state.mem,
          a.memory,
          a.path,
          typeof a.text === 'string'
            ? { text: a.text, mime: contentType }
            : { size: blob!.size, mime: contentType || blob!.type || null },
        );
        const old = memBlobs.get(path);
        if (old) revoke(old.url);
        memBlobs.delete(path);
        if (blob && a.text === undefined)
          memBlobs.set(path, { blob, url: objectUrl(blob, `/memory/${path}`) });
        save();
        return { path };
      }
      case 'mem.mkdir': {
        const path = memoryMkdir(state.mem, a.memory, a.path);
        save();
        return { path };
      }
      case 'mem.remove': {
        for (const p of memoryRemove(state.mem, a.memory, a.path)) {
          const b = memBlobs.get(p);
          if (b) revoke(b.url);
          memBlobs.delete(p);
        }
        save();
        return { ok: true };
      }
      default:
        return fail('invalid-argument', `Unknown operation ${String(op)}`);
    }
  }

  const transport: Transport = {
    async request<O extends DriverOp>(op: O, args: DriverArgs<O>): Promise<DriverResult<O>> {
      try {
        return (await run(op, (args ?? {}) as Record<string, unknown>)) as DriverResult<O>;
      } catch (e) {
        // ArtifactPathError carries code 'invalid-argument'; keep it.
        throw toDriverError(e);
      }
    },
    subscribe<O extends SubOp>(
      op: O,
      args: DriverArgs<O>,
      onValue: (value: unknown) => void,
      onError: (error: DriverError) => void,
    ) {
      const a = args as { path: unknown; query?: ListQuery };
      let listener: Listener;
      try {
        if (op === 'fs.onDoc') {
          const path = docPath(a.path);
          listener = {
            touches: (k, p) => k === 'fs' && p === path,
            fire: () => onValue(toDoc(path)),
          };
        } else if (op === 'fs.onList') {
          const col = colPath(a.path);
          list(col, a.query); // a bad query is refused now, not on the first write
          listener = {
            touches: (k, p) => k === 'fs' && parentOf(p) === col,
            fire: () => onValue(list(col, a.query)),
          };
        } else if (op === 'tk.onList') {
          const t = args as { board: unknown; query?: TicketQuery };
          mockBoard(t.board);
          listTickets(state.tk, t.query); // a bad query is refused now
          listener = {
            touches: (k) => k === 'tk',
            fire: () => onValue(listTickets(state.tk, t.query)),
          };
        } else {
          const segs = rtdbSegs(a.path);
          const at = segs.join('/');
          // A write above OR below this node changes what it holds.
          const overlaps = (p: string) =>
            !at || !p || p === at || p.startsWith(`${at}/`) || at.startsWith(`${p}/`);
          listener = {
            touches: (k, p) => k === 'rtdb' && overlaps(p),
            fire: () => onValue(copy(rtdbGet(segs))),
          };
        }
      } catch (e) {
        void Promise.resolve().then(() => onError(toDriverError(e)));
        return () => {};
      }
      listeners.add(listener);
      void Promise.resolve().then(() => listeners.has(listener) && listener.fire());
      return () => void listeners.delete(listener);
    },
  };

  return {
    transport,
    me,
    artifact: { id: ID, name: 'Mock artifact', buildId: 'mock' },
    mock: true,
  };
}

function objectUrl(blob: Blob, path: string): string {
  try {
    return URL.createObjectURL(blob);
  } catch {
    // No object URLs here (a test, an old runtime): still a unique, stable string.
    return `blob:mock${path}`;
  }
}
function revoke(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* nothing to release */
  }
}
