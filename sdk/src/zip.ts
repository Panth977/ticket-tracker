/**
 * A zip WRITER, and the directory walk that feeds it — what `tm.artifacts.publish()`
 * needs to turn a build folder into the one body `POST /v1/artifacts/{id}/builds`
 * takes (docs/plan/artifacts.html §C1, §C2).
 *
 * Written here, in ~150 lines, rather than imported: this package has no
 * dependencies and build.mjs refuses any (the declaration file must be flat,
 * and a URL import must be one file). A writer is the easy half of zip — the
 * server's READER (backend/artifacts/unzip.ts) is the half that has to
 * distrust its input, and it accepts exactly what this emits: method 0
 * (store) or 8 (deflate), UTF-8 names, sizes and CRC in the local header (no
 * data descriptors), no zip64, no symlinks, no directories.
 *
 *  · DEFLATE comes from the runtime's own CompressionStream('deflate-raw')
 *    (Node 20.12+, Deno, Bun, every current browser). Where it is missing an
 *    entry is simply stored — a larger upload, never a failure.
 *  · DETERMINISTIC: entries are sorted by path and stamped 1980-01-01, so the
 *    same folder gives the same bytes on the same runtime, and a retried
 *    publish is byte-for-byte the request it retries.
 *  · THE FILE SYSTEM IS OPTIONAL. `node:fs/promises` is imported lazily, by a
 *    name no bundler can see, and only when a caller passes a directory path.
 *    The browser bundle therefore carries no reference to it; there, publish
 *    takes zip bytes or a list of files instead.
 */
import { TmError } from './errors.js';

/** One file going into a zip. `path` is relative to the zip's root, with forward slashes. */
export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
}

// ───────────────────────── bytes ─────────────────────────

