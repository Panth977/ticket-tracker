/**
 * THE FENCE (docs/plan/artifacts.html §E2, §E4). An artifact names paths in
 * its OWN view ('/my/doc'); these functions turn that into the real location
 * under its prefix, and refuse anything that could step outside it.
 *
 * The rules are the real boundary — this is the first one, and the one that
 * decides what a well-behaved broker ever sends. Every function throws
 * ArtifactPathError; nothing here returns a path it did not build itself.
 */

export class ArtifactPathError extends Error {
  readonly code = 'invalid-argument';
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactPathError';
  }
}

/** Longest path an artifact may name, in characters (after normalising). */
export const ARTIFACT_PATH_MAX = 1024;
const SEGMENT_MAX = 256;
/** Firestore forbids these ids; RTDB forbids . $ # [ ] / and control chars in keys. */
const FIRESTORE_BAD_SEGMENT = /^__.*__$/;
// eslint-disable-next-line no-control-regex -- key rules: control characters are exactly what is refused
const RTDB_BAD_CHARS = /[.$#[\]\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- as above
const STORAGE_BAD_CHARS = /[\u0000-\u001f\u007f#[\]*?]/;

/**
 * '/my/doc', 'my/doc', 'my//doc/' → ['my', 'doc']. '' and '/' → [] (the root).
 * Refuses '.', '..', over-long paths and segments, and non-strings.
 */
export function splitArtifactPath(path: unknown): string[] {
  if (typeof path !== 'string') throw new ArtifactPathError('A path must be a string');
  if (path.length > ARTIFACT_PATH_MAX) throw new ArtifactPathError('Path too long');
  const segs = path.split('/').filter((s) => s.length > 0);
  for (const s of segs) {
    if (s === '.' || s === '..')
      throw new ArtifactPathError("'.' and '..' are not allowed in a path");
    if (s.length > SEGMENT_MAX) throw new ArtifactPathError('Path segment too long');
  }
  return segs;
}

/** The artifact-side prefixes, exposed for rules tests and the Data tab. */
export const artifactPrefix = {
  firestore: (artifactId: string) => `artifacts/${artifactId}/db/data`,
  kv: (artifactId: string, uid: string) => `artifacts/${artifactId}/viewers/${uid}/kv`,
  rtdb: (artifactId: string) => `artifactData/${artifactId}`,
  rtdbReaders: (artifactId: string) => `artifactReaders/${artifactId}`,
  /**
   * { readOnly, archived } mirrored from the artifact document for the RTDB
   * rules (they cannot read Firestore, and a viewer's write depends on both).
   * Server-only, like artifactReaders.
   */
  rtdbFlags: (artifactId: string) => `artifactFlags/${artifactId}`,
  /** Everything the artifact owns in Storage: builds, source, files, uploads. Ends with '/'. */
  storageAll: (artifactId: string) => `artifacts/${artifactId}/`,
  storageUploads: (artifactId: string) => `artifacts/${artifactId}/uploads/`,
  storageFiles: (artifactId: string) => `artifacts/${artifactId}/files`,
  storageBuild: (artifactId: string, buildId: string) =>
    `artifacts/${artifactId}/builds/${buildId}`,
  storageSource: (artifactId: string, buildId: string) =>
    `artifacts/${artifactId}/source/${buildId}.zip`,
  /** Where the app uploads a build zip before artifactPublish (swept after 24h like attachments). */
  storageUpload: (artifactId: string, uploadId: string) =>
    `artifacts/${artifactId}/uploads/${uploadId}.zip`,
};

/**
 * Collection names an artifact may not use. The app's own collection-group
 * rules for these names match at ANY depth and grant reads by what the
 * document says, so a document here could be read by someone with no role on
 * the artifact. firestore.rules refuses the write; this says why, up front.
 */
export const ARTIFACT_RESERVED_COLLECTIONS: readonly string[] = ['tickets', 'reads'];

function firestoreSegs(path: unknown): string[] {
  const segs = splitArtifactPath(path);
  segs.forEach((s, i) => {
    if (FIRESTORE_BAD_SEGMENT.test(s))
      throw new ArtifactPathError(`'${s}' is not a valid Firestore id`);
    // Even positions are collection ids ('my' in /my/doc/items/x → 0 and 2).
    if (i % 2 === 0 && ARTIFACT_RESERVED_COLLECTIONS.includes(s))
      throw new ArtifactPathError(
        `A collection cannot be named '${s}' (reserved) — pick another name`,
      );
  });
  return segs;
}

/** A DOCUMENT path: an even, non-zero number of segments ('my/doc'). */
export function artifactFirestoreDoc(artifactId: string, path: unknown): string {
  const segs = firestoreSegs(path);
  if (segs.length === 0 || segs.length % 2 !== 0)
    throw new ArtifactPathError('A document path has an even number of segments, e.g. "/my/doc"');
  return `${artifactPrefix.firestore(artifactId)}/${segs.join('/')}`;
}

/** A COLLECTION path: an odd number of segments ('my', 'my/doc/items'). */
export function artifactFirestoreCollection(artifactId: string, path: unknown): string {
  const segs = firestoreSegs(path);
  if (segs.length % 2 !== 1)
    throw new ArtifactPathError('A collection path has an odd number of segments, e.g. "/my"');
  return `${artifactPrefix.firestore(artifactId)}/${segs.join('/')}`;
}

/** Strip the prefix again, for what the artifact is told ({ path }). */
export function artifactFirestoreRelative(artifactId: string, fullPath: string): string {
  const prefix = `${artifactPrefix.firestore(artifactId)}/`;
  if (!fullPath.startsWith(prefix)) throw new ArtifactPathError('Not under this artifact');
  return `/${fullPath.slice(prefix.length)}`;
}

/** An RTDB location; '' / '/' is the artifact's root. */
export function artifactRtdbPath(artifactId: string, path: unknown): string {
  const segs = splitArtifactPath(path);
  for (const s of segs) {
    if (RTDB_BAD_CHARS.test(s))
      throw new ArtifactPathError(`'${s}' has a character RTDB keys cannot hold`);
  }
  return segs.length
    ? `${artifactPrefix.rtdb(artifactId)}/${segs.join('/')}`
    : artifactPrefix.rtdb(artifactId);
}

/** A Storage OBJECT path (never the root). */
export function artifactStorageFile(artifactId: string, path: unknown): string {
  const segs = splitArtifactPath(path);
  if (segs.length === 0) throw new ArtifactPathError('A file path is required');
  for (const s of segs) {
    if (STORAGE_BAD_CHARS.test(s))
      throw new ArtifactPathError(`'${s}' has a character not allowed in a file name`);
  }
  return `${artifactPrefix.storageFiles(artifactId)}/${segs.join('/')}`;
}

/** A Storage PREFIX for list(); '' is every file. Always ends with '/'. */
export function artifactStoragePrefix(artifactId: string, path: unknown): string {
  const segs = splitArtifactPath(path);
  for (const s of segs) {
    if (STORAGE_BAD_CHARS.test(s))
      throw new ArtifactPathError(`'${s}' has a character not allowed in a file name`);
  }
  return `${artifactPrefix.storageFiles(artifactId)}/${segs.length ? `${segs.join('/')}/` : ''}`;
}

/** db.kv keys are one Firestore id. */
export function artifactKvDoc(artifactId: string, uid: string, key: unknown): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 256)
    throw new ArtifactPathError('A key is a string of 1–256 characters');
  if (key.includes('/') || key === '.' || key === '..' || FIRESTORE_BAD_SEGMENT.test(key))
    throw new ArtifactPathError(`'${key}' is not a valid key`);
  return `${artifactPrefix.kv(artifactId, uid)}/${key}`;
}

