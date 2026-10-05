/**
 * THE ARTIFACT'S DATA, FROM OUTSIDE THE PAGE (docs/plan/agents.html §AA4).
 *
 *   const data = tm.artifacts.data(id);
 *   await data.firestore.set('scores/2026', { total: 42, at: serverTime });
 *   const { data: rows } = await data.firestore.list('scores', { where: [['total', '>', 10]] });
 *
 * Until §AA an artifact's database could only be written from inside the
 * page, by whoever was looking at it (the driver). This is the same fence
 * reached with a TOKEN: an agent token whose agent has `data` on the artifact
 * ('read' for the reads, 'write' for everything else), or an account token
 * whose person is owner or editor. The page and this API see THE SAME
 * documents — what a job writes here, the open page reads live through its
 * driver.
 *
 * VALUES ARE JSON, WITH TWO ESCAPES the wire spells as single-key objects:
 *
 *   { "$date": ISO }         a timestamp, both ways. Here you write a JS
 *                            `Date` and read one back (pass `{ raw: true }` to
 *                            `data()` to get the JSON exactly as it was sent).
 *   { "$serverTime": true }  in a write only: the server's clock. Here it is
 *                            the `serverTime` sentinel.
 *
 * shared/artifacts/data.ts is the server's side of this; test/data.test.ts
 * round-trips values through BOTH, so the two cannot drift.
 */
import { TmError } from './errors.js';
import type { Http, QueryParam, RequestOptions } from './http.js';
import type { Iso } from './types.js';

// ───────────────────────── values ─────────────────────────

/** `{ "$serverTime": true }` — the type of the `serverTime` sentinel. */
export interface ServerTimeSentinel {
  readonly $serverTime: true;
}

/**
 * The server's clock, for a write: `{ updatedAt: serverTime }`. In Firestore
 * it is stored as a timestamp (and read back as a `Date`); in the RTDB as
 * epoch milliseconds. Not allowed inside an array.
 *
 * It IS the wire escape, frozen — so it survives a JSON round trip or a
 * structured clone and still means the same thing.
 */
export const serverTime: ServerTimeSentinel = Object.freeze({ $serverTime: true as const });

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

/**
 * A JS value → the JSON the data API takes: every `Date` becomes
 * `{ "$date": ISO }`; maps and arrays are walked; everything else (the
 * `serverTime` sentinel included) goes as it is. An invalid Date is refused
 * here rather than sent as `null`.
 */
export function encodeDataValue(value: unknown): unknown {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      throw new TypeError('artifacts.data: an invalid Date cannot be written');
    return { $date: value.toISOString() };
  }
  if (Array.isArray(value)) return value.map(encodeDataValue);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = encodeDataValue(v);
  return out;
}

/**
 * The JSON the data API answers → JS values: every `{ "$date": ISO }` (an
 * object with exactly that one key) becomes a `Date`. The inverse of
 * `encodeDataValue` for everything the server can send back.
 */
export function decodeDataValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeDataValue);
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$date' && typeof value.$date === 'string') {
    const at = new Date(value.$date);
    // An unreadable stamp is left as the JSON it was: better than an Invalid Date.
    return Number.isNaN(at.getTime()) ? value : at;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = decodeDataValue(v);
  return out;
}

// ───────────────────────── shapes ─────────────────────────

export type ArtifactDataWhereOp =
  '<' | '<=' | '==' | '!=' | '>=' | '>' | 'array-contains' | 'in' | 'not-in' | 'array-contains-any';

/** `[field, op, value]` — exactly the driver's `where` item. A `Date` value is a timestamp. */
export type ArtifactDataWhere = readonly [field: string, op: ArtifactDataWhereOp, value: unknown];

/** A document as the API answers it. `path` is in the artifact's own view ('/scores/2026'). */
export interface ArtifactDataDoc<T = Record<string, unknown>> {
  id: string;
  path: string;
  /** A missing document is `exists: false` with `data: null` — not an error. */
  exists: boolean;
  data: T | null;
}

export interface ArtifactDataListQuery {
  /** At most 10 filters. */
  where?: readonly ArtifactDataWhere[] | undefined;
  /** `'field'` (ascending) or `['field', 'desc']`. */
  orderBy?: string | readonly [field: string, direction?: 'asc' | 'desc'] | undefined;
  /** Default 100, at most 500. */
  limit?: number | undefined;
  /** A document id in this collection: the previous page's `nextCursor`. */
  startAfter?: string | undefined;
}

