/**
 * FILE ACCESS — the app's bytes door (docs/plan/agents.html §I, phase 11).
 *
 *   GET /api/files/url?path=…      Firebase ID token → { url, bytesUrl, expiresAt }
 *   GET /api/files/blob?path=…&exp=…&sig=…[&dl=1]    the bytes themselves
 *
 * WHY. The SPA used to read a ticket file straight from Cloud Storage, which
 * the Storage rules allowed by looking the board up with a CROSS-SERVICE
 * firestore.get(). When that lookup cannot be made the rule does not evaluate
 * to false — it ERRORS, and an error is a 403. Reproduced against the
 * emulators: `storage.rules line [24] Null value error` → storage/unauthorized
 * for an attachment, while an avatar (rule: plain signedIn()) loaded in the
 * same session. In production the same 403 hit files an AGENT had uploaded.
 *
 * The backend already owns the decision — can(read) on the board, the same
 * can() every command asks — so it mints the access here instead:
 *
 *   url       a v4 SIGNED URL (15 min) straight to Cloud Storage. Media
 *             (<img>, <video>, <audio>, a PDF frame) needs no CORS, so this is
 *             the cheap path: the bytes never touch the function.
 *   bytesUrl  SAME-ORIGIN, streamed through here. fetch() — the Range read the
 *             text previews do, and Download — must use this one: a
 *             storage.googleapis.com signed URL would need a bucket CORS
 *             configuration, which is exactly the kind of out-of-band setup
 *             this phase is removing.
 *
 * Where nothing can be signed (the Storage emulator has no service account, and
 * a Functions service account without the Token Creator role cannot sign
 * either) both URLs are the same same-origin one, so the app behaves
 * identically in dev and in production.
 *
 * NOTHING IS CACHED LONG-LIVED: the JSON is no-store, the URLs expire in 15
 * minutes, and no URL is ever written to Firestore.
 */
import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import {
  errors,
  FILE_ACCESS_ROUTE,
  FILE_BYTES_ROUTE,
  parseAgentAvatarPath,
  SIGNED_URL_TTL_MS,
  type FileAccessRes,
} from '@tm/shared';
import { ports } from '../adapters/index.js';
import { readStream } from '../adapters/files.js';
import type { AppEnv } from '../http/env.js';
import { door, MOUNTS } from '../http/mounts.js';
import { userAuth } from '../middleware/user.js';
import type { ServerCtx } from '../runtime/context.js';
import { loadBoard } from '../tickets/access.js';
import { safeEqual, serverMac } from './crypto.js';

/** boards/{boardId}/tickets/{ticketId}/{fileId}/{fileName} — the thumbnail too. */
const ATTACHMENT = /^boards\/([^/]+)\/tickets\/([^/]+)\/([^/]+)\/([^/]+)$/;
/** users/{uid}/avatar/{file} — the Storage rule is signedIn(), and so is this. */
const AVATAR = /^users\/([^/]+)\/avatar\/[^/]+$/;

/** Longest range a single request may pull through the function (the viewer reads far less). */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;

/** The capability in `bytesUrl`: we minted it after checking, exactly like a signed URL. */
const blobSig = (path: string, exp: number): string => serverMac('file-blob', `${path}\n${exp}`);

/**
 * May `ctx.actor` read this object? Attachments (and their thumbnails) need
 * can(read) on the board — loadBoard answers 404, never "no", for a board the
 * actor cannot see, so this leaks no existence. Avatars are readable by any
 * signed-in person, matching storage.rules. Anything else (exports, stray
 * paths) is refused outright.
 */
export async function requireFileRead(ctx: ServerCtx, path: string): Promise<void> {
  if (!path || path.includes('..') || path.startsWith('/'))
    throw errors.invalid('Bad file path', { field: 'path' });
  const att = ATTACHMENT.exec(path);
  if (att) {
    await loadBoard(ctx, att[1]!);
    return;
  }
  if (AVATAR.test(path) || parseAgentAvatarPath(path)) return;
  throw errors.not_found('File not found');
}

/**
 * Access to one object for `ctx.actor`, after can(read). 404 when the object is
 * not there — better a clean refusal now than a dead URL in an <img> later.
 */
