/**
 * SIGNED OBJECT URLS of the disk store (blob/disk.ts) —
 *
 *   GET|HEAD /blob/read/{bucket}/{path…}?exp=…&sig=…        the bytes (Range ok)
 *   PUT      /blob/write/{bucket}/{path…}?exp=…&ct=…&sig=…  upload the bytes
 *
 * What Cloud Storage's signed URLs are on Firebase. The URL IS the
 * permission: an HMAC with the server key over (op, bucket, path, expiry,
 * content type), minted only by code that already checked access. No
 * session is read.
 *
 * Served from the app's own origin, so the response carries the same fences
 * as /api/files/blob: nosniff, and a sandbox CSP (opaque origin) on anything
 * but a PDF — an uploaded HTML or SVG can never reach the session.
 *
 * And what the Firebase Storage web SDK does for the browser on a VM (the
 * VM build's firebase/storage shim), checked by storage.rules:
 *
 *   POST /blob/o/{bucket}/{path…}   (Bearer; x-tm-metadata: {custom metadata JSON})
 *                                   upload → the object's metadata
 *   GET  /blob/o/{bucket}/{path…}   (Bearer) → { url }: a signed read URL (getDownloadURL)
 *
 * On Cloud Storage (TM_BLOB=gcs) the route does not exist (404).
 */
import { Readable } from 'node:stream';
import { blobKind, storageBucket } from '../blob/index.js';
import { blobSignature } from '../blob/disk.js';
import { door } from '../http/mounts.js';
import { identity } from '../identity/index.js';
import { bearer } from '../middleware/user.js';
import { storageAllows, type RulesAuth } from '../rules/firestore.js';
import { safeEqual } from '../platform/crypto.js';
import { parseRange } from '../platform/fileAccess.js';

/** Largest body one PUT may carry (an artifact build zip is ≤ 26 MB; bucket files ≤ 100 MB). */
const MAX_PUT_BYTES = 128 * 1024 * 1024;

const blob = door('blob');

function plain(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** '/read/default/a/b%20c.png' → { op, bucket, name } */
function parse(path: string): { op: string; bucket: string; name: string } | null {
  const m = /^\/(read|write|o)\/([^/]+)\/(.+)$/.exec(path);
  if (!m) return null;
  try {
    return {
      op: m[1]!,
      bucket: decodeURIComponent(m[2]!),
      name: m[3]!.split('/').map(decodeURIComponent).join('/'),
    };
  } catch {
    return null;
  }
}

function verify(
  op: 'read' | 'write',
  bucket: string,
  name: string,
  q: (k: string) => string | undefined,
): string | null {
  const exp = Number(q('exp') ?? 0);
  const sig = q('sig') ?? '';
  if (!exp || !sig) return 'A signed URL is required';
  if (!Number.isFinite(exp) || exp < Date.now()) return 'This link has expired';
  if (!safeEqual(sig, blobSignature(op, bucket, name, exp, op === 'write' ? (q('ct') ?? '') : '')))
    return 'This link is not valid';
  return null;
}

blob.on(['GET', 'HEAD'], '/read/*', async (c) => {
  if (blobKind() !== 'disk') return plain(404, 'Not found');
  const at = parse(c.req.path.slice(c.req.path.indexOf('/read/')));
  if (!at) return plain(400, 'Bad object URL');
  const refused = verify('read', at.bucket, at.name, (k) => c.req.query(k));
  if (refused) return plain(403, refused);

  const file = storageBucket(at.bucket).file(at.name);
  let size: number;
  let type: string;
  try {
    const [m] = await file.getMetadata();
    size = Number(m.size ?? 0);
    type = m.contentType || 'application/octet-stream';
  } catch {
    return plain(404, 'Not found');
  }
  const range = parseRange(c.req.header('range'), size);
  const headers: Record<string, string> = {
    'content-type': type,
    'content-length': String(range ? range.end - range.start + 1 : size),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=600',
    'x-content-type-options': 'nosniff',
    ...(type.startsWith('application/pdf') ? {} : { 'content-security-policy': 'sandbox' }),
  };
  if (range) headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
  if (c.req.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
  const node = file.createReadStream(range ?? {});
  return new Response(Readable.toWeb(node) as ReadableStream, {
    status: range ? 206 : 200,
    headers,
  });
});

blob.put('/write/*', async (c) => {
  if (blobKind() !== 'disk') return plain(404, 'Not found');
  const at = parse(c.req.path.slice(c.req.path.indexOf('/write/')));
  if (!at) return plain(400, 'Bad object URL');
  const refused = verify('write', at.bucket, at.name, (k) => c.req.query(k));
  if (refused) return plain(403, refused);
  const signedType = c.req.query('ct') ?? '';
  const type = c.req.header('content-type') || signedType || 'application/octet-stream';
  if (signedType && type !== signedType)
    return plain(403, 'Content-Type does not match the signed URL');
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_PUT_BYTES) return plain(413, 'Too large');
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > MAX_PUT_BYTES) return plain(413, 'Too large');
  await storageBucket(at.bucket).file(at.name).save(body, { contentType: type, resumable: false });
  return new Response(null, { status: 200 });
});