/** One page of a collection. `nextCursor` goes back in as `startAfter`; null at the end. */
export interface ArtifactDataPage<T = Record<string, unknown>> {
  data: ArtifactDataDoc<T>[];
  nextCursor: string | null;
}

/** One write of a `batch`. `path` is a DOCUMENT path in the artifact's own view. */
export type ArtifactDataWrite =
  | { op: 'set'; path: string; data: Record<string, unknown>; merge?: boolean }
  /** Keys may be dotted field paths ('stats.count'). The document must exist. */
  | { op: 'update'; path: string; data: Record<string, unknown> }
  | { op: 'delete'; path: string };

export interface ArtifactDataWriteResult {
  ok: true;
  id: string;
  path: string;
}

/** One of the artifact's files (paths in its own view). */
export interface ArtifactDataFile {
  path: string;
  size: number;
  content_type: string | null;
  updated_at: Iso | null;
}

/** `files.url()`: a short-lived link — GET it with a plain fetch, no Authorization header. */
export interface ArtifactDataFileUrl {
  url: string;
  expires_at: Iso;
}

export interface ArtifactDataOptions {
  /**
   * Leave the JSON as the server sent it: timestamps stay
   * `{ "$date": ISO }` instead of becoming `Date`. Writes are unaffected (a
   * `Date` you pass is still sent as `$date`).
   */
  raw?: boolean | undefined;
}

/**
 * The server's limits, repeated here so a call that must fail is refused
 * BEFORE megabytes are sent. test/data.test.ts compares each with the
 * constant the server enforces, so they cannot drift.
 */
export const ARTIFACT_DATA_LIMITS = {
  /** Writes in one `batch` — all or nothing. */
  batchWrites: 400,
  /** `limit` of one `list` page (default 100). */
  listLimit: 500,
  /** Filters in one `list`. */
  whereFilters: 10,
  /** One file through `files.upload`. */
  uploadBytes: 25 * 1024 * 1024,
} as const;

/** A collection cannot have one of these names (they are TaskManager's own): refused by the server, as in the driver. */
export const ARTIFACT_RESERVED_COLLECTIONS: readonly string[] = ['tickets', 'reads'];

/** An upload is megabytes; the 30 s default would cut a slow link off mid-body. */
const UPLOAD_TIMEOUT_MS = 180_000;

// ───────────────────────── paths and queries ─────────────────────────

/**
 * '/scores/2026', 'scores/2026', 'scores//2026/' → 'scores/2026', each segment
 * percent-encoded on its own (the server decodes the whole rest of the URL and
 * hands it to the fence). '.' and '..' are refused HERE: a URL parser would
 * fold them away and the request would land on a different route.
 */
export function dataPath(path: string, what = 'path'): string {
  if (typeof path !== 'string') throw new TypeError(`artifacts.data: ${what} must be a string`);
  const segs = path.split('/').filter((s) => s.length > 0);
  for (const s of segs)
    if (s === '.' || s === '..')
      throw new TypeError(`artifacts.data: '.' and '..' are not allowed in a ${what}`);
  return segs.map(encodeURIComponent).join('/');
}

const isDocPath = (path: string): boolean => {
  const n = path.split('/').filter((s) => s.length > 0).length;
  return n > 0 && n % 2 === 0;
};

/** A document path has an EVEN number of segments, a collection an odd one — say so before the server does. */
function wantDoc(path: string, method: string): void {
  if (!isDocPath(path))
    throw new TypeError(
      `artifacts.data: firestore.${method} takes a DOCUMENT path (collection/doc, an even number of segments) — got '${path}'`,
    );
}
function wantCollection(path: string, method: string): void {
  const n = typeof path === 'string' ? path.split('/').filter((s) => s.length > 0).length : 0;
  if (n % 2 !== 1)
    throw new TypeError(
      `artifacts.data: firestore.${method} takes a COLLECTION path (an odd number of segments) — got '${path}'`,
    );
}

/** `where=field,op,value` — the value as JSON, exactly as shared's formatWhereParam writes it. */
export const formatDataWhere = ([field, op, value]: ArtifactDataWhere): string =>
  `${field},${op},${JSON.stringify(encodeDataValue(value))}`;

