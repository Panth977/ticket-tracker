/**
 * GOOGLE DRIVE, the few calls a Drive bucket needs (docs/plan/bucket.html §K),
 * behind one small interface with two implementations:
 *
 *   httpDrive(token)   Drive API v3 over fetch, with a bearer token from
 *                      link.ts (no googleapis dependency: a dozen requests).
 *   fakeDrive(account) an in-memory Drive per account, for the emulators,
 *                      tests and a dev server without a Google OAuth client.
 *
 * Everything above this file speaks DriveItem; nothing above it knows which.
 *
 * Bytes go up through a RESUMABLE upload in chunks read from a ByteSource
 * (a 1 GB file never sits in memory), and come down as a stream, optionally
 * one byte range.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { DRIVE_FOLDER_MIME, errors } from '@tm/shared';

export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  /** Drive gives exactly one parent to anything the app creates. */
  parents: string[];
  size: number;
  createdTime: number;
  modifiedTime: number;
  /** The current version (absent for folders). */
  headRevisionId: string | null;
  trashed: boolean;
  /** Private to this app: who made / last changed it in TaskManager. */
  appProperties: Record<string, string>;
  width?: number | undefined;
  height?: number | undefined;
}

export const isFolder = (f: Pick<DriveItem, 'mimeType'>): boolean =>
  f.mimeType === DRIVE_FOLDER_MIME;

/** Bytes to upload, read a chunk at a time (`end` exclusive). */
export interface ByteSource {
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

export const bytesSource = (b: Uint8Array): ByteSource => ({
  size: b.byteLength,
  read: async (s, e) => b.subarray(s, e),
});

export interface DriveApi {
  /** One item (trashed ones too: `trashed` says so); null when there is none or it is not ours. */
  get(id: string): Promise<DriveItem | null>;
  /** The untrashed children of these folders. */
  children(parentIds: readonly string[]): Promise<DriveItem[]>;
  createFolder(
    parentId: string | null,
    name: string,
    props?: Record<string, string>,
  ): Promise<DriveItem>;
  /** A NEW file (with `id` from generateIds when given). */
  create(opts: {
    id?: string | undefined;
    parentId: string;
    name: string;
    mime: string;
    source: ByteSource;
    props?: Record<string, string>;
  }): Promise<DriveItem>;
  /** A new version of an existing file. */
  replace(
    id: string,
    mime: string,
    source: ByteSource,
    props?: Record<string, string>,
  ): Promise<DriveItem>;
  /**
   * A SMALL file (a JSON document, src/db/drive) in ONE request: a new file in
   * `parentId` named `name` (id from generateIds when given), or a new version
   * of `fileId`.
   */
  putSmall(opts: {
    fileId?: string | undefined;
    create?: { id?: string | undefined; parentId: string; name: string } | undefined;
    mime: string;
    bytes: Uint8Array;
    props?: Record<string, string> | undefined;
  }): Promise<DriveItem>;
  /** Rename and/or move (one parent in, one out). */
  update(
    id: string,
    patch: {
      name?: string;
      addParent?: string;
      removeParent?: string;
      props?: Record<string, string>;
    },
  ): Promise<DriveItem>;
  /** To Drive's trash (a folder takes its contents along); restorable there for 30 days. */
  trash(id: string): Promise<void>;
  download(id: string, range?: { start: number; end: number }): Promise<Readable>;
  /** File ids reserved for create(), so a reference can be written before the bytes. */
  generateIds(count: number): Promise<string[]>;
  /** Untrashed items carrying this private appProperty (§K6: a node moved from managed). */
  findByProp(key: string, value: string): Promise<DriveItem[]>;
  /**
   * Open a resumable upload the BROWSER finishes (§K4): a new file (`id`
   * reserved, in `parentId`, named `name`) or a new version of `replaceId`.
   * Answers the session URL; one PUT of the whole body completes it. `origin`
   * is the app's origin, so Drive answers the browser's PUT with CORS headers.
   */
  openUpload(opts: {
    create?: { id: string; parentId: string; name: string };
    replaceId?: string;
    mime: string;
    size: number;
    props?: Record<string, string>;
    origin?: string | undefined;
  }): Promise<string>;
}

// ─── Drive API v3 ────────────────────────────────────────────────────────────

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FIELDS =
  'id,name,mimeType,parents,size,createdTime,modifiedTime,headRevisionId,trashed,appProperties,imageMediaMetadata(width,height)';
/** A resumable upload's chunk: a multiple of 256 KiB, as Drive requires. */
const CHUNK = 32 * 256 * 1024;
/** Parents per children() query (q has a length limit). */
const PARENTS_PER_QUERY = 30;

interface RawFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  headRevisionId?: string;
  trashed?: boolean;
  appProperties?: Record<string, string>;
  imageMediaMetadata?: { width?: number; height?: number };
}