// ─── the browser's Storage SDK, on a VM ──────────────────────────────────────

/** How long a download URL works (Firebase's never expire; the app re-asks on a miss). */
const DOWNLOAD_URL_MS = 7 * 24 * 3600_000;

async function rulesAuth(header: string | undefined): Promise<RulesAuth | null | 'bad'> {
  const token = bearer(header);
  if (!token) return null;
  try {
    const d = await identity().verifyIdToken(token, true);
    return { uid: d.uid, token: d as unknown as Record<string, unknown> };
  } catch {
    return 'bad';
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
const storageError = (status: number, code: string, message: string) =>
  json(status, { error: { code: `storage/${code}`, message } });

async function current(bucket: string, name: string) {
  try {
    const [m] = await storageBucket(bucket).file(name).getMetadata();
    return {
      name,
      bucket,
      size: Number(m.size ?? 0),
      contentType: m.contentType ?? 'application/octet-stream',
      metadata: (m.metadata ?? {}) as Record<string, string>,
      timeCreated: m.timeCreated,
      updated: m.updated,
    };
  } catch {
    return null;
  }
}

blob.post('/o/*', async (c) => {
  if (blobKind() !== 'disk') return plain(404, 'Not found');
  const at = parse(c.req.path.slice(c.req.path.indexOf('/o/')));
  if (!at) return storageError(400, 'invalid-argument', 'Bad object path');
  const auth = await rulesAuth(c.req.header('authorization'));
  if (auth === 'bad') return storageError(401, 'unauthenticated', 'Invalid or expired ID token');
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_PUT_BYTES) return storageError(413, 'quota-exceeded', 'Too large');
  let custom: Record<string, string> = {};
  try {
    const raw = c.req.header('x-tm-metadata');
    if (raw)
      custom = Object.fromEntries(
        Object.entries(JSON.parse(raw) as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
  } catch {
    return storageError(400, 'invalid-argument', 'Bad x-tm-metadata');
  }
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > MAX_PUT_BYTES) return storageError(413, 'quota-exceeded', 'Too large');
  const contentType = c.req.header('content-type') || 'application/octet-stream';
  const before = await current(at.bucket, at.name);
  const after = { name: at.name, bucket: at.bucket, size: body.byteLength, contentType, metadata: custom };
  const ok = await storageAllows(auth, before ? 'update' : 'create', at.bucket, at.name, before, after);
  if (!ok) return storageError(403, 'unauthorized', 'User does not have permission to access this object.');
  await storageBucket(at.bucket)
    .file(at.name)
    .save(body, { contentType, resumable: false, metadata: { metadata: custom } });
  return json(200, await current(at.bucket, at.name));
});

blob.get('/o/*', async (c) => {
  if (blobKind() !== 'disk') return plain(404, 'Not found');
  const at = parse(c.req.path.slice(c.req.path.indexOf('/o/')));
  if (!at) return storageError(400, 'invalid-argument', 'Bad object path');
  const auth = await rulesAuth(c.req.header('authorization'));
  if (auth === 'bad') return storageError(401, 'unauthenticated', 'Invalid or expired ID token');
  const obj = await current(at.bucket, at.name);
  if (!(await storageAllows(auth, 'get', at.bucket, at.name, obj)))
    return storageError(403, 'unauthorized', 'User does not have permission to access this object.');
  if (!obj) return storageError(404, 'object-not-found', `Object '${at.name}' does not exist.`);
  const [url] = await storageBucket(at.bucket)
    .file(at.name)
    .getSignedUrl({ action: 'read', expires: Date.now() + DOWNLOAD_URL_MS });
  return json(200, { ...obj, url });
});