/** The list query → the REST query string's parameters (`where` repeats). */
export function dataListQuery(q: ArtifactDataListQuery): Record<string, QueryParam> {
  const orderBy =
    q.orderBy === undefined
      ? undefined
      : typeof q.orderBy === 'string'
        ? q.orderBy
        : q.orderBy[1] === 'desc'
          ? `${q.orderBy[0]},desc`
          : q.orderBy[0];
  return {
    where: q.where?.length ? q.where.map(formatDataWhere) : undefined,
    order_by: orderBy,
    limit: q.limit,
    start_after: q.startAfter,
  };
}

const dataTooLarge = (message: string): TmError =>
  new TmError({ code: 'too_large', status: 0, message: `artifacts.data: ${message}` });

const dataReq = (o: RequestOptions | undefined): RequestOptions | undefined =>
  o
    ? {
        signal: o.signal,
        timeoutMs: o.timeoutMs,
        idempotencyKey: o.idempotencyKey,
        retry: o.retry,
        headers: o.headers,
      }
    : undefined;

/** A JSON document body must be a plain object — catch `set(path, [..])` before the server does. */
function wantDocument(data: unknown, method: string): Record<string, unknown> {
  if (!isPlainObject(data))
    throw new TypeError(`artifacts.data: firestore.${method} takes the document as a plain object`);
  return encodeDataValue(data) as Record<string, unknown>;
}

// ───────────────────────── the handle ─────────────────────────

export type ArtifactData = ReturnType<typeof createArtifactData>;

/**
 * `tm.artifacts.data(id)` — the artifact's own Firestore, Realtime Database
 * and files. Builds nothing and asks nothing: every method is one request.
 */
