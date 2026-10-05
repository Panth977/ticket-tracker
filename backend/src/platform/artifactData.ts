/**
 * THE ARTIFACT'S DATA, FROM OUTSIDE THE PAGE (docs/plan/agents.html §AA4).
 *
 * Until §AA an artifact's database could only be written from inside the
 * page, by whoever was looking at it. An agent that wanted numbers on a
 * dashboard had to bake them into the build. This module is the SAME FENCE
 * the page's driver goes through (shared/src/artifacts/paths.ts), reached
 * with a token — REST /v1/artifacts/{id}/data/… and the MCP artifact_data_*
 * tools both call it, and nothing else.
 *
 * THREE RULES, and every function below is an instance of them:
 *
 *   1. WHO. loadArtifact decides, once, from the artifact document:
 *        an agent token      its agent's `data` there — 'read' for reads,
 *                            'write' for writes (§AA3); `build` alone gives
 *                            nothing here
 *        an account token    its person's role — owner or editor (a viewer's
 *                            token reaches no artifact at all, as before)
 *      No role is a 404, a role that is too low a 403. An artifact being
 *      deleted is a 404 for everyone. An ARCHIVED artifact refuses writes
 *      (409), exactly as the rules refuse the page's.
 *
 *   2. WHERE. Every location is built by a shared fence function and by
 *      nothing else — artifactFirestoreDoc / Collection / Relative,
 *      artifactRtdbPath, artifactStorageFile / Prefix. There is no string
 *      concatenation of a caller's path in this file. They refuse '.', '..',
 *      over-long paths, the reserved collection names ('tickets', 'reads' —
 *      the app's collection-group rules would hand such documents to people
 *      with no role here) and characters a store cannot hold; their refusal
 *      is a 400 (`fenced`). The Admin SDK is not subject to the security
 *      rules, so THIS is the boundary for these calls.
 *
 *   3. WHAT. Values are JSON with two escapes (shared artifacts/data.ts):
 *      { "$date": ISO } is a Firestore Timestamp both ways, and
 *      { "$serverTime": true } in a write is the server's clock. The page
 *      sees the same documents through the driver, with timestamps as Date.
 *
 * Not commands: there is no app caller (the page writes through the rules),
 * so there is no /api face to share a handler with. The doors gate the scope
 * (artifacts:read / artifacts:write, REST_ROUTES / MCP_TOOLS) and call here.
 */
import { createHash } from 'node:crypto';
import {
  DocumentReference,
  FieldValue,
  GeoPoint,
  Timestamp,
  type Query,
} from 'firebase-admin/firestore';
import { ServerValue } from 'firebase-admin/database';
import {
  ARTIFACT_FILE_LIST_MAX,
  ARTIFACT_UPLOAD_MAX_BYTES,
  artifactFirestoreCollection,
  artifactFirestoreDoc,
  artifactFirestoreRelative,
  artifactPrefix,
  artifactRtdbPath,
  artifactStorageFile,
  artifactStoragePrefix,
  ArtifactValueError,
  decodeJsonDocument,
  decodeJsonValue,
  encodeJsonValue,
  errors,
  isAppError,
  splitArtifactPath,
  toIso,
  type ArtifactDataDoc,
  type ArtifactDataFile,
  type ArtifactDataList,
  type ArtifactDataQuery,
  type ArtifactDataWrite,
  type ValueDecoder,
  type ValueEncoder,
} from '@tm/shared';
import { ports } from '../adapters/index.js';
import { objectLink, objectOf } from '../artifacts/files.js';
import { assertNotArchived, fenced, loadArtifact } from '../artifacts/shared.js';
import type { ServerCtx } from '../runtime/context.js';
import { db, rtdbAdmin, storageAdmin } from '../runtime/firebase.js';

// ─── who ─────────────────────────────────────────────────────────────────────

/** Rule 1: read needs data ≥ read; write needs data = write AND a live (not archived) artifact. */
async function gate(ctx: ServerCtx, artifactId: string, need: 'read' | 'write'): Promise<void> {
  const { artifact } = await loadArtifact(
    null,
    artifactId,
    ctx,
    need === 'write' ? 'writeData' : 'readData',
  );
  if (need === 'write') assertNotArchived(artifact);
}

// ─── what: the two escapes, for each store ───────────────────────────────────

