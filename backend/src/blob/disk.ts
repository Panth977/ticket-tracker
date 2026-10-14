/**
 * The disk adapter (TM_BLOB=disk): objects are files under TM_BLOB_DIR
 * (default $TM_DATA_DIR/blobs).
 *
 *   <dir>/<bucket>/o/<object path>         the bytes
 *   <dir>/<bucket>/m/<object path>.json    { contentType, size, timeCreated,
 *                                            updated, metadata }
 *
 * SIGNED URLS are this server's own: /blob/{read|write}/{bucket}/{path}?
 * exp=…&ct=…&sig=… — an HMAC over the purpose, the bucket, the path, the
 * expiry and (for writes) the content type, with the server's signing key.
 * doors/blob.ts serves them (GET with Range, PUT to upload). The public
 * origin is API_URL (else APP_URL).
 *
 * Every write (save, copy, a signed PUT) announces a FINALIZE event — the
 * same event Cloud Storage delivers to onAttachmentFinalized.
 */
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { serverMac } from '../platform/crypto.js';
import { dataDir } from '../runtime/platform.js';
import type {
  BlobAdapter,
  BlobFile,
  Bucket,
  FinalizedObject,
  GetFilesOptions,
  ObjectMetadata,
  SaveOptions,
  SignedUrlConfig,
} from './types.js';

export const DEFAULT_BUCKET = 'default';

/** An error shaped like the Cloud Storage client's (callers test `code === 404`). */
export class BlobError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'BlobError';
  }
}

interface StoredMeta {
  contentType: string;
  size: number;
  generation?: string;
  timeCreated: string;
  updated: string;
  metadata?: Record<string, string>;
}

export type FinalizeListener = (obj: FinalizedObject) => void;
const listeners = new Set<FinalizeListener>();

