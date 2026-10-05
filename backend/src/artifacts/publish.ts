/**
 * From "some files" to a BUILD in Storage (docs/plan/artifacts.html §C1).
 *
 * Two sources, one pipeline:
 *   a zip   (the app's Builds tab, REST, the SDK)   → planFromZip
 *   inline  (MCP artifact_publish: [{ path, content }])  → planFromInline
 * Both become a list of { path, size, read() } and everything after that is
 * shared, so an inline publish is checked exactly like a zipped one.
 *
 * finishPlan is the policy: a single top folder (a zipped `dist/`) is
 * stripped, an index.html must then sit at the root, no two files may claim
 * one path. storeBuild writes each file to
 * artifacts/{id}/builds/{buildId}/{path} with a content type chosen HERE, by
 * extension — never the one a client sent — because the /c route answers with
 * whatever is stored and `nosniff` makes that the final word.
 *
 * BUILDS ARE IMMUTABLE: a build id is fresh for every publish, its files are
 * written once and never overwritten, which is what lets the /c route say
 * `Cache-Control: immutable`.
 */
import {
  ARTIFACT_BUILD_MAX_BYTES,
  ARTIFACT_BUILD_MAX_FILES,
  ARTIFACT_INLINE_MAX_BYTES,
  ArtifactPathError,
  absoluteAssetWarning,
  artifactPrefix,
  artifactZipEntry,
  errors,
  stripSingleTopFolder,
  type ArtifactInlineFile,
} from '@tm/shared';
import { storageAdmin } from '../runtime/firebase.js';
import { openZip } from './unzip.js';

export interface BuildFile {
  path: string;
  size: number;
  read(): Promise<Buffer>;
}
export interface BuildPlan {
  files: BuildFile[];
  close(): void;
}

/** Longest path a build file may have — the /c route splits URLs with the same 1024 limit. */
const MAX_FILE_PATH = 900;
/** Files written to Storage at once: enough to publish 2,000 small files well inside the function's timeout. */
const WRITE_CONCURRENCY = 12;

const TEXT = '; charset=utf-8';
/**
 * Extension → Content-Type. Browsers REFUSE a module script or a stylesheet
 * served with the wrong type under nosniff, so the ones a build is made of
 * are spelled out; anything unknown is octet-stream, which downloads instead
 * of running.
 */