const FS_DECODE: ValueDecoder<unknown> = {
  date: (at) => Timestamp.fromDate(at),
  serverTime: () => FieldValue.serverTimestamp(),
};
/** A filter value is compared, never stored: there is no "server time" to compare with. */
const FS_DECODE_FILTER: ValueDecoder<unknown> = {
  date: (at) => Timestamp.fromDate(at),
  serverTime: () => {
    throw new ArtifactValueError('"$serverTime" is for writes — filter with a "$date"');
  },
};
const FS_ENCODE: ValueEncoder = {
  asDate: (v) => (v instanceof Timestamp ? v.toDate() : null),
  // Types the driver's page can store but JSON cannot carry: a readable stand-in.
  other: (v) => {
    if (v instanceof DocumentReference) return v.path;
    if (v instanceof GeoPoint) return { latitude: v.latitude, longitude: v.longitude };
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('base64');
    return String(v);
  },
};
/**
 * The Realtime Database has no timestamp type: a time there is epoch
 * milliseconds. So "$serverTime" is its server value, and "$date" is stored
 * as that instant's milliseconds (one way: a number read back is a number).
 */
const RTDB_DECODE: ValueDecoder<unknown> = {
  date: (at) => at.getTime(),
  serverTime: () => ServerValue.TIMESTAMP,
};

/** A bad value is the caller's mistake: a 400 that says where. */
function decoded<T>(fn: () => T, field = 'data'): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ArtifactValueError) throw errors.invalid(e.message, { field });
    throw e;
  }
}

// ─── errors the stores raise → our vocabulary ────────────────────────────────

const GRPC = { INVALID_ARGUMENT: 3, NOT_FOUND: 5, ALREADY_EXISTS: 6, FAILED_PRECONDITION: 9 };
const TOO_LARGE = /exceeds the maximum|maximum allowed size|payload size exceeds|too large|larger than/i;
/** The Firestore client's own argument checks throw a plain Error with one of these openings. */
const CLIENT_CHECK =
  /^(Value for argument|Update\(\) requires|Paths? must|Element at index|Cannot (use|encode)|Invalid (use|query)|At least one field|Input is not a plain|Couldn't serialize|.*field path|.*FieldPath)/i;

/**
 * Run a Firestore call and translate what it raises:
 *   NOT_FOUND            → 404 (an update / a batch update of a missing document)
 *   a document too big   → 413 too_large (Firestore's 1 MiB)
 *   INVALID_ARGUMENT     → 400, with Firestore's own words
 *   FAILED_PRECONDITION  → 400, with Firestore's own words — this is "the
 *                          query requires an index", and the message carries
 *                          the link that creates it
 *   the client's argument checks → 400
 * Anything else (unavailable, deadline, a bug) is not the caller's mistake
 * and goes up unchanged.
 */
async function fs<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isAppError(e)) throw e;
    const err = e as { code?: unknown; message?: string; details?: string };
    const message = String(err.details || err.message || 'Firestore refused the request');
    if (TOO_LARGE.test(message))
      throw errors.too_large(`A Firestore document is at most 1 MiB — ${message}`);
    if (err.code === GRPC.NOT_FOUND)
      throw errors.not_found(
        'Document not found — an update needs an existing document (PUT / set creates one)',
      );
    if (err.code === GRPC.ALREADY_EXISTS) throw errors.conflict('That document already exists');
    if (err.code === GRPC.INVALID_ARGUMENT || err.code === GRPC.FAILED_PRECONDITION)
      throw errors.invalid(message);
    if (err.code === undefined && CLIENT_CHECK.test(message)) throw errors.invalid(message);
    throw e;
  }
}

/** The Realtime Database client validates keys and values itself and throws a plain Error. */
async function rt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isAppError(e)) throw e;
    const message = String((e as Error)?.message ?? '');
    if (/failed: |contains (an )?invalid key|invalid key|must be (a|an) |undefined in property/i.test(message))
      throw errors.invalid(message.replace(/^Reference\.\w+ failed: /, ''));
    throw e;
  }
}

// ─── Firestore ───────────────────────────────────────────────────────────────

const docRef = (artifactId: string, path: unknown, field = 'path') =>
  db().doc(fenced(() => artifactFirestoreDoc(artifactId, path), field));
const colRef = (artifactId: string, path: unknown) =>
  db().collection(fenced(() => artifactFirestoreCollection(artifactId, path)));

function toDoc(
  artifactId: string,
  snap: FirebaseFirestore.DocumentSnapshot,
): ArtifactDataDoc {
  return {
    id: snap.id,
    path: artifactFirestoreRelative(artifactId, snap.ref.path),
    exists: snap.exists,
    data: snap.exists
      ? (encodeJsonValue(snap.data() ?? {}, FS_ENCODE) as Record<string, unknown>)
      : null,
  };
}

