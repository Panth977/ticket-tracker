/**
 * Reading an uploaded build zip (docs/plan/artifacts.html §C1) — somebody
 * else's bytes, so nothing about them is believed:
 *
 *   the CENTRAL DIRECTORY is read first, without inflating anything: names,
 *     declared sizes, the symlink bit. A zip that declares too many files or
 *     too many bytes is refused before a single byte is unpacked;
 *   each file is then INFLATED AS A STREAM with a byte counter. A zip that
 *     lies about its sizes (the zip bomb: 1 KB declared, 1 GB inflated) is cut
 *     off the moment it goes over — by yauzl, which checks every entry against
 *     its declared size, and by the counter here, which does not trust that
 *     either;
 *   NAMES go through artifactZipEntry (shared): absolute paths, drive letters
 *     and '..' throw, so no entry can land outside the build's folder
 *     (zip-slip). yauzl refuses the same names itself; both are kept.
 *   SYMLINKS are refused outright: a link's "content" is a path, and a build
 *     has no business pointing anywhere.
 *   ENCRYPTED entries and compression methods other than store / deflate are
 *     refused (yauzl cannot read them, and nothing legitimate needs them).
 *
 * yauzl because it is the reader written for exactly this threat model, has
 * no dependencies that matter, and reads from the buffer we already hold. The
 * zip itself is at most ARTIFACT_ZIP_MAX_BYTES, so holding it is fine; what
 * is never held is more than the limit of UNPACKED bytes.
 */
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { ArtifactPathError, artifactZipEntry, errors } from '@tm/shared';

export interface ZipLimits {
  /** Total unpacked bytes across the files that are kept. */
  maxBytes: number;
  /** Files that are kept (directories, __MACOSX and .DS_Store do not count). */
  maxFiles: number;
}

export interface ZippedFile {
  /** Build-relative, already through artifactZipEntry. */
  path: string;
  /** Declared unpacked size — checked again while reading. */
  size: number;
  /** Inflate this one file. Rejects with too_large the moment it exceeds what is left. */
  read(): Promise<Buffer>;
}

export interface OpenedZip {
  files: ZippedFile[];
  /** Release the reader. Safe to call twice. */
  close(): void;
}

/** Unix file type bits, in the high 16 bits of externalFileAttributes. */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
/**
 * Raw entries we are willing to even LOOK at: directories and macOS metadata
 * are entries too, so this is looser than maxFiles — but bounded, so a zip of
 * a million empty names cannot make us loop.
 */
const RAW_ENTRY_FACTOR = 4;

const notAZip = (e: unknown) =>
  errors.invalid(`That is not a zip we can read: ${e instanceof Error ? e.message : String(e)}`);

function open(buf: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buf,
      // lazyEntries: we pull entries one at a time. validateEntrySizes (the
      // default, stated here because it is load-bearing): a stream that
      // inflates past its declared size is an error, not more data.
      // autoClose off: the directory is read to its end FIRST and the files
      // are opened afterwards, which a reader that closed itself would refuse.
      {
        lazyEntries: true,
        autoClose: false,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: false,
      },
      (err, zip) => (err || !zip ? reject(notAZip(err)) : resolve(zip)),
    );
  });
}

/** Every entry of the central directory, in order. */
function entries(zip: ZipFile, max: number): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const out: Entry[] = [];
    zip.on('entry', (e: Entry) => {
      out.push(e);
      if (out.length > max) return reject(errors.too_large('Too many entries in the zip'));
      zip.readEntry();
    });
    zip.once('end', () => resolve(out));
    // A name yauzl refuses ('..', absolute) arrives here, as does a broken directory.
    zip.once('error', (e) => reject(notAZip(e)));
    zip.readEntry();
  });
}

function inflate(zip: ZipFile, entry: Entry, budget: { left: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(notAZip(err));
      const chunks: Buffer[] = [];
      let n = 0;
      stream.on('data', (c: Buffer) => {
        n += c.length;
        budget.left -= c.length;
        if (n > entry.uncompressedSize || budget.left < 0) {
          stream.destroy();
          return reject(errors.too_large('The zip unpacks to more than it declares — refused'));
        }
        chunks.push(c);
      });
      stream.once('end', () => resolve(Buffer.concat(chunks, n)));
      stream.once('error', (e) => reject(notAZip(e)));
    });
  });
}

/**
 * Open a zip and list the files it would contribute to a build, refusing
 * anything the header comment lists. Nothing is inflated until `read()`.
 */
export async function openZip(buf: Buffer, limits: ZipLimits): Promise<OpenedZip> {
  const zip = await open(buf);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    zip.close();
  };
  try {
    if (zip.entryCount > limits.maxFiles * RAW_ENTRY_FACTOR)
      throw errors.too_large(`A build has at most ${limits.maxFiles} files`);
    const raw = await entries(zip, limits.maxFiles * RAW_ENTRY_FACTOR);
    const budget = { left: limits.maxBytes };
    const files: ZippedFile[] = [];
    let declared = 0;
    for (const e of raw) {
      let path: string | null;
      try {
        path = artifactZipEntry(e.fileName);
      } catch (err) {
        if (err instanceof ArtifactPathError) throw errors.invalid(err.message);
        throw err;
      }
      if (path === null) continue; // a directory, __MACOSX, .DS_Store
      if (((e.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK)
        throw errors.invalid(`Symlinks are not allowed in a build: ${e.fileName}`);
      if (e.isEncrypted()) throw errors.invalid(`Encrypted entry in the zip: ${e.fileName}`);
      if (e.compressionMethod !== 0 && e.compressionMethod !== 8)
        throw errors.invalid(`Unsupported compression in the zip: ${e.fileName}`);
      declared += e.uncompressedSize;
      if (declared > limits.maxBytes)
        throw errors.too_large(
          `A build is at most ${Math.round(limits.maxBytes / 1024 / 1024)} MB unpacked`,
        );
      files.push({ path, size: e.uncompressedSize, read: () => inflate(zip, e, budget) });
      if (files.length > limits.maxFiles)
        throw errors.too_large(`A build has at most ${limits.maxFiles} files`);
    }
    return { files, close };
  } catch (e) {
    close();
    throw e;
  }
}