const toItem = (f: RawFile): DriveItem => ({
  id: f.id,
  name: f.name,
  mimeType: f.mimeType,
  parents: f.parents ?? [],
  size: Number(f.size ?? 0),
  createdTime: Date.parse(f.createdTime ?? '') || 0,
  modifiedTime: Date.parse(f.modifiedTime ?? '') || 0,
  headRevisionId: f.headRevisionId ?? null,
  trashed: !!f.trashed,
  appProperties: f.appProperties ?? {},
  width: f.imageMediaMetadata?.width,
  height: f.imageMediaMetadata?.height,
});

/** A q-string literal: Drive escapes ' and \ with a backslash. */
const lit = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Drive's answer → our error. 401/403 with an auth reason → the connection is gone. */
async function fail(res: Response, what: string): Promise<never> {
  let reason = '';
  try {
    const j = (await res.json()) as {
      error?: { message?: string; errors?: { reason?: string }[] };
    };
    reason = j.error?.errors?.[0]?.reason ?? j.error?.message ?? '';
  } catch {
    /* not JSON */
  }
  if (res.status === 401) throw new DriveAuthError(`Google Drive refused the connection (${what})`);
  if (res.status === 404) throw errors.not_found('Not found in Google Drive');
  if (res.status === 403 && /storageQuota|quotaExceeded/i.test(reason))
    throw errors.conflict('That Google Drive is full');
  if (res.status === 403 || res.status === 429)
    throw errors.unavailable(`Google Drive said no (${what}: ${reason || res.status}) — try again`);
  throw errors.unavailable(`Google Drive failed (${what}: ${res.status} ${reason})`);
}

/** A 401 from Drive: link.ts marks the connection as needing a reconnect. */
export class DriveAuthError extends Error {}

/**
 * Google answers a long run of calls with the odd dropped connection
 * (ECONNRESET, undici's "terminated") or a 429 / 5xx; a storage move of a
 * thousand files met one and stopped (ORCH-14). Retried with backoff.
 */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_TRIES = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) => Math.min(16_000, 500 * 2 ** attempt) + Math.random() * 250;

/** A network failure (not an HTTP answer): worth another try. */
export function isTransient(e: unknown): boolean {
  const err = e as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  const code = err?.cause?.code ?? err?.code ?? '';
  return (
    err?.name === 'TypeError' ||
    /terminated|fetch failed|socket hang up|other side closed/i.test(err?.message ?? '') ||
    /ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|EAI_AGAIN|UND_ERR/.test(code)
  );
}

/** fetch, again on a dropped connection or a 429 / 5xx (the last answer is returned). */
export async function fetchRetrying(
  url: string,
  init: () => Promise<RequestInit> | RequestInit,
  tries = MAX_TRIES,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, await init());
      if (!RETRY_STATUS.has(res.status) || attempt >= tries - 1) return res;
      await res.body?.cancel().catch(() => {});
    } catch (e) {
      if (!isTransient(e) || attempt >= tries - 1) throw e;
    }
    await sleep(backoff(attempt));
  }
}