/**
 * A path inside a BUILD, from the /c/{cap}/{path} URL: '' → 'index.html'.
 * Refuses '..' and '.' like everything else. The server maps a miss with no
 * extension to index.html (§D2); that is the server's decision, not this one.
 */
export function artifactBuildFile(path: unknown): string {
  const segs = splitArtifactPath(path);
  return segs.length ? segs.join('/') : 'index.html';
}

/**
 * Publishing: a path INSIDE the uploaded zip → the build-relative path, or
 * null for an entry to skip (directories, __MACOSX, .DS_Store). Throws on an
 * entry that would escape the folder (absolute, '..', a drive letter).
 */
export function artifactZipEntry(name: string): string | null {
  const n = name.replace(/\\/g, '/');
  if (n.endsWith('/')) return null;
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n))
    throw new ArtifactPathError(`Absolute path in zip: ${name}`);
  const segs = n.split('/');
  if (segs.some((s) => s === '..')) throw new ArtifactPathError(`'..' in zip: ${name}`);
  const clean = segs.filter((s) => s.length > 0 && s !== '.');
  if (clean[0] === '__MACOSX' || clean[clean.length - 1] === '.DS_Store') return null;
  return clean.length ? clean.join('/') : null;
}

/**
 * If every entry sits in ONE top folder (a zipped `dist/`), strip it — §C1:
 * "an index.html at the root (or in a single top folder, which is stripped)".
 */
export function stripSingleTopFolder(paths: readonly string[]): string[] {
  if (paths.length === 0 || paths.includes('index.html')) return [...paths];
  const tops = new Set(paths.map((p) => p.split('/')[0]));
  if (tops.size !== 1 || paths.some((p) => !p.includes('/'))) return [...paths];
  const top = [...tops][0]!;
  return paths.map((p) => p.slice(top.length + 1));
}

/** §C1's warning: index.html asking for /assets/… (absolute) shows a blank page. */
export function absoluteAssetWarning(indexHtml: string): string | null {
  const re = /\s(?:src|href)\s*=\s*["']\/(?!\/)[^"']*["']/i;
  return re.test(indexHtml)
    ? 'index.html loads assets from absolute paths ("/…"). Artifacts are served under a prefix, so use relative paths — in Vite, set base: \'./\'.'
    : null;
}