/** Listen to every object written through this adapter. Returns the unsubscribe. */
export function onFinalize(listener: FinalizeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function announce(obj: FinalizedObject): void {
  for (const l of listeners) {
    try {
      l(obj);
    } catch (e) {
      console.error('[blob] finalize listener failed', e);
    }
  }
}

function blobDir(): string {
  return process.env.TM_BLOB_DIR || join(dataDir(), 'blobs');
}

/** Refuse names that would escape the bucket directory. */
function checkName(name: string): string {
  if (
    !name ||
    name.startsWith('/') ||
    name.includes('\0') ||
    name.split('/').some((s) => s === '..' || s === '.')
  )
    throw new BlobError(400, `Invalid object name: ${JSON.stringify(name)}`);
  return name;
}

function expiresMs(e: SignedUrlConfig['expires']): number {
  return typeof e === 'number' ? e : e instanceof Date ? e.getTime() : Date.parse(e);
}

/** What a signature covers. */
export function blobSignature(
  op: 'read' | 'write',
  bucket: string,
  name: string,
  exp: number,
  contentType = '',
): string {
  return serverMac('blob-url', [op, bucket, name, String(exp), contentType].join('\n'));
}

function publicBase(): string {
  return (process.env.API_URL || process.env.APP_URL || 'http://localhost:8080').replace(
    /\/+$/,
    '',
  );
}

const encodePath = (name: string) => name.split('/').map(encodeURIComponent).join('/');

class DiskFile implements BlobFile {
  metadata: ObjectMetadata = {};
  constructor(
    readonly bucket: DiskBucket,
    readonly name: string,
  ) {
    checkName(name);
  }
  private get dataPath(): string {
    return join(this.bucket.root, 'o', ...this.name.split('/'));
  }
  private get metaPath(): string {
    return `${join(this.bucket.root, 'm', ...this.name.split('/'))}.json`;
  }
  private notFound(): BlobError {
    return new BlobError(404, `No such object: ${this.bucket.name}/${this.name}`);
  }
  private async readMeta(): Promise<StoredMeta | null> {
    try {
      return JSON.parse(await readFile(this.metaPath, 'utf8')) as StoredMeta;
    } catch {
      try {
        const s = await stat(this.dataPath);
        const t = s.mtime.toISOString();
        return {
          contentType: 'application/octet-stream',
          size: s.size,
          timeCreated: t,
          updated: t,
        };
      } catch {
        return null;
      }
    }
  }
  private static toPublic(name: string, m: StoredMeta): ObjectMetadata {
    return {
      name,
      size: String(m.size),
      contentType: m.contentType,
      timeCreated: m.timeCreated,
      updated: m.updated,
      ...(m.generation ? { generation: m.generation } : {}),
      ...(m.metadata ? { metadata: m.metadata } : {}),
    };
  }
  /** @internal getFiles() fills the metadata in. */
  async load(): Promise<this> {
    const m = await this.readMeta();
    if (m) this.metadata = DiskFile.toPublic(this.name, m);
    return this;
  }

  async exists(): Promise<[boolean]> {
    try {
      await stat(this.dataPath);
      return [true];
    } catch {
      return [false];
    }
  }
  async getMetadata(): Promise<[ObjectMetadata]> {
    if (!(await this.exists())[0]) throw this.notFound();
    const m = await this.readMeta();
    this.metadata = DiskFile.toPublic(this.name, m!);
    return [this.metadata];
  }
  async setMetadata(
    patch: { metadata?: Record<string, string | null> } & Record<string, unknown>,
  ): Promise<[ObjectMetadata]> {
    const m = await this.readMeta();
    if (!m || !(await this.exists())[0]) throw this.notFound();
    const custom = { ...(m.metadata ?? {}) };
    for (const [k, v] of Object.entries(patch.metadata ?? {})) {
      if (v === null) delete custom[k];
      else custom[k] = String(v);
    }
    const next: StoredMeta = {
      ...m,
      ...(typeof patch.contentType === 'string' ? { contentType: patch.contentType } : {}),
      metadata: custom,
      updated: new Date().toISOString(),
    };
    await this.writeMeta(next);
    this.metadata = DiskFile.toPublic(this.name, next);
    return [this.metadata];
  }
  private async writeMeta(m: StoredMeta): Promise<void> {
    await mkdir(dirname(this.metaPath), { recursive: true });
    await writeFile(this.metaPath, JSON.stringify(m));
  }
  async download(): Promise<[Buffer]> {
    try {
      return [await readFile(this.dataPath)];
    } catch {
      throw this.notFound();
    }
  }
  async save(data: Buffer | Uint8Array | string, options: SaveOptions = {}): Promise<void> {
    return this.bucket.locked(this.name, () => this.saveNow(data, options));
  }
  private async saveNow(data: Buffer | Uint8Array | string, options: SaveOptions): Promise<void> {
    const want = options.preconditionOpts?.ifGenerationMatch;
    if (want !== undefined) {
      const cur = (await this.exists())[0] ? await this.readMeta() : null;
      if (!cur || String(cur.generation ?? '') !== String(want))
        throw new BlobError(
          412,
          `Precondition failed: ${this.bucket.name}/${this.name} is not generation ${want}`,
        );
    }
    const buf =
      typeof data === 'string'
        ? Buffer.from(data)
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await mkdir(dirname(this.dataPath), { recursive: true });
    const tmp = `${this.dataPath}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, buf);
    const now = new Date().toISOString();
    const custom = options.metadata?.metadata;
    const m: StoredMeta = {
      contentType:
        options.contentType ??
        (options.metadata?.contentType as string | undefined) ??
        'application/octet-stream',
      size: buf.byteLength,
      // A rewrite is a new object (a new generation), as in Cloud Storage.
      generation: nextGeneration(),
      timeCreated: now,
      updated: now,
      ...(custom
        ? { metadata: Object.fromEntries(Object.entries(custom).map(([k, v]) => [k, String(v)])) }
        : {}),
    };
    await rename(tmp, this.dataPath);
    await this.writeMeta(m);
    this.metadata = DiskFile.toPublic(this.name, m);
    this.bucket.finalized(this.name, m);
  }
  async delete(options: { ignoreNotFound?: boolean } = {}): Promise<void> {
    return this.bucket.locked(this.name, () => this.deleteNow(options));
  }
  private async deleteNow(options: { ignoreNotFound?: boolean }): Promise<void> {
    if (!(await this.exists())[0]) {
      if (options.ignoreNotFound) return;
      throw this.notFound();
    }
    await rm(this.dataPath, { force: true });
    await rm(this.metaPath, { force: true });
  }
  async copy(destination: BlobFile): Promise<void> {
    const dest = destination as DiskFile;
    if (!(await this.exists())[0]) throw this.notFound();
    const m = (await this.readMeta())!;
    await mkdir(dirname(dest.dataPath), { recursive: true });
    await copyFile(this.dataPath, dest.dataPath);
    const now = new Date().toISOString();
    const next = { ...m, generation: nextGeneration(), timeCreated: now, updated: now };
    await dest.writeMeta(next);
    dest.metadata = DiskFile.toPublic(dest.name, next);
    dest.bucket.finalized(dest.name, next);
  }
  createReadStream(options: { start?: number; end?: number } = {}): Readable {
    const s = createReadStream(this.dataPath, { start: options.start, end: options.end });
    // Same error shape as the Cloud Storage client on a missing object.
    s.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') (e as unknown as { code: number }).code = 404;
    });
    return s;
  }
  async getSignedUrl(config: SignedUrlConfig): Promise<[string]> {
    const exp = expiresMs(config.expires);
    if (!Number.isFinite(exp)) throw new BlobError(400, 'Invalid expiry for a signed URL');
    const ct = config.action === 'write' ? (config.contentType ?? '') : '';
    const sig = blobSignature(config.action, this.bucket.name, this.name, exp, ct);
    const q = new URLSearchParams({ exp: String(exp), sig, ...(ct ? { ct } : {}) });
    return [
      `${publicBase()}/blob/${config.action}/${encodeURIComponent(this.bucket.name)}/${encodePath(this.name)}?${q}`,
    ];
  }
}

/** Unique and increasing: epoch µs-ish plus a counter (Cloud Storage's are µs timestamps). */
let genSeq = 0;
function nextGeneration(): string {
  genSeq = (genSeq + 1) % 1000;
  return `${Date.now()}${String(genSeq).padStart(3, '0')}`;
}

/** Writes to one object never interleave (a precondition check + write is atomic here). */
const pathLocks = new Map<string, Promise<unknown>>();

class DiskBucket implements Bucket {
  readonly root: string;
  /** @internal Run fn alone on this object. */
  locked<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const key = `${this.root}\0${name}`;
    const prev = pathLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    pathLocks.set(key, tail);
    void tail.then(() => {
      if (pathLocks.get(key) === tail) pathLocks.delete(key);
    });
    return run;
  }
  constructor(readonly name: string) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..')
      throw new BlobError(400, `Invalid bucket name: ${name}`);
    this.root = join(blobDir(), name);
  }
  file(name: string): DiskFile {
    return new DiskFile(this, name);
  }
  /** Every object name under the bucket, sorted, that starts with `prefix`. */
  private async names(prefix = ''): Promise<string[]> {
    const base = join(this.root, 'o');
    // Start at the deepest directory the prefix names fully.
    const dirPart = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';
    const out: string[] = [];
    const walk = async (rel: string) => {
      let entries;
      try {
        entries = await readdir(join(base, ...rel.split('/').filter(Boolean)), {
          withFileTypes: true,
        });
      } catch {
        return;
      }
      for (const e of entries) {
        const name = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (
            prefix.startsWith(`${name}/`) ||
            name.startsWith(prefix) ||
            `${name}/`.startsWith(prefix)
          )
            await walk(name);
        } else if (!e.name.endsWith('.tmp') && name.startsWith(prefix)) out.push(name);
      }
    };
    await walk(dirPart);
    return out.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  }
  async getFiles(options: GetFilesOptions = {}): Promise<[DiskFile[]]> {
    let names = await this.names(options.prefix ?? '');
    if (options.maxResults !== undefined) names = names.slice(0, options.maxResults);
    return [await Promise.all(names.map((n) => this.file(n).load()))];
  }
  async deleteFiles(options: { prefix?: string } = {}): Promise<void> {
    for (const n of await this.names(options.prefix ?? ''))
      await this.file(n).delete({ ignoreNotFound: true });
  }
  /** @internal */
  finalized(name: string, m: StoredMeta): void {
    announce({
      bucket: this.name,
      name,
      ...(m.generation ? { generation: m.generation } : {}),
      contentType: m.contentType,
      size: String(m.size),
      ...(m.metadata ? { metadata: m.metadata } : {}),
    });
  }
}

export const diskAdapter: BlobAdapter = {
  name: 'disk',
  bucket: (name?: string) => new DiskBucket(name || DEFAULT_BUCKET),
};

/** Wipe every bucket (tests). */
export async function wipeDisk(): Promise<void> {
  await rm(blobDir(), { recursive: true, force: true });
}