/** Is this path (in the artifact's own view) a DOCUMENT — an even, non-zero number of segments? */
export function isDocumentPath(path: unknown): boolean {
  const n = fenced(() => splitArtifactPath(path)).length;
  return n > 0 && n % 2 === 0;
}

/** GET a document → { id, path, exists, data }. A missing document is `exists: false`, not a 404. */
export async function dataGet(
  ctx: ServerCtx,
  artifactId: string,
  path: unknown,
): Promise<ArtifactDataDoc> {
  await gate(ctx, artifactId, 'read');
  const ref = docRef(artifactId, path);
  return toDoc(artifactId, await fs(() => ref.get()));
}

/**
 * GET a collection → { data, next_cursor }. Filters use WHERE_OPS; the page
 * is `limit` documents (default 100, at most 500); `startAfter` is a document
 * id in this collection and `next_cursor` is the last id of a full page (null
 * when the page came back short — there is nothing after it).
 */
export async function dataList(
  ctx: ServerCtx,
  artifactId: string,
  path: unknown,
  query: ArtifactDataQuery,
): Promise<ArtifactDataList> {
  await gate(ctx, artifactId, 'read');
  const col = colRef(artifactId, path);
  let q: Query = col;
  for (const [field, op, value] of query.where ?? [])
    q = q.where(field, op, decoded(() => decodeJsonValue(value, FS_DECODE_FILTER), 'where'));
  if (query.orderBy) q = q.orderBy(query.orderBy[0], query.orderBy[1]);
  if (query.startAfter) {
    // One segment, by the fence: a cursor can no more leave the collection than a path can.
    const id = fenced(() => splitArtifactPath(query.startAfter), 'start_after');
    if (id.length !== 1)
      throw errors.invalid('start_after is a document id of this collection', {
        field: 'start_after',
      });
    const after = await fs(() => col.doc(id[0]!).get());
    if (!after.exists)
      throw errors.invalid('start_after names a document that is not in this collection', {
        field: 'start_after',
      });
    q = q.startAfter(after);
  }
  const snap = await fs(() => q.limit(query.limit).get());
  const data = snap.docs.map((d) => toDoc(artifactId, d));
  return {
    data,
    next_cursor: data.length === query.limit ? (data[data.length - 1]?.id ?? null) : null,
  };
}

export async function dataSet(
  ctx: ServerCtx,
  artifactId: string,
  path: unknown,
  data: unknown,
  merge = false,
): Promise<{ ok: true; id: string; path: string }> {
  await gate(ctx, artifactId, 'write');
  const ref = docRef(artifactId, path);
  const value = decoded(() => decodeJsonDocument(data, FS_DECODE));
  await fs(() => (merge ? ref.set(value, { merge: true }) : ref.set(value)));
  return { ok: true, id: ref.id, path: artifactFirestoreRelative(artifactId, ref.path) };
}

/** Dotted keys are field paths ('stats.count'). The document must exist (404 otherwise). */
export async function dataUpdate(
  ctx: ServerCtx,
  artifactId: string,
  path: unknown,
  data: unknown,
): Promise<{ ok: true; id: string; path: string }> {
  await gate(ctx, artifactId, 'write');
  const ref = docRef(artifactId, path);
  const value = decoded(() => decodeJsonDocument(data, FS_DECODE));
  if (Object.keys(value).length === 0)
    throw errors.invalid('An update needs at least one field', { field: 'data' });
  await fs(() => ref.update(value));
  return { ok: true, id: ref.id, path: artifactFirestoreRelative(artifactId, ref.path) };
}

/** Deleting a document that is not there is fine: the caller wanted it gone. */
export async function dataDelete(
  ctx: ServerCtx,
  artifactId: string,
  path: unknown,
): Promise<{ ok: true }> {
  await gate(ctx, artifactId, 'write');
  const ref = docRef(artifactId, path);
  await fs(() => ref.delete());
  return { ok: true };
}

/**
 * POST to a collection → a new document with a generated id.
 *
 * `idempotencyKey` (the REST Idempotency-Key header): the id is then DERIVED
 * from the key, and the write is a create — so a retried request finds its
 * own document already there and answers the same { id, path } instead of
 * adding a second one. No record to keep, nothing to expire.
 */
