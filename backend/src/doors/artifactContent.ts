/**
 * THE ARTIFACT FILE ROUTE (docs/plan/artifacts.html §D) —
 *
 *   GET|HEAD /c/{capability}/{path…}
 *
 * the one door through which somebody else's code reaches a browser. On the
 * usercontent Hosting site it is the ONLY path that is rewritten to this
 * function; nothing of the app is served there.
 *
 * NO SESSION, BY DESIGN. The caller is a sandboxed iframe with an opaque
 * origin: it sends no cookie and no Authorization header, and none is read.
 * The permission is the capability in the path (artifacts/capability.ts) —
 * HMAC-signed, an hour long, minted only after a role check. This route
 * verifies it and does NOT ask Firestore anything: a build is a handful of
 * files and each one would cost a read.
 *
 *   a BUILD capability   {path} → artifacts/{id}/builds/{buildId}/{path}
 *                        ('' → index.html). A miss whose last segment has no
 *                        extension → index.html, so history routing mostly
 *                        works (§A); any other miss → 404.
 *   an OBJECT capability  one uploaded file, or one source zip. The path is
 *                        only a filename; the object is named by the
 *                        capability, so editing the URL reaches nothing else.
 *
 * EVERY RESPONSE — the file, the 404, the refused capability — carries the
 * same headers (SECURITY below). The sandbox CSP is the second of two fences
 * (the first is the iframe's own `sandbox` attribute): it covers somebody
 * opening the file URL as a top-level page, and it is why this route stays
 * harmless when it is reached on the app's own origin (a dev proxy, the
 * function's direct URL) — the document still gets an opaque origin and can
 * never touch the session that opened it.
 *
 * CORS is `*` because an opaque origin is the literal string "null": module
 * scripts and fonts are CORS requests, and there is no origin to name.
 */
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import { ArtifactPathError, artifactBuildFile, artifactPrefix } from '@tm/shared';
import { verifyCapability, type Capability } from '../artifacts/capability.js';
import type { AppEnv } from '../http/env.js';
import { door } from '../http/mounts.js';
import { parseRange } from '../platform/fileAccess.js';
import { storageAdmin } from '../runtime/firebase.js';

/** The sandbox an artifact runs in — the same tokens as the host page's iframe (§D1). */
export const ARTIFACT_SANDBOX =
  'sandbox allow-scripts allow-forms allow-popups allow-downloads allow-modals';

const SECURITY: Record<string, string> = {
  'content-security-policy': ARTIFACT_SANDBOX,
  'x-content-type-options': 'nosniff',
  'access-control-allow-origin': '*',
  'cross-origin-resource-policy': 'cross-origin',
  // Nothing here is for a search engine, and a capability must not travel in a Referer.
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
};
/** A build never changes, and the URL (capability included) lives an hour. */
const BUILD_CACHE = 'private, max-age=3600, immutable';
/** An uploaded file can be replaced; its link is 15 minutes long anyway. */
const OBJECT_CACHE = 'private, max-age=600';
/** Longest range one request may pull through the function (as platform/fileAccess.ts). */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;

type C = Context<AppEnv>;

