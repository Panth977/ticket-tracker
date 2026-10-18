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

export function httpDrive(token: () => Promise<string>): DriveApi {
  async function call(url: string, init: RequestInit = {}, what = 'request'): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${await token()}`, ...(init.headers ?? {}) },
    });
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
    for (let at = 0; at < source.size; at += CHUNK) {
      const end = Math.min(source.size, at + CHUNK);
      const body = await source.read(at, end);
      const r = await fetch(session, {
        method: 'PUT',
        headers: { 'content-range': `bytes ${at}-${end - 1}/${source.size}` },
        // A copy on its own ArrayBuffer: what fetch's BodyInit accepts in every lib.
        body: body.slice(),
      });
      if (r.status === 308) continue;
      if (!r.ok) await fail(r, 'upload');
      return toItem((await r.json()) as RawFile);
    }
    throw errors.unavailable('Google Drive did not finish the upload');
  }

  return {
    async get(id) {
      const res = await fetch(`${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}`, {
        headers: { authorization: `Bearer ${await token()}` },
      });
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

/** Every fake Drive in this process, by account (the connected person's uid). */
const fakes = new Map<string, Map<string, FakeFile>>();

/** Tests: forget every fake Drive. */
export const resetFakeDrives = (): void => fakes.clear();

let fakeSeq = 0;
const fakeId = () => `fake${Date.now().toString(36)}${(fakeSeq++).toString(36).padStart(4, '0')}x`;

export function fakeDrive(account: string): DriveApi {
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
  };
}

/** Tests and dev: put a file straight into a fake Drive, as if made in Drive's own UI. */
export function fakeDriveTouch(account: string, id: string, patch: Partial<DriveItem>): void {
  const f = fakes.get(account)?.get(id);
  if (f) Object.assign(f, patch);
}