export function httpDrive(token: () => Promise<string>): DriveApi {
  async function call(url: string, init: RequestInit = {}, what = 'request'): Promise<Response> {
    const res = await fetchRetrying(url, async () => ({
      ...init,
      headers: { authorization: `Bearer ${await token()}`, ...(init.headers ?? {}) },
    }));
    if (!res.ok && res.status !== 308) await fail(res, what);
    return res;
  }
  const json = async <T>(url: string, init: RequestInit = {}, what?: string): Promise<T> =>
    (await (await call(url, init, what)).json()) as T;

  async function resumable(
    method: 'POST' | 'PATCH',
    url: string,
    meta: Record<string, unknown>,
    mime: string,
    source: ByteSource,
  ): Promise<DriveItem> {
    const start = await call(
      url,
      {
        method,
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': mime,
          'x-upload-content-length': String(source.size),
        },
        body: JSON.stringify(meta),
      },
      'upload',
    );
    const session = start.headers.get('location');
    if (!session) throw errors.unavailable('Google Drive did not open an upload');
    if (source.size === 0) {
      const r = await fetch(session, { method: 'PUT', headers: { 'content-length': '0' } });
      if (!r.ok) await fail(r, 'upload');
      return toItem((await r.json()) as RawFile);
    }
    // Where the session stands after a dropped chunk: Drive says how much it has.
    const ask = async (): Promise<number | DriveItem> => {
      const r = await fetchRetrying(session, () => ({
        method: 'PUT',
        headers: { 'content-range': `bytes */${source.size}` },
      }));
      if (r.ok) return toItem((await r.json()) as RawFile);
      if (r.status !== 308) await fail(r, 'upload');
      const range = r.headers.get('range');
      return range ? Number(range.split('-')[1]) + 1 : 0;
    };
    let at = 0;
    for (let misses = 0; at < source.size;) {
      const end = Math.min(source.size, at + CHUNK);
      const body = await source.read(at, end);
      let r: Response | null = null;
      try {
        r = await fetch(session, {
          method: 'PUT',
          headers: { 'content-range': `bytes ${at}-${end - 1}/${source.size}` },
          // A copy on its own ArrayBuffer: what fetch's BodyInit accepts in every lib.
          body: body.slice(),
        });
      } catch (e) {
        if (!isTransient(e)) throw e;
      }
      if (r && r.status === 308) {
        const range = r.headers.get('range');
        at = range ? Number(range.split('-')[1]) + 1 : end;
        misses = 0;
        continue;
      }
      if (r && r.ok) return toItem((await r.json()) as RawFile);
      if (r && !RETRY_STATUS.has(r.status)) await fail(r, 'upload');
      // Dropped or a 5xx: resume from what Drive has.
      if (++misses >= MAX_TRIES) throw errors.unavailable('Google Drive kept dropping the upload');
      await sleep(backoff(misses));
      const now = await ask();
      if (typeof now !== 'number') return now;
      at = now;
    }
    throw errors.unavailable('Google Drive did not finish the upload');
  }

  return {
    async get(id) {
      const res = await fetchRetrying(
        `${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}`,
        async () => ({
          headers: { authorization: `Bearer ${await token()}` },
        }),
      );
      if (res.status === 404) return null;
      if (!res.ok) await fail(res, 'read');
      return toItem((await res.json()) as RawFile);
    },
    async children(parentIds) {
      const out: DriveItem[] = [];
      for (let i = 0; i < parentIds.length; i += PARENTS_PER_QUERY) {
        const ids = parentIds.slice(i, i + PARENTS_PER_QUERY);
        const q = `(${ids.map((p) => `${lit(p)} in parents`).join(' or ')}) and trashed = false`;
        let page: string | undefined;
        do {
          const u = new URL(`${API}/files`);
          u.searchParams.set('q', q);
          u.searchParams.set('pageSize', '1000');
          u.searchParams.set('spaces', 'drive');
          u.searchParams.set('fields', `nextPageToken,files(${FIELDS})`);
          if (page) u.searchParams.set('pageToken', page);
          const r = await json<{ files?: RawFile[]; nextPageToken?: string }>(
            u.toString(),
            {},
            'list',
          );
          for (const f of r.files ?? []) out.push(toItem(f));
          page = r.nextPageToken;
        } while (page);
      }
      return out;
    },
    async createFolder(parentId, name, props) {
      const f = await json<RawFile>(
        `${API}/files?fields=${FIELDS}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name,
            mimeType: DRIVE_FOLDER_MIME,
            ...(parentId ? { parents: [parentId] } : {}),
            ...(props ? { appProperties: props } : {}),
          }),
        },
        'create folder',
      );
      return toItem(f);
    },
    create({ id, parentId, name, mime, source, props }) {
      return resumable(
        'POST',
        `${UPLOAD}/files?uploadType=resumable&fields=${FIELDS}`,
        {
          ...(id ? { id } : {}),
          name,
          mimeType: mime,
          parents: [parentId],
          ...(props ? { appProperties: props } : {}),
        },
        mime,
        source,
      );
    },
    replace(id, mime, source, props) {
      return resumable(
        'PATCH',
        `${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=resumable&fields=${FIELDS}`,
        { mimeType: mime, ...(props ? { appProperties: props } : {}) },
        mime,
        source,
      );
    },
    async putSmall({ fileId, create, mime, bytes, props }) {
      const boundary = `tm${Math.random().toString(36).slice(2)}`;
      const meta = create
        ? {
            ...(create.id ? { id: create.id } : {}),
            name: create.name,
            mimeType: mime,
            parents: [create.parentId],
          }
        : { mimeType: mime };
      const head = Buffer.from(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
          JSON.stringify({ ...meta, ...(props ? { appProperties: props } : {}) }) +
          `\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`,
      );
      const body = Buffer.concat([head, Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--`)]);
      const url = create
        ? `${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`
        : `${UPLOAD}/files/${encodeURIComponent(fileId!)}?uploadType=multipart&fields=${FIELDS}`;
      const f = await json<RawFile>(
        url,
        {
          method: create ? 'POST' : 'PATCH',
          headers: { 'content-type': `multipart/related; boundary=${boundary}` },
          body,
        },
        'write',
      );
      return toItem(f);
    },
    async update(id, patch) {
      const u = new URL(`${API}/files/${encodeURIComponent(id)}`);
      u.searchParams.set('fields', FIELDS);
      if (patch.addParent) u.searchParams.set('addParents', patch.addParent);
      if (patch.removeParent) u.searchParams.set('removeParents', patch.removeParent);
      const f = await json<RawFile>(
        u.toString(),
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.props ? { appProperties: patch.props } : {}),
          }),
        },
        'move',
      );
      return toItem(f);
    },
    async trash(id) {
      await call(
        `${API}/files/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ trashed: true }),
        },
        'delete',
      );
    },
    async download(id, range) {
      const res = await call(
        `${API}/files/${encodeURIComponent(id)}?alt=media`,
        range ? { headers: { range: `bytes=${range.start}-${range.end}` } } : {},
        'download',
      );
      if (!res.body) return Readable.from([]);
      return Readable.fromWeb(res.body as NodeReadableStream);
    },
    async openUpload({ create, replaceId, mime, size, props, origin }) {
      const url = create
        ? `${UPLOAD}/files?uploadType=resumable&fields=${FIELDS}`
        : `${UPLOAD}/files/${encodeURIComponent(replaceId!)}?uploadType=resumable&fields=${FIELDS}`;
      const meta = create
        ? { id: create.id, name: create.name, mimeType: mime, parents: [create.parentId] }
        : { mimeType: mime };
      const res = await call(
        url,
        {
          method: create ? 'POST' : 'PATCH',
          headers: {
            'content-type': 'application/json; charset=UTF-8',
            'x-upload-content-type': mime,
            'x-upload-content-length': String(size),
            ...(origin ? { origin } : {}),
          },
          body: JSON.stringify({ ...meta, ...(props ? { appProperties: props } : {}) }),
        },
        'upload',
      );
      const session = res.headers.get('location');
      if (!session) throw errors.unavailable('Google Drive did not open an upload');
      return session;
    },
    async findByProp(key, value) {
      const u = new URL(`${API}/files`);
      u.searchParams.set(
        'q',
        `appProperties has { key=${lit(key)} and value=${lit(value)} } and trashed = false`,
      );
      u.searchParams.set('spaces', 'drive');
      u.searchParams.set('pageSize', '1000');
      u.searchParams.set('fields', `nextPageToken,files(${FIELDS})`);
      const out: DriveItem[] = [];
      let page: string | undefined;
      do {
        if (page) u.searchParams.set('pageToken', page);
        const r = await json<{ files?: RawFile[]; nextPageToken?: string }>(
          u.toString(),
          {},
          'find',
        );
        for (const f of r.files ?? []) out.push(toItem(f));
        page = r.nextPageToken;
      } while (page);
      return out;
    },
    async generateIds(count) {
      const r = await json<{ ids: string[] }>(
        `${API}/files/generateIds?count=${count}&space=drive&type=files`,
        {},
        'reserve ids',
      );
      return r.ids;
    },
  };
}

// ─── the fake ────────────────────────────────────────────────────────────────

interface FakeFile extends DriveItem {
  bytes: Uint8Array;
  version: number;
}

/**
 * Every fake Drive, by account (the connected person's uid) — kept ON DISK
 * (TM_FAKE_DRIVE_DIR, default a temp folder) as well as here: under the
 * Functions emulator the api and the queue run in different processes, and a
 * queued job (a storage move, §K6) must see the same Drive the api wrote.
 */
const fakes = new Map<string, Map<string, FakeFile>>();
const fakeDir = () => process.env.TM_FAKE_DRIVE_DIR || join(tmpdir(), 'tm-fake-drive');
const fakeFile = (account: string) => join(fakeDir(), `${account.replace(/[^\w-]/g, '_')}.json`);

type FakeRow = Omit<FakeFile, 'bytes'> & { bytes: string };
function fakeLoad(account: string, into: Map<string, FakeFile>): void {
  let rows: FakeRow[];
  try {
    rows = JSON.parse(readFileSync(fakeFile(account), 'utf8')) as FakeRow[];
  } catch {
    return; // nothing on disk yet: keep what is in memory
  }
  into.clear();
  for (const r of rows)
    into.set(r.id, { ...r, bytes: new Uint8Array(Buffer.from(r.bytes, 'base64')) });
}
function fakeSave(account: string, from: Map<string, FakeFile>): void {
  mkdirSync(fakeDir(), { recursive: true });
  const rows: FakeRow[] = [...from.values()].map((f) => ({
    ...f,
    bytes: Buffer.from(f.bytes).toString('base64'),
  }));
  writeFileSync(fakeFile(account), JSON.stringify(rows));
}

/** Tests: forget every fake Drive. */
export const resetFakeDrives = (): void => {
  fakes.clear();
  rmSync(fakeDir(), { recursive: true, force: true });
};

let fakeSeq = 0;
const fakeId = () => `fake${Date.now().toString(36)}${(fakeSeq++).toString(36).padStart(4, '0')}x`;

const fakeQueues = new Map<string, Promise<unknown>>();

export function fakeDrive(account: string): DriveApi {
  const api = fakeDriveIn(account);
  const files = fakes.get(account)!;
  // Every call sees what any process wrote, and writes back what it changed.
  const synced = {} as DriveApi;
  for (const [name, fn] of Object.entries(api) as [
    keyof DriveApi,
    (...a: unknown[]) => Promise<unknown>,
  ][])
    (synced as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      // One call at a time per account: a load between another call's change
      // and its save would drop that change (callers run Drive calls in parallel).
      const run = async () => {
        fakeLoad(account, files);
        const out = await fn.apply(api, args);
        fakeSave(account, files);
        return out;
      };
      const next = (fakeQueues.get(account) ?? Promise.resolve()).then(run, run);
      fakeQueues.set(
        account,
        next.catch(() => undefined),
      );
      return next;
    };
  return synced;
}

function fakeDriveIn(account: string): DriveApi {
  let files = fakes.get(account);
  if (!files) fakes.set(account, (files = new Map()));
  const store = files;
  const now = () => Date.now();
  const pub = (f: FakeFile): DriveItem => {
    const { bytes: _b, version: _v, ...rest } = f;
    return { ...rest, parents: [...rest.parents], appProperties: { ...rest.appProperties } };
  };
  const must = (id: string): FakeFile => {
    const f = store.get(id);
    if (!f) throw errors.not_found('Not found in Google Drive');
    return f;
  };
  const trashedUp = (f: FakeFile): boolean => {
    for (let x: FakeFile | undefined = f; x; x = x.parents[0] ? store.get(x.parents[0]) : undefined)
      if (x.trashed) return true;
    return false;
  };
  async function readAll(source: ByteSource): Promise<Uint8Array> {
    return source.size ? source.read(0, source.size) : new Uint8Array();
  }
  return {
    async get(id) {
      const f = store.get(id);
      return f ? { ...pub(f), trashed: trashedUp(f) } : null;
    },
    async children(parentIds) {
      const set = new Set(parentIds);
      return [...store.values()]
        .filter((f) => !trashedUp(f) && f.parents.some((p) => set.has(p)))
        .map(pub);
    },
    async createFolder(parentId, name, props) {
      if (parentId) must(parentId);
      const f: FakeFile = {
        id: fakeId(),
        name,
        mimeType: DRIVE_FOLDER_MIME,
        parents: parentId ? [parentId] : ['root'],
        size: 0,
        createdTime: now(),
        modifiedTime: now(),
        headRevisionId: null,
        trashed: false,
        appProperties: { ...(props ?? {}) },
        bytes: new Uint8Array(),
        version: 1,
      };
      store.set(f.id, f);
      return pub(f);
    },
    async create({ id, parentId, name, mime, source, props }) {
      must(parentId);
      const bytes = new Uint8Array(await readAll(source));
      const fid = id ?? fakeId();
      if (store.has(fid)) throw errors.conflict('That Drive id is taken');
      const f: FakeFile = {
        id: fid,
        name,
        mimeType: mime,
        parents: [parentId],
        size: bytes.byteLength,
        createdTime: now(),
        modifiedTime: now(),
        headRevisionId: `rev${fid.slice(-6)}0001`,
        trashed: false,
        appProperties: { ...(props ?? {}) },
        bytes,
        version: 1,
      };
      store.set(f.id, f);
      return pub(f);
    },
    async replace(id, mime, source, props) {
      const f = must(id);
      f.bytes = new Uint8Array(await readAll(source));
      f.size = f.bytes.byteLength;
      f.mimeType = mime;
      f.version += 1;
      f.headRevisionId = `rev${id.slice(-6)}${String(f.version).padStart(4, '0')}`;
      f.modifiedTime = now();
      if (props) f.appProperties = { ...f.appProperties, ...props };
      return pub(f);
    },
    async putSmall({ fileId, create, mime, bytes, props }) {
      return create
        ? this.create({ ...create, mime, source: bytesSource(bytes), props })
        : this.replace(fileId!, mime, bytesSource(bytes), props);
    },
    async update(id, patch) {
      const f = must(id);
      if (patch.name !== undefined) f.name = patch.name;
      if (patch.addParent) {
        must(patch.addParent);
        f.parents = [...f.parents.filter((p) => p !== patch.removeParent), patch.addParent];
      } else if (patch.removeParent) f.parents = f.parents.filter((p) => p !== patch.removeParent);
      if (patch.props) f.appProperties = { ...f.appProperties, ...patch.props };
      f.modifiedTime = now();
      return pub(f);
    },
    async trash(id) {
      must(id).trashed = true;
    },
    async download(id, range) {
      const f = must(id);
      const b = range ? f.bytes.subarray(range.start, range.end + 1) : f.bytes;
      return Readable.from([Buffer.from(b)]);
    },
    async generateIds(count) {
      return Array.from({ length: count }, fakeId);
    },
    async findByProp(key, value) {
      return [...store.values()]
        .filter((f) => !trashedUp(f) && f.appProperties[key] === value)
        .map(pub);
    },
    async openUpload({ create, replaceId, mime, size, props }) {
      if (create) must(create.parentId);
      else must(replaceId!);
      const token = `fu${fakeId()}`;
      fakeSessions.set(token, { account, create, replaceId, mime, size, props });
      return `/integrations/drive/fake-upload/${token}`;
    },
  };
}

interface FakeSession {
  account: string;
  create?: { id: string; parentId: string; name: string } | undefined;
  replaceId?: string | undefined;
  mime: string;
  size: number;
  props?: Record<string, string> | undefined;
}
/** Open fake upload sessions: the dev door (doors/drive.ts) completes them. */
const fakeSessions = new Map<string, FakeSession>();

/** The fake Drive's answer to the browser's PUT of a session's bytes. */
export async function completeFakeUpload(token: string, bytes: Uint8Array): Promise<DriveItem> {
  const s = fakeSessions.get(token);
  if (!s) throw errors.not_found('No such upload');
  fakeSessions.delete(token);
  if (bytes.byteLength !== s.size) throw errors.invalid('The upload is not the announced size');
  const d = fakeDrive(s.account);
  return s.create
    ? d.create({ ...s.create, mime: s.mime, source: bytesSource(bytes), props: s.props ?? {} })
    : d.replace(s.replaceId!, s.mime, bytesSource(bytes), s.props);
}

/** Tests and dev: put a file straight into a fake Drive, as if made in Drive's own UI. */
export function fakeDriveTouch(account: string, id: string, patch: Partial<DriveItem>): void {
  let files = fakes.get(account);
  if (!files) fakes.set(account, (files = new Map()));
  fakeLoad(account, files);
  const f = files.get(id);
  if (f) Object.assign(f, patch);
  fakeSave(account, files);
}
