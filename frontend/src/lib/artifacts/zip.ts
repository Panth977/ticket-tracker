/**
 * Publish-by-upload (docs/plan/artifacts.html §C3): a build is sent as ONE zip.
 * A picked .zip goes up as it is; a picked or dropped FOLDER is zipped here,
 * in the browser, so the server sees the same thing either way and runs the
 * same checks (§C1). This file is the pure part: choosing the entries and
 * checking the limits before a single byte is uploaded.
 */
import { zipSync, type Zippable } from 'fflate';
import { ARTIFACT_BUILD_MAX_BYTES, ARTIFACT_BUILD_MAX_FILES, artifactZipEntry } from '@tm/shared';

export interface FolderFile {
  /** Relative path inside the picked folder, '/'-separated ('dist/assets/app.js'). */
  path: string;
  bytes: Uint8Array;
}

export class BuildTooBig extends Error {}

/** Never part of a build, and the usual way a folder blows the limits. */
const SKIP = /(^|\/)(node_modules|\.git)\//;

/**
 * The paths that would go in the zip. Uses the server's own entry rule
 * (artifactZipEntry: no .DS_Store, no __MACOSX, nothing escaping the folder),
 * so what is refused there is refused here first.
 */
export function buildEntries<T extends { path: string }>(files: readonly T[]): T[] {
  const out: T[] = [];
  for (const f of files) {
    const path = artifactZipEntry(f.path);
    if (!path || SKIP.test(`${path}`)) continue;
    out.push({ ...f, path });
  }
  return out;
}

/** Why this set of files cannot be a build, or null. Sizes are the UNPACKED ones (§C1). */
export function buildProblem(files: readonly { path: string; size: number }[]): string | null {
  if (!files.length) return 'That folder has no files in it.';
  if (files.length > ARTIFACT_BUILD_MAX_FILES)
    return `A build may hold at most ${ARTIFACT_BUILD_MAX_FILES.toLocaleString()} files; this has ${files.length.toLocaleString()}. Pick the built folder (dist/), not the project.`;
  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (bytes > ARTIFACT_BUILD_MAX_BYTES)
    return `A build may be at most ${ARTIFACT_BUILD_MAX_BYTES / 1024 / 1024} MB unpacked; this is ${(bytes / 1024 / 1024).toFixed(1)} MB.`;
  // A single top folder is stripped by the server, so 'dist/index.html' counts.
  const hasIndex = files.some(
    (f) => f.path === 'index.html' || /^[^/]+\/index\.html$/.test(f.path),
  );
  if (!hasIndex) return 'There is no index.html at the top of that folder.';
  return null;
}

/** The folder as one zip (deflate). Throws BuildTooBig when buildProblem() would object. */
export function zipFolder(files: readonly FolderFile[]): Uint8Array {
  const entries = buildEntries(files);
  const problem = buildProblem(entries.map((f) => ({ path: f.path, size: f.bytes.length })));
  if (problem) throw new BuildTooBig(problem);
  const tree: Zippable = {};
  for (const f of entries) tree[f.path] = f.bytes;
  return zipSync(tree, { level: 6 });
}

/** A Storage-safe upload id for artifactPrefix.storageUpload (unguessable enough; swept after 24 h). */
export function newUploadId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '').slice(0, 20);
  return (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 20);
}