const TYPES: Record<string, string> = {
  html: `text/html${TEXT}`,
  htm: `text/html${TEXT}`,
  js: `text/javascript${TEXT}`,
  mjs: `text/javascript${TEXT}`,
  cjs: `text/javascript${TEXT}`,
  css: `text/css${TEXT}`,
  json: `application/json${TEXT}`,
  map: `application/json${TEXT}`,
  webmanifest: `application/manifest+json${TEXT}`,
  txt: `text/plain${TEXT}`,
  md: `text/markdown${TEXT}`,
  csv: `text/csv${TEXT}`,
  xml: `application/xml${TEXT}`,
  svg: 'image/svg+xml',
  wasm: 'application/wasm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

export function contentTypeFor(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return TYPES[ext] ?? 'application/octet-stream';
}

export const BUILD_LIMITS = {
  maxBytes: ARTIFACT_BUILD_MAX_BYTES,
  maxFiles: ARTIFACT_BUILD_MAX_FILES,
};

/** A zip already in memory → its files (nothing inflated yet). */
export async function planFromZip(zip: Buffer): Promise<BuildPlan> {
  return openZip(zip, BUILD_LIMITS);
}

/** MCP's inline files. Same name rules as a zip entry; at most ARTIFACT_INLINE_MAX_BYTES decoded. */
export function planFromInline(inline: readonly ArtifactInlineFile[]): BuildPlan {
  const files: BuildFile[] = [];
  let total = 0;
  for (const f of inline) {
    let path: string | null;
    try {
      path = artifactZipEntry(f.path);
    } catch (e) {
      if (e instanceof ArtifactPathError) throw errors.invalid(e.message, { field: 'files' });
      throw e;
    }
    if (path === null) continue;
    if (f.encoding === 'base64' && !/^[A-Za-z0-9+/_-]*={0,2}$/.test(f.content))
      throw errors.invalid(`${f.path}: content is not base64`, { field: 'files' });
    const data = Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8');
    total += data.length;
    if (total > ARTIFACT_INLINE_MAX_BYTES)
      throw errors.too_large(
        `Inline files are limited to ${ARTIFACT_INLINE_MAX_BYTES / 1024 / 1024} MB in one call — publish a zip instead`,
      );
    files.push({ path, size: data.length, read: async () => data });
  }
  return { files, close: () => {} };
}

/**
 * The shape every build must have, whatever it came from. Returns the files
 * under their FINAL paths.
 */
export function finishPlan(files: readonly BuildFile[]): BuildFile[] {
  if (files.length === 0) throw errors.invalid('The build is empty');
  if (files.length > ARTIFACT_BUILD_MAX_FILES)
    throw errors.too_large(`A build has at most ${ARTIFACT_BUILD_MAX_FILES} files`);
  const paths = stripSingleTopFolder(files.map((f) => f.path));
  const seen = new Set<string>();
  const out = files.map((f, i) => {
    const path = paths[i]!;
    if (path.length > MAX_FILE_PATH) throw errors.invalid(`Path too long in the build: ${path}`);
    if (seen.has(path)) throw errors.invalid(`Two files in the build have the path ${path}`);
    seen.add(path);
    return { ...f, path };
  });
  if (!seen.has('index.html'))
    throw errors.invalid(
      'A build needs an index.html at its root (or inside a single top folder, which is stripped)',
    );
  const bytes = out.reduce((n, f) => n + f.size, 0);
  if (bytes > ARTIFACT_BUILD_MAX_BYTES)
    throw errors.too_large(
      `A build is at most ${ARTIFACT_BUILD_MAX_BYTES / 1024 / 1024} MB unpacked`,
    );
  return out;
}

export interface StoredBuild {
  files: number;
  bytes: number;
  warnings: string[];
}

/**
 * Write the files of one build. Reads and writes a few at a time so a large
 * build never has more than a handful of files in memory. Throws the first
 * failure once every write has settled — the caller then removes the
 * half-written prefix.
 */
export async function storeBuild(
  artifactId: string,
  buildId: string,
  files: readonly BuildFile[],
): Promise<StoredBuild> {
  const bucket = storageAdmin().bucket();
  const prefix = artifactPrefix.storageBuild(artifactId, buildId);
  const warnings: string[] = [];
  let bytes = 0;
  let next = 0;
  let failed = false;
  const worker = async () => {
    for (;;) {
      // One worker failing stops the others from STARTING another file.
      const f = failed ? undefined : files[next++];
      if (!f) return;
      const data = await f.read();
      bytes += data.length;
      if (bytes > ARTIFACT_BUILD_MAX_BYTES)
        throw errors.too_large(
          `A build is at most ${ARTIFACT_BUILD_MAX_BYTES / 1024 / 1024} MB unpacked`,
        );
      if (f.path === 'index.html') {
        const w = absoluteAssetWarning(data.toString('utf8'));
        if (w) warnings.push(w);
      }
      // No download token (unlike adapters/files.ts write): a build file is
      // only ever reached through the /c route, never by a Storage URL.
      await bucket
        .file(`${prefix}/${f.path}`)
        .save(data, { contentType: contentTypeFor(f.path), resumable: false });
    }
  };
  // allSettled, not all: the caller deletes the half-written prefix when this
  // throws, and a write still in flight at that moment would land AFTER the
  // cleanup and stay behind. So every worker is waited for, then the first
  // failure is reported.
  const done = await Promise.allSettled(
    Array.from({ length: Math.min(WRITE_CONCURRENCY, files.length) }, () =>
      worker().catch((e: unknown) => {
        failed = true;
        throw e;
      }),
    ),
  );
  const bad = done.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (bad) throw bad.reason;
  return { files: files.length, bytes, warnings };
}

/** uploads/{uploadId}.zip of THIS artifact — the only place a publish may read a zip from. */
export function assertUploadPath(artifactId: string, path: string, field: string): void {
  const prefix = artifactPrefix.storageUploads(artifactId);
  if (!path.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,64}\.zip$/.test(path.slice(prefix.length)))
    throw errors.invalid(`${field} must be a zip under ${prefix}`, { field });
}