export function createArtifactData(http: Http, artifactId: string, opts: ArtifactDataOptions = {}) {
  if (!artifactId || typeof artifactId !== 'string')
    throw new TypeError('artifacts.data(id): the artifact id is required');
  const root = `/artifacts/${encodeURIComponent(artifactId)}/data`;
  const revive = <T>(v: unknown): T => (opts.raw ? v : decodeDataValue(v)) as T;
  const reviveDoc = <T>(d: ArtifactDataDoc<unknown>): ArtifactDataDoc<T> => ({
    ...d,
    data: d.data === null ? null : revive<T>(d.data),
  });
  const fsUrl = (path: string): string => `${root}/firestore/${dataPath(path)}`;
  // The root of the RTDB is a real address: '' and '/' are fine there.
  const rtUrl = (path: string): string => {
    const p = dataPath(path ?? '');
    return p ? `${root}/rtdb/${p}` : `${root}/rtdb`;
  };
  const fileUrl = (path: string): string => {
    const p = dataPath(path);
    if (!p) throw new TypeError('artifacts.data: a file needs a path');
    return `${root}/files/${p}`;
  };

  async function listPage<T = Record<string, unknown>>(
    collectionPath: string,
    q: ArtifactDataListQuery & RequestOptions = {},
  ): Promise<ArtifactDataPage<T>> {
    wantCollection(collectionPath, 'list');
    const page = await http.json<{ data: ArtifactDataDoc<unknown>[]; next_cursor: string | null }>({
      method: 'GET',
      path: fsUrl(collectionPath),
      query: dataListQuery(q),
      options: dataReq(q),
    });
    return { data: page.data.map((d) => reviveDoc<T>(d)), nextCursor: page.next_cursor };
  }

  /** Every document the query matches, following `nextCursor` to the end. */
  async function* listAll<T = Record<string, unknown>>(
    collectionPath: string,
    q: ArtifactDataListQuery & RequestOptions = {},
  ): AsyncGenerator<ArtifactDataDoc<T>> {
    let startAfter = q.startAfter;
    for (;;) {
      const page = await listPage<T>(collectionPath, { ...q, startAfter });
      for (const d of page.data) yield d;
      if (!page.nextCursor || page.data.length === 0) return;
      startAfter = page.nextCursor;
    }
  }

  return {
    /** The artifact this handle is for. */
    artifactId,

    firestore: {
      /** One document. A missing one answers `{ exists: false, data: null }`. */
      get: async <T = Record<string, unknown>>(
        path: string,
        o?: RequestOptions,
      ): Promise<ArtifactDataDoc<T>> => {
        wantDoc(path, 'get');
        return reviveDoc<T>(
          await http.json<ArtifactDataDoc<unknown>>({
            method: 'GET',
            path: fsUrl(path),
            options: dataReq(o),
          }),
        );
      },
      /** Write the document — replacing it, or with `{ merge: true }` merging into what is there. */
      set: (
        path: string,
        data: Record<string, unknown>,
        o: RequestOptions & { merge?: boolean } = {},
      ): Promise<ArtifactDataWriteResult> => {
        wantDoc(path, 'set');
        return http.json<ArtifactDataWriteResult>({
          method: 'PUT',
          path: fsUrl(path),
          query: { merge: o.merge ? 1 : undefined },
          body: wantDocument(data, 'set'),
          options: dataReq(o),
        });
      },
      /** Change some fields; keys may be dotted field paths ('stats.count'). `not_found` when the document does not exist. */
      update: (
        path: string,
        patch: Record<string, unknown>,
        o?: RequestOptions,
      ): Promise<ArtifactDataWriteResult> => {
        wantDoc(path, 'update');
        return http.json<ArtifactDataWriteResult>({
          method: 'PATCH',
          path: fsUrl(path),
          body: wantDocument(patch, 'update'),
          options: dataReq(o),
        });
      },
      /** Delete one document (its subcollections stay, as in Firestore). */
      delete: (path: string, o?: RequestOptions): Promise<{ ok: true }> => {
        wantDoc(path, 'delete');
        return http.json<{ ok: true }>({
          method: 'DELETE',
          path: fsUrl(path),
          options: dataReq(o),
        });
      },
      /** Add a document with a generated id to a collection → `{ id, path }`. */
      add: (
        collectionPath: string,
        data: Record<string, unknown>,
        o?: RequestOptions,
      ): Promise<{ id: string; path: string }> => {
        wantCollection(collectionPath, 'add');
        return http.json<{ id: string; path: string }>({
          method: 'POST',
          path: fsUrl(collectionPath),
          body: wantDocument(data, 'add'),
          options: dataReq(o),
        });
      },
      /** One page of a collection: `{ data, nextCursor }`. */
      list: listPage,
      /** `for await (const doc of data.firestore.listAll('scores', { where: [...] }))` — pages for you. */
      listAll,
      /**
       * Up to 400 set / update / delete writes, ALL OR NOTHING — what the
       * page's driver does not have, and how a nightly job replaces a
       * dataset without anyone seeing it half-written.
       */
      batch: (
        writes: readonly ArtifactDataWrite[],
        o?: RequestOptions,
      ): Promise<{ ok: true; written: number }> => {
        if (!Array.isArray(writes) || writes.length === 0)
          throw new TypeError('artifacts.data: firestore.batch needs at least one write');
        if (writes.length > ARTIFACT_DATA_LIMITS.batchWrites)
          throw dataTooLarge(
            `a batch is at most ${ARTIFACT_DATA_LIMITS.batchWrites} writes (got ${writes.length}) — it is atomic, so split it yourself where a half-applied state is acceptable`,
          );
        return http.json<{ ok: true; written: number }>({
          method: 'POST',
          path: `${root}/batch`,
          body: {
            writes: (writes as readonly ArtifactDataWrite[]).map((w) =>
              w.op === 'delete'
                ? { op: w.op, path: w.path }
                : w.op === 'update'
                  ? { op: w.op, path: w.path, data: wantDocument(w.data, 'batch') }
                  : {
                      op: w.op,
                      path: w.path,
                      data: wantDocument(w.data, 'batch'),
                      ...(w.merge !== undefined ? { merge: w.merge } : {}),
                    },
            ),
          },
          options: dataReq(o),
        });
      },
    },

    /**
     * The artifact's Realtime Database. It has no timestamp type: a `Date`
     * is stored as that instant's epoch milliseconds and `serverTime` as the
     * server's, so both read back as numbers.
     */
    rtdb: {
      /** The value at a path; null when nothing is there. */
      get: async <T = unknown>(path = '', o?: RequestOptions): Promise<T | null> =>
        (
          await http.json<{ path: string; value: T | null }>({
            method: 'GET',
            path: rtUrl(path),
            options: dataReq(o),
          })
        ).value,
      /** Replace the value at a path. */
      set: (path: string, value: unknown, o?: RequestOptions): Promise<{ ok: true }> =>
        http.json<{ ok: true }>({
          method: 'PUT',
          path: rtUrl(path),
          body: encodeDataValue(value ?? null),
          options: dataReq(o),
        }),
      /** Update children: an object whose keys may be relative paths ('stats/count'). */
      update: (
        path: string,
        patch: Record<string, unknown>,
        o?: RequestOptions,
      ): Promise<{ ok: true }> =>
        http.json<{ ok: true }>({
          method: 'PATCH',
          path: rtUrl(path),
          body: encodeDataValue(patch),
          options: dataReq(o),
        }),
      /**
       * Add a child under a generated, time-ordered key → `{ key, path }`.
       *
       * NOT RETRIED unless you ask (`{ retry: { retries: 2 } }`): a push is the
       * one write here that is not the same write twice — the server keys
       * nothing on the Idempotency-Key for it, so a retry after a lost answer
       * would add a second child. (`firestore.add` is safe: its id is derived
       * from the key.)
       */
      push: (
        path: string,
        value: unknown,
        o?: RequestOptions,
      ): Promise<{ key: string; path: string }> =>
        http.json<{ key: string; path: string }>({
          method: 'POST',
          path: rtUrl(path),
          body: encodeDataValue(value ?? null),
          options: { ...dataReq(o), retry: o?.retry ?? false },
        }),
      /** Remove the value at a path (and everything under it). */
      remove: (path: string, o?: RequestOptions): Promise<{ ok: true }> =>
        http.json<{ ok: true }>({ method: 'DELETE', path: rtUrl(path), options: dataReq(o) }),
    },

    files: {
      /**
       * Put a file (≤ 25 MB). The body is the file itself: bytes, a Blob, or
       * a string (sent as UTF-8). The content type is `contentType`, else the
       * Blob's own, else text/plain for a string and
       * application/octet-stream for bytes.
       */
      upload: (
        path: string,
        content: Uint8Array | ArrayBuffer | Blob | string,
        o: RequestOptions & { contentType?: string } = {},
      ): Promise<ArtifactDataFile> => {
        const isBlob = typeof Blob !== 'undefined' && content instanceof Blob;
        const type =
          o.contentType ??
          (isBlob && (content as Blob).type
            ? (content as Blob).type
            : typeof content === 'string'
              ? 'text/plain; charset=utf-8'
              : 'application/octet-stream');
        let body: Blob;
        if (isBlob) body = content as Blob;
        else if (typeof content === 'string') body = new Blob([content], { type });
        else if (content instanceof Uint8Array || content instanceof ArrayBuffer)
          body = new Blob([content as BlobPart], { type });
        else throw new TypeError('artifacts.data: files.upload takes bytes, a Blob or a string');
        if (body.size > ARTIFACT_DATA_LIMITS.uploadBytes)
          throw dataTooLarge(
            `'${path}' is ${(body.size / 1024 / 1024).toFixed(1)} MB; a file is at most ${ARTIFACT_DATA_LIMITS.uploadBytes / 1024 / 1024} MB`,
          );
        return http.json<ArtifactDataFile>({
          method: 'PUT',
          path: fileUrl(path),
          rawBody: body,
          headers: { 'content-type': type },
          options: { ...dataReq(o), timeoutMs: o.timeoutMs ?? UPLOAD_TIMEOUT_MS },
        });
      },
      /** A short-lived link to one file; `not_found` when it is not there. */
      url: (path: string, o?: RequestOptions): Promise<ArtifactDataFileUrl> =>
        http.json<ArtifactDataFileUrl>({ method: 'GET', path: fileUrl(path), options: dataReq(o) }),
      /** Every file under a prefix (recursive; at most 1000). No prefix: all of them. */
      list: async (prefix = '', o?: RequestOptions): Promise<ArtifactDataFile[]> =>
        (
          await http.json<{ data: ArtifactDataFile[] }>({
            method: 'GET',
            path: `${root}/files`,
            query: { prefix: prefix || undefined },
            options: dataReq(o),
          })
        ).data,
      /** Delete one file. Deleting one that is not there is fine. */
      delete: (path: string, o?: RequestOptions): Promise<{ ok: true }> =>
        http.json<{ ok: true }>({ method: 'DELETE', path: fileUrl(path), options: dataReq(o) }),
    },
  };
}