const ZIP_CRC_TABLE = ((): Int32Array => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

/** CRC-32 (IEEE), as every zip header carries it. */
export function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = ZIP_CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const B64_VALUES = ((): Int16Array => {
  const t = new Int16Array(128).fill(-1);
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < abc.length; i++) t[abc.charCodeAt(i)] = i;
  // base64url too: a model asked for base64 sometimes answers with this.
  t['-'.charCodeAt(0)] = 62;
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

/** base64 → bytes, without Buffer or atob, so it is the same everywhere (the inverse of `toBase64`). */
export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[\s=]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_VALUES[clean.charCodeAt(i)] ?? -1;
    if (v < 0) throw new TypeError(`Not base64: unexpected character at ${i}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

/** Does this start like a zip? (`PK\x03\x04`, or `PK\x05\x06` for an empty one.) */
export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
  );
}

/**
 * 'a\\b', './a/b' and '/a/b' → 'a/b'. Throws on what the server would refuse
 * anyway ('..', an empty name), so the mistake is named before an upload.
 */
export function zipPath(raw: string): string {
  const parts = String(raw)
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p !== '' && p !== '.');
  if (!parts.length) throw new TypeError(`Not a file path: '${raw}'`);
  if (parts.includes('..')) throw new TypeError(`A path may not contain '..': '${raw}'`);
  return parts.join('/');
}

/**
 * Raw deflate through the runtime's CompressionStream, or null where there is
 * none (or it does not know 'deflate-raw' — Node before 20.12).
 */
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  const CS = (
    globalThis as {
      CompressionStream?: new (format: string) => {
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
      };
    }
  ).CompressionStream;
  if (!CS || typeof Blob === 'undefined' || typeof Response === 'undefined') return null;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CS('deflate-raw') as never);
    return new Uint8Array(await new Response(stream as ReadableStream<Uint8Array>).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Zip `entries` in memory. Paths are normalised (`zipPath`) and sorted; two
 * entries with the same path are a TypeError rather than a silent overwrite.
 * `compress: false` stores everything (already-compressed assets, or a test
 * that wants bytes it can predict).
 */
export async function zipFiles(
  entries: readonly ZipEntry[],
  opts: { compress?: boolean } = {},
): Promise<Uint8Array> {
  const files = entries
    .map((e) => ({ path: zipPath(e.path), bytes: e.bytes }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (let i = 1; i < files.length; i++)
    if (files[i]!.path === files[i - 1]!.path)
      throw new TypeError(`Two files share the path '${files[i]!.path}'`);
  if (files.length > 0xffff) throw new TypeError('Too many files for one zip (65,535 at most)');

  const enc = new TextEncoder();
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01: see DETERMINISTIC above
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.path);
    const crc = crc32(f.bytes);
    // Deflate only when it actually helps: a PNG or a .woff2 comes out larger.
    const packed = opts.compress === false || f.bytes.length === 0 ? null : await deflateRaw(f.bytes);
    const deflated = packed !== null && packed.length < f.bytes.length;
    const data = deflated ? packed : f.bytes;
    const method = deflated ? 8 : 0;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true); // version needed: 2.0 (deflate)
    lh.setUint16(6, 0x0800, true); // UTF-8 names
    lh.setUint16(8, method, true);
    lh.setUint16(10, 0, true); // 00:00:00
    lh.setUint16(12, DOS_DATE, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, f.bytes.length, true);
    lh.setUint16(26, name.length, true);
    local.push(new Uint8Array(lh.buffer), name, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, (3 << 8) | 20, true); // made by: unix, so the mode below is read
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, method, true);
    ch.setUint16(12, 0, true);
    ch.setUint16(14, DOS_DATE, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, f.bytes.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(38, (0o100644 << 16) >>> 0, true); // a regular file, never a link
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }

  const centralSize = central.reduce((n, b) => n + b.length, 0);
  if (offset + centralSize > 0xffffffff) throw new TypeError('Too large for one zip (4 GB at most)');
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...local, ...central, new Uint8Array(end.buffer)]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ───────────────────────── the file system (Node, Deno, Bun) ─────────────────────────

/** The little of `node:fs/promises` a directory walk needs — spelled out so the shipped types need no @types/node. */
interface ZipFs {
  readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<
    { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }[]
  >;
  readFile(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<{ size: number; isDirectory(): boolean; isFile(): boolean }>;
  realpath(path: string): Promise<string>;
}

/**
 * `node:fs/promises`, imported when (and only when) somebody passes a path.
 * The specifier is a variable on purpose: esbuild, Vite and webpack resolve
 * only literal specifiers, so the browser bundle neither fails on this nor
 * ships a polyfill for it.
 */
async function zipFs(what: string): Promise<ZipFs> {
  const spec = 'node:fs/promises';
  try {
    return (await import(/* @vite-ignore */ /* webpackIgnore: true */ spec)) as ZipFs;
  } catch (e) {
    throw new TmError({
      code: 'invalid',
      status: 0,
      message: `${what}: a directory path needs a file system (Node, Deno or Bun). In a browser pass zip bytes, a Blob, or a list of { path, content } files`,
      cause: e,
    });
  }
}

export interface ReadDirectoryOptions {
  /** Directory NAMES skipped at any depth (`node_modules`). */
  skipDirs?: readonly string[];
  /** Skip a file: called with its name and its zip path. */
  skipFile?: (name: string, path: string) => boolean;
  /** Skip files larger than this. */
  maxFileBytes?: number;
  /** Skip these directories wherever they are, by real path (the build folder inside its own source). */
  skipRealPaths?: readonly string[];
}

/**
 * Every file under `dir`, as zip entries sorted by path. Symbolic links to
 * FILES are read like files (the build gets the content — the server refuses
 * a link); links to DIRECTORIES are skipped, so a link back up the tree
 * cannot loop.
 */
export async function readDirectory(
  dir: string,
  opts: ReadDirectoryOptions = {},
  what = 'readDirectory',
): Promise<ZipEntry[]> {
  const fs = await zipFs(what);
  const root = dir.replace(/[\\/]+$/, '') || dir;
  let top;
  try {
    top = await fs.stat(root);
  } catch (e) {
    throw new TypeError(`${what}: cannot read '${dir}' (${(e as Error)?.message ?? e})`, { cause: e });
  }
  if (!top.isDirectory()) throw new TypeError(`${what}: '${dir}' is not a directory`);

  const skipDirs = new Set(opts.skipDirs ?? []);
  const skipReal = new Set(opts.skipRealPaths ?? []);
  const out: ZipEntry[] = [];

  const walk = async (abs: string, rel: string): Promise<void> => {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const p = `${abs}/${e.name}`;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        if (skipReal.size && skipReal.has(await fs.realpath(p).catch(() => p))) continue;
        await walk(p, r);
        continue;
      }
      // A link: follow it to a file, never into a directory. A dangling one is skipped.
      const st = e.isSymbolicLink() ? await fs.stat(p).catch(() => null) : null;
      if (e.isSymbolicLink() ? !st?.isFile() : !e.isFile()) continue;
      if (opts.skipFile?.(e.name, r)) continue;
      if (opts.maxFileBytes !== undefined) {
        const size = (st ?? (await fs.stat(p))).size;
        if (size > opts.maxFileBytes) continue;
      }
      out.push({ path: r, bytes: await fs.readFile(p) });
    }
  };
  await walk(root, '');
  return out;
}

/** The real path of a directory, or null where there is no file system or no such directory. */
export async function realPathOrNull(dir: string): Promise<string | null> {
  try {
    return await (await zipFs('realpath')).realpath(dir);
  } catch {
    return null;
  }
}