export async function dataAdd(
  ctx: ServerCtx,
  artifactId: string,
  path: unknown,
  data: unknown,
  idempotencyKey?: string | null,
): Promise<{ id: string; path: string }> {
  await gate(ctx, artifactId, 'write');
  const col = colRef(artifactId, path);
  const value = decoded(() => decodeJsonDocument(data, FS_DECODE));
  const ref = idempotencyKey
    ? col.doc(
        createHash('sha256')
          .update(`${ctx.ownerUid ?? ctx.actor}\n${col.path}\n${idempotencyKey}`)
          .digest('base64url')
          .slice(0, 20),
      )
    : col.doc();
  const out = { id: ref.id, path: artifactFirestoreRelative(artifactId, ref.path) };
  try {
    await fs(() => ref.create(value));
  } catch (e) {
    // The replay of a request that already landed.
    if (idempotencyKey && isAppError(e) && e.code === 'conflict') return out;
    throw e;
  }
  return out;
}

/**
 * Up to ARTIFACT_DATA_BATCH_MAX writes, ALL OR NOTHING — what the driver does
 * not have, and how a nightly job replaces a dataset. Every path and every
 * value is checked BEFORE anything is sent, so a bad one refuses the whole
 * batch with nothing written; and the commit itself is one atomic Firestore
 * write batch, so an update of a missing document fails it whole as well.
 */
export async function dataBatch(
  ctx: ServerCtx,
  artifactId: string,
  writes: readonly ArtifactDataWrite[],
): Promise<{ ok: true; written: number }> {
  await gate(ctx, artifactId, 'write');
  const batch = db().batch();
  writes.forEach((w, i) => {
    const at = `writes[${i}]`;
    const ref = docRef(artifactId, w.path, `${at}.path`);
    if (w.op === 'delete') {
      batch.delete(ref);
      return;
    }
    const value = decoded(() => decodeJsonDocument(w.data, FS_DECODE), `${at}.data`);
    if (w.op === 'set') {
      if (w.merge) batch.set(ref, value, { merge: true });
      else batch.set(ref, value);
      return;
    }
    if (Object.keys(value).length === 0)
      throw errors.invalid(`${at}: an update needs at least one field`, { field: `${at}.data` });
    try {
      batch.update(ref, value);
    } catch (e) {
      // The client checks field paths as the write is queued.
      throw errors.invalid(`${at}: ${(e as Error).message}`, { field: `${at}.data` });
    }
  });
  await fs(() => batch.commit());
  return { ok: true, written: writes.length };
}

// ─── Realtime Database ───────────────────────────────────────────────────────

const rtRef = (artifactId: string, path: unknown, field = 'path') =>
  rtdbAdmin().ref(fenced(() => artifactRtdbPath(artifactId, path), field));
/** The artifact's own view of a full RTDB path ('/scores/today'; '/' is its root). */
const rtRelative = (artifactId: string, full: string): string =>
  `/${full.slice(artifactPrefix.rtdb(artifactId).length).replace(/^\/+/, '')}`;
const rtView = (artifactId: string, path: unknown): string =>
  rtRelative(
    artifactId,
    fenced(() => artifactRtdbPath(artifactId, path)),
  );

export async function rtdbGet(
  ctx: ServerCtx,
  artifactId: string,
  path: unknown,
): Promise<{ path: string; value: unknown }> {
  await gate(ctx, artifactId, 'read');
  const snap = await rt(() => rtRef(artifactId, path).get());
  return { path: rtView(artifactId, path), value: snap.val() ?? null };
}

export async function rtdbSet(
  ctx: ServerCtx,
  artifactId: string,
  path: unknown,
  value: unknown,
): Promise<{ ok: true }> {
  await gate(ctx, artifactId, 'write');
  const ref = rtRef(artifactId, path);
  const v = decoded(() => decodeJsonValue(value, RTDB_DECODE), 'value');
  await rt(() => ref.set(v));
  return { ok: true };
}

/**
 * Update children. The body is an object; a key may be a relative path
 * ('stats/count'), and each is put through the fence too — a key cannot leave
 * the artifact any more than the path can.
 */
export async function rtdbUpdate(
  ctx: ServerCtx,
  artifactId: string,
  path: unknown,
  patch: unknown,
): Promise<{ ok: true }> {
  await gate(ctx, artifactId, 'write');
  const ref = rtRef(artifactId, path);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw errors.invalid('An update is a JSON object of children', { field: 'value' });
  const base = typeof path === 'string' ? path : '';
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const child = k.replace(/^\/+|\/+$/g, '');
    if (!child) throw errors.invalid('An update key names a child', { field: 'value' });
    // Checked for what it is — a path under this artifact — and then used as the relative key.
    fenced(() => artifactRtdbPath(artifactId, `${base}/${child}`), 'value');
    out[child] = decoded(() => decodeJsonValue(v, RTDB_DECODE), 'value');
  }
  if (Object.keys(out).length === 0)
    throw errors.invalid('An update needs at least one child', { field: 'value' });
  await rt(() => ref.update(out));
  return { ok: true };
}