export async function fileAccess(ctx: ServerCtx, path: string): Promise<FileAccessRes> {
  await requireFileRead(ctx, path);
  const stored = await ports().files.stat(path);
  if (!stored) throw errors.not_found('File not found');

  const expiresAt = ctx.now + SIGNED_URL_TTL_MS;
  const bytesUrl = `${FILE_BYTES_ROUTE}?path=${encodeURIComponent(path)}&exp=${expiresAt}&sig=${encodeURIComponent(blobSig(path, expiresAt))}`;
  let url = bytesUrl;
  if (!process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    try {
      url = await ports().files.signedDownloadUrl(path, expiresAt);
    } catch (e) {
      // Signing needs the Token Creator role on the function's service account.
      // Without it we still serve the file — through here — instead of failing.
      console.warn(
        '[files] could not sign a download URL; streaming instead',
        (e as Error).message,
      );
    }
  }
  return { url, bytesUrl, expiresAt };
}

/** `bytes=0-65535` → the inclusive range it asks for, clamped to the object. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
  if (!m || size <= 0) return null;
  const [, rawStart, rawEnd] = m;
  let start: number;
  let end: number;
  if (rawStart === '') {
    // `bytes=-500`: the last 500 bytes.
    const len = Number(rawEnd);
    if (!len) return null;
    start = Math.max(0, size - len);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

/**
 * The Content-Disposition for the object's own name. A header value must be
 * Latin-1 — a file called '计划.md' would throw when the Response is built — so
 * the plain `filename` is an ASCII fallback and the real name rides in the
 * RFC 5987 `filename*`.
 */
function disposition(path: string, download: boolean): string {
  const raw = path.split('/').pop() ?? 'file';
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    /* not percent-encoded */
  }
  // eslint-disable-next-line no-control-regex -- header value: no control characters, no quotes
  name = name.replace(/["\\\u0000-\u001f]/g, '_') || 'file';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** '/api/files/url' → '/files/url': the paths the app knows, relative to the mount. */
const inMount = (route: string) => route.slice(MOUNTS.api.length);

export function registerFileAccessRoutes(api: Hono<AppEnv> = door('api')): void {
  // Two segments on purpose: the app door owns /api/:command, and a one-segment
  // route would be swallowed by its "commands are POST only" catch-all.
  api.get(inMount(FILE_ACCESS_ROUTE), userAuth, async (c) => {
    const path = c.req.query('path');
    if (!path) throw errors.invalid('A file path is required', { field: 'path' });
    const res = await fileAccess(c.get('ctx'), path);
    c.header('cache-control', 'no-store');
    return c.json(res);
  });

  api.get(inMount(FILE_BYTES_ROUTE), async (c) => {
    const path = c.req.query('path') ?? '';
    const exp = Number(c.req.query('exp') ?? 0);
    const sig = c.req.query('sig') ?? '';
    if (!path || !exp || !sig) throw errors.invalid('A signed file URL is required');
    if (!Number.isFinite(exp) || exp < Date.now())
      throw errors.forbidden('This file link has expired');
    if (!safeEqual(sig, blobSig(path, exp))) throw errors.forbidden('This file link is not valid');

    const stored = await ports().files.stat(path);
    if (!stored) throw errors.not_found('File not found');

    const range = parseRange(c.req.header('range'), stored.size);
    if (range && range.end - range.start + 1 > MAX_STREAM_BYTES)
      range.end = range.start + MAX_STREAM_BYTES - 1;
    if (!range && stored.size > MAX_STREAM_BYTES)
      throw errors.too_large('Ask for this file in ranges');

    const type = stored.contentType || 'application/octet-stream';
    const headers: Record<string, string> = {
      'content-type': type,
      'content-length': String(range ? range.end - range.start + 1 : stored.size),
      'accept-ranges': 'bytes',
      // The object's bytes never change (attachments are written once), but the
      // LINK does: cache in the browser only, and never past the signature.
      'cache-control': `private, max-age=${Math.floor(SIGNED_URL_TTL_MS / 1000)}`,
      'x-content-type-options': 'nosniff',
      // Uploaded HTML (or SVG) is served from the APP'S OWN ORIGIN here, so it
      // is put in an opaque origin: it can never reach the session that opened
      // it. A PDF is exempt because the browser's own viewer is sandboxed
      // already and some viewers refuse to run under a sandbox CSP.
      ...(type.startsWith('application/pdf') ? {} : { 'content-security-policy': 'sandbox' }),
      'content-disposition': disposition(path, !!c.req.query('dl')),
      ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${stored.size}` } : {}),
    };
    const node = readStream(path, range ?? undefined);
    return c.body(Readable.toWeb(node) as ReadableStream, range ? 206 : 200, headers);
  });
}
