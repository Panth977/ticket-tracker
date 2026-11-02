/**
 * The source of a build made outside the app. A classic build is compiled output, but
 * its publisher may keep a source zip beside it (artifactSourceUrl). This turns that zip
 * into files the Code tab can show. It came from somebody's folder, so it is bounded,
 * and anything that is not plain text stays out.
 */
import { unzipSync } from 'fflate';
import type { SourceFiles } from './build';

const MAX_FILES = 400;
const MAX_FILE_BYTES = 512 * 1024;
const NOT_SOURCE = /(^|\/)(node_modules|\.git|dist|build|\.svelte-kit|__MACOSX)\/|(^|\/)(\.DS_Store|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

export interface SourceView {
  files: SourceFiles;
  /** Files left out: binary, too large, or over the count. */
  skipped: number;
}

export function readSourceZip(zip: Uint8Array): SourceView {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries = unzipSync(zip, {
    filter: (f) => !f.name.endsWith('/') && !NOT_SOURCE.test(f.name) && f.originalSize <= MAX_FILE_BYTES,
  });
  const files: SourceFiles = {};
  let skipped = 0;
  for (const name of Object.keys(entries).sort()) {
    const bytes = entries[name]!;
    if (Object.keys(files).length >= MAX_FILES || bytes.includes(0)) {
      skipped++;
      continue;
    }
    try {
      files[`/${name.replace(/^\/+/, '')}`] = decoder.decode(bytes);
    } catch {
      skipped++;
    }
  }
  return { files, skipped };
}

/** The file a reader wants first. */
export function firstSourceFile(files: SourceFiles): string | undefined {
  const paths = Object.keys(files);
  const wanted = [/^\/(.*\/)?src\/(main|index|App)\.[a-z]+$/i, /^\/(main|index|App)\.[a-z]+$/i, /^\/(.*\/)?index\.html$/, /^\/README/i];
  for (const w of wanted) {
    const hit = paths.find((p) => w.test(p));
    if (hit) return hit;
  }
  return paths[0];
}