export async function rtdbRemove(
  ctx: ServerCtx,
  artifactId: string,
  path: unknown,
): Promise<{ ok: true }> {
  await gate(ctx, artifactId, 'write');
  await rt(() => rtRef(artifactId, path).remove());
  return { ok: true };
}

/** Push a child with a generated, time-ordered key → { key, path }. */
export async function rtdbPush(
  ctx: ServerCtx,
  artifactId: string,
  path: unknown,
  value: unknown,
): Promise<{ key: string; path: string }> {
  await gate(ctx, artifactId, 'write');
  const parent = rtRef(artifactId, path);
  const v = decoded(() => decodeJsonValue(value, RTDB_DECODE), 'value');
  const child = parent.push();
  await rt(() => child.set(v));
  const key = child.key!;
  return { key, path: rtView(artifactId, `${typeof path === 'string' ? path : ''}/${key}`) };
}

// ─── files ───────────────────────────────────────────────────────────────────

const filesRoot = (artifactId: string) => `${artifactPrefix.storageFiles(artifactId)}/`;
const fileView = (artifactId: string, full: string) => `/${full.slice(filesRoot(artifactId).length)}`;

interface ObjectMeta {
  size?: string | number;
  contentType?: string;
  updated?: string;
  timeCreated?: string;
}
function toFile(artifactId: string, name: string, m: ObjectMeta): ArtifactDataFile {
  const at = Date.parse(String(m.updated ?? m.timeCreated ?? ''));
  return {
    path: fileView(artifactId, name),
    size: Number(m.size ?? 0),
    content_type: m.contentType ?? null,
    updated_at: Number.isNaN(at) ? null : toIso(at),
  };
}

/** Every file under a prefix (recursive), at most ARTIFACT_FILE_LIST_MAX — as db.storage.list. */
export async function filesList(
  ctx: ServerCtx,
  artifactId: string,
  prefix: unknown,
): Promise<{ data: ArtifactDataFile[] }> {
  await gate(ctx, artifactId, 'read');
  const full = fenced(() => artifactStoragePrefix(artifactId, prefix), 'prefix');
  const [files] = await storageAdmin()
    .bucket()
    .getFiles({ prefix: full, maxResults: ARTIFACT_FILE_LIST_MAX, autoPaginate: false });
  return { data: files.map((f) => toFile(artifactId, f.name, f.metadata as ObjectMeta)) };
}

/** The raw bytes are the file. ≤ ARTIFACT_UPLOAD_MAX_BYTES (25 MB), like a page's upload. */
export async function fileUpload(
  ctx: ServerCtx,
  artifactId: string,
  path: unknown,
  bytes: Uint8Array,
  contentType: string | undefined,
): Promise<ArtifactDataFile> {
  if (bytes.length > ARTIFACT_UPLOAD_MAX_BYTES)
    throw errors.too_large(`A file is at most ${ARTIFACT_UPLOAD_MAX_BYTES / 1024 / 1024} MB`);
  await gate(ctx, artifactId, 'write');
  const full = fenced(() => artifactStorageFile(artifactId, path));
  const type = contentType?.trim() || 'application/octet-stream';
  await storageAdmin()
    .bucket()
    .file(full)
    // A VIEW of the request's bytes, not a copy (as publishZip does).
    .save(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      contentType: type,
      resumable: false,
    });
  return {
    path: fileView(artifactId, full),
    size: bytes.length,
    content_type: type,
    updated_at: toIso(ctx.now),
  };
}

/** A short-lived link to one file — the same link artifactFileUrl hands the page (artifacts/files.ts). */
export async function fileUrl(
  ctx: ServerCtx,
  artifactId: string,
  path: unknown,
): Promise<{ url: string; expires_at: string }> {
  await gate(ctx, artifactId, 'read');
  const full = fenced(() => artifactStorageFile(artifactId, path));
  if (!(await ports().files.stat(full))) throw errors.not_found('File not found');
  const link = await objectLink(artifactId, objectOf(artifactId, full), ctx.actor, ctx.now);
  return { url: link.url, expires_at: toIso(link.expiresAt)! };
}

/** Deleting a file that is not there is fine. */
export async function fileDelete(
  ctx: ServerCtx,
  artifactId: string,
  path: unknown,
): Promise<{ ok: true }> {
  await gate(ctx, artifactId, 'write');
  await ports().files.delete(fenced(() => artifactStorageFile(artifactId, path)));
  return { ok: true };
}