function plain(status: 400 | 403 | 404 | 416, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {
      ...SECURITY,
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

interface Found {
  name: string;
  size: number;
  contentType: string;
}

/** One metadata call; null when the object is not there. */
async function find(name: string): Promise<Found | null> {
  try {
    const [m] = await storageAdmin().bucket().file(name).getMetadata();
    return {
      name,
      size: Number(m.size ?? 0),
      contentType: m.contentType || 'application/octet-stream',
    };
  } catch (e) {
    if ((e as { code?: number }).code === 404) return null;
    throw e;
  }
}

/** '/c/{cap}/a/b%20c.js' → 'a/b c.js'. null when a segment does not decode or smuggles a slash. */
function relativePath(c: C, cap: string): string | null {
  const path = new URL(c.req.url).pathname;
  const marker = `/c/${cap}`;
  const at = path.indexOf(marker);
  if (at < 0) return null;
  const rest = path.slice(at + marker.length);
  const segs: string[] = [];
  for (const raw of rest.split('/')) {
    if (!raw) continue;
    let s: string;
    try {
      s = decodeURIComponent(raw);
    } catch {
      return null;
    }
    // '%2F' would change the shape of the path after decoding.
    if (s.includes('/') || s.includes('\\')) return null;
    segs.push(s);
  }
  return segs.join('/');
}

async function resolve(cap: Capability, rel: string): Promise<Found | null> {
  if ('object' in cap) {
    // Only the two kinds of object a command ever mints a link for.
    if (!/^(files\/.+|source\/[A-Za-z0-9_-]+\.zip)$/.test(cap.object) || cap.object.includes('..'))
      return null;
    return find(`${artifactPrefix.storageAll(cap.artifactId)}${cap.object}`);
  }
  let file: string;
  try {
    file = artifactBuildFile(rel);
  } catch (e) {
    if (e instanceof ArtifactPathError) return null;
    throw e;
  }
  const root = artifactPrefix.storageBuild(cap.artifactId, cap.buildId);
  const hit = await find(`${root}/${file}`);
  if (hit) return hit;
  // §D2: a deep link that is not a file falls back to the app's index.html —
  // but a missing ASSET (it has an extension) is a real 404, or a typo in a
  // script path would be answered with HTML and fail somewhere stranger.
  const last = file.slice(file.lastIndexOf('/') + 1);
  if (last.includes('.')) return null;
  return find(`${root}/index.html`);
}

async function serve(c: C): Promise<Response> {
  const token = c.req.param('cap') ?? '';
  const verdict = verifyCapability(token, Date.now());
  if (!verdict.ok)
    return plain(
      403,
      verdict.reason === 'expired' ? 'This link has expired' : 'This link is not valid',
    );
  const rel = relativePath(c, token);
  if (rel === null) return plain(400, 'Bad path');
  const cap = verdict.cap;
  const found = await resolve(cap, rel);
  if (!found) return plain(404, 'Not found');

  const object = 'object' in cap ? cap.object : null;
  const range = parseRange(c.req.header('range'), found.size);
  if (c.req.header('range') && !range) return plain(416, 'Range not satisfiable');
  if (range && range.end - range.start + 1 > MAX_STREAM_BYTES)
    range.end = range.start + MAX_STREAM_BYTES - 1;
  const length = range ? range.end - range.start + 1 : found.size;
  const headers: Record<string, string> = {
    ...SECURITY,
    'content-type': found.contentType,
    'content-length': String(length),
    'accept-ranges': 'bytes',
    'cache-control': object === null ? BUILD_CACHE : OBJECT_CACHE,
    ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${found.size}` } : {}),
    // A source zip is something to save, never something to show.
    ...(object?.startsWith('source/') ? { 'content-disposition': 'attachment' } : {}),
  };
  if (c.req.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
  const node = storageAdmin()
    .bucket()
    .file(found.name)
    .createReadStream(range ? { start: range.start, end: range.end } : {});
  return new Response(Readable.toWeb(node) as ReadableStream, {
    status: range ? 206 : 200,
    headers,
  });
}

const content = door('content');

// A preflight has nothing to protect here (no credentials are ever used), so say yes.
content.options(
  '*',
  () =>
    new Response(null, {
      status: 204,
      headers: {
        ...SECURITY,
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        'access-control-allow-headers': '*',
        'access-control-max-age': '600',
      },
    }),
);

// '/c/{cap}' (no trailing path) and '/c/{cap}/…' are the same build root.
content.on(['GET', 'HEAD'], '/:cap', serve);
content.on(['GET', 'HEAD'], '/:cap/*', serve);

// Anything else under /c — another method, no capability — is simply not there.
content.all('*', () => plain(404, 'Not found'));
