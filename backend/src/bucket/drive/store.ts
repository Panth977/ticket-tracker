/**
 * A DRIVE BUCKET'S NODES (docs/plan/bucket.html §K2) — Drive is the truth.
 *
 * The same operations nodes.ts / files.ts give a managed bucket, answered from
 * Drive itself, in the same shapes (Found = { id, node: BucketNode }) so the
 * commands, the file door and toNodeOut need no second vocabulary:
 *
 *   node id      the Drive file id (stable across renames and moves — a
 *                ticket's reference follows the file wherever it goes)
 *   path         the names from the bucket's folder down, computed on read
 *   file.fileId  Drive's head revision (a new version = a new revision)
 *   storagePath  drive/{bucketId}/{driveId}/{name} — the file door reads it
 *                from Drive with the bucket's connection (files.ts router)
 *   createdBy …  kept in the file's appProperties (private to this app)
 *
 * NOTHING IS COPIED into Firestore: a rename made in Drive's own UI is simply
 * what the next read sees. Names Drive allows and a path cannot hold ('/',
 * control characters, '.', '..') are shown with a stand-in; two items with
 * one name in a folder (Drive allows it) are told apart with ' (2)'.
 *
 * No transactions: Drive has none. Each write checks, then acts; two writers
 * racing for one new path can both win (Drive keeps both, the reader numbers
 * the second). Good enough for people's files; the managed store remains the
 * one with atomic guarantees.
 */
import {
  bucketBaseName,
  bucketParentPath,
  bucketPathWithin,
  driveStoragePath,
  errors,
  fileInfo,
  joinBucketPath,
  splitBucketPath,
  BUCKET_DEPTH_MAX,
  BUCKET_NODES_MAX,
  DRIVE_DEFAULT_PARENT,
  normalizeBucketPath,
  type Bucket,
  type BucketDriveStorage,
  type BucketFile,
  type BucketNode,
  type PrincipalId,
} from '@tm/shared';
import type { Readable } from 'node:stream';
import type { Found } from '../nodes.js';
import { isFolder, type ByteSource, type DriveApi, type DriveItem } from './api.js';
import { driveFor } from './link.js';

/** One Drive bucket, opened: its Drive and its root folder. */
export interface DriveBucket {
  bucketId: string;
  storage: BucketDriveStorage;
  api: DriveApi;
  rootId: string;
}

export const isDriveBucket = (
  b: Pick<Bucket, 'storage'> | null | undefined,
): b is Pick<Bucket, 'storage'> & { storage: BucketDriveStorage } => b?.storage?.kind === 'drive';

/** Open a Drive bucket (its owner's connection). 409 when that Drive is disconnected. */
export async function openDrive(
  bucketId: string,
  bucket: Pick<Bucket, 'storage'> & { storage: BucketDriveStorage },
): Promise<DriveBucket> {
  const api = await driveFor(bucket.storage.uid);
  return { bucketId, storage: bucket.storage, api, rootId: bucket.storage.folderId };
}

// ─── names and shapes ────────────────────────────────────────────────────────

/** A Drive name → a valid path segment ('/' → '∕', controls dropped, '.' / '..' kept apart). */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
const CONTROL = /[\u0000-\u001f]/g;
export function segmentOf(name: string): string {
  let s = name.replace(/\//g, '∕').replace(CONTROL, '').trim();
  if (s === '') s = '_';
  if (s === '.' || s === '..') s = `_${s}`;
  return s.slice(0, 255);
}

const BY = 'tmBy';
const CREATED_BY = 'tmCreatedBy';

function fileOf(d: DriveBucket, f: DriveItem, name: string): BucketFile {
  const mime =
    f.mimeType && f.mimeType !== 'application/octet-stream'
      ? f.mimeType
      : fileInfo(null, name).mime || 'application/octet-stream';
  return {
    fileId:
      f.headRevisionId && /^[A-Za-z0-9_-]{6,64}$/.test(f.headRevisionId)
        ? f.headRevisionId
        : `v${f.modifiedTime.toString(36)}`.padEnd(6, '0'),
    storagePath: driveStoragePath(d.bucketId, f.id, encodeURIComponent(name)),
    mime,
    size: f.size,
    ...(f.width && f.height ? { width: f.width, height: f.height } : {}),
  };
}

export function toFound(
  d: DriveBucket,
  f: DriveItem,
  path: string,
  parentId: string | null,
): Found {
  const name = bucketBaseName(path);
  const folder = isFolder(f);
  const by = (f.appProperties[BY] || d.storage.uid) as PrincipalId;
  const node: BucketNode = {
    kind: folder ? 'folder' : 'file',
    parentId,
    name,
    path,
    file: folder ? null : fileOf(d, f, name),
    createdAt: f.createdTime,
    createdBy: (f.appProperties[CREATED_BY] || by) as PrincipalId,
    updatedAt: f.modifiedTime,
    updatedBy: by,
  };
  return { id: f.id, node };
}

/** Name the children of one folder: segments, with ' (2)' for a repeat (folders first, then oldest). */
function named(items: DriveItem[]): { item: DriveItem; seg: string }[] {
  // The staging folder (§K4) is the app's own, never part of the bucket.
  const sorted = items
    .filter((i) => !(i.name === INCOMING && isFolder(i)))
    .sort(
      (a, b) =>
        Number(isFolder(b)) - Number(isFolder(a)) ||
        a.createdTime - b.createdTime ||
        (a.id < b.id ? -1 : 1),
    );
  const taken = new Set<string>();
  return sorted.map((item) => {
    const base = segmentOf(item.name);
    let seg = base;
    for (let n = 2; taken.has(seg); n++) seg = numbered(base, n);
    taken.add(seg);
    return { item, seg };
  });
}

/** 'report.pdf', 2 → 'report (2).pdf' (as attach.ts numbers a taken name). */
function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

// ─── reads ───────────────────────────────────────────────────────────────────

/**
 * Every node under the folder at `folderPath` ('' = the whole bucket), one
 * Drive query per LEVEL (a level's folders asked together). Sorted by path.
 */
export async function driveTree(
  d: DriveBucket,
  folderPath = '',
  opts: { shallow?: boolean; limit?: number } = {},
): Promise<{ rows: Found[]; folderId: string }> {
  const limit = opts.limit ?? BUCKET_NODES_MAX + 1;
  let start: { id: string; path: string } = { id: d.rootId, path: '' };
  if (folderPath !== '') {
    const f = await driveAt(d, folderPath);
    if (!f) throw errors.not_found(`Nothing at ${folderPath} in this bucket`, { path: folderPath });
    if (f.node.kind !== 'folder')
      throw errors.invalid(`${folderPath} is a file`, { field: 'path' });
    start = { id: f.id, path: f.node.path };
  }
  const rows: Found[] = [];
  let level: { id: string; path: string }[] = [start];
  for (let depth = 0; level.length && depth < BUCKET_DEPTH_MAX && rows.length < limit; depth++) {
    const kids = await d.api.children(level.map((l) => l.id));
    const byParent = new Map<string, DriveItem[]>();
    for (const k of kids)
      for (const p of k.parents) {
        let list = byParent.get(p);
        if (!list) byParent.set(p, (list = []));
        list.push(k);
      }
    const next: { id: string; path: string }[] = [];
    for (const l of level) {
      for (const { item, seg } of named(byParent.get(l.id) ?? [])) {
        const path = joinBucketPath(l.path, seg);
        if (splitBucketPath(path) === null) continue; // too deep / too long to address
        rows.push(toFound(d, item, path, l.id === d.rootId ? null : l.id));
        if (isFolder(item)) next.push({ id: item.id, path });
      }
    }
    if (opts.shallow) break;
    level = next;
  }
  rows.sort((a, b) => (a.node.path < b.node.path ? -1 : a.node.path > b.node.path ? 1 : 0));
  return { rows: rows.slice(0, limit), folderId: start.id };
}

/** The node at `path`, walking down from the bucket's folder; null when nothing is there. */
export async function driveAt(d: DriveBucket, path: string): Promise<Found | null> {
  const segs = splitBucketPath(path);
  if (!segs || !segs.length) return null;
  let parent = d.rootId;
  let at = '';
  for (let i = 0; i < segs.length; i++) {
    const kids = named(await d.api.children([parent]));
    const hit = kids.find((k) => k.seg === segs[i]);
    if (!hit) return null;
    at = joinBucketPath(at, hit.seg);
    if (i === segs.length - 1) return toFound(d, hit.item, at, parent === d.rootId ? null : parent);
    if (!isFolder(hit.item)) return null;
    parent = hit.item.id;
  }
  return null;
}

/**
 * The node with this Drive id — only when it is (still) inside this bucket's
 * folder and not trashed: its path is found by walking up its parents.
 */
export async function driveById(d: DriveBucket, id: string): Promise<Found | null> {
  const direct = await driveByIdDirect(d, id);
  if (direct) return direct;
  // §K6: a node that lived in Firestore before the bucket moved to Drive keeps
  // answering to its old id (ticket links) — the moved file carries it.
  for (const f of await d.api.findByProp(NODE_ID, id).catch(() => [])) {
    const hit = await driveByIdDirect(d, f.id);
    if (hit) return hit;
  }
  return null;
}

/** The private appProperty a moved node keeps its old (managed) id in. */
export const NODE_ID = 'tmNodeId';

async function driveByIdDirect(d: DriveBucket, id: string): Promise<Found | null> {
  if (id === d.rootId) return null;
  const item = await d.api.get(id).catch((e: { code?: string }) => {
    if (e?.code === 'not_found') return null;
    throw e;
  });
  if (!item || item.trashed) return null;
  const chain: DriveItem[] = [item];
  let cur = item;
  for (let depth = 0; depth <= BUCKET_DEPTH_MAX; depth++) {
    const p = cur.parents[0];
    if (!p) return null;
    if (p === d.rootId) {
      // Name each level among its siblings, so the path is the one the tree shows.
      let parent = d.rootId;
      let path = '';
      for (const c of chain.reverse()) {
        const kids = named(await d.api.children([parent]));
        const hit = kids.find((k) => k.item.id === c.id);
        if (!hit) return null;
        path = joinBucketPath(path, hit.seg);
        parent = c.id;
      }
      return toFound(d, item, path, item.parents[0] === d.rootId ? null : item.parents[0]!);
    }
    const up = await d.api.get(p).catch(() => null);
    if (!up || up.trashed) return null;
    chain.push(up);
    cur = up;
  }
  return null;
}

/** By id or by path — exactly one (as readTarget). 404 when nothing. */
export async function driveTarget(
  d: DriveBucket,
  t: { path?: string | undefined; nodeId?: string | undefined },
): Promise<Found> {
  if (t.nodeId) {
    const f = await driveById(d, t.nodeId);
    if (!f) throw errors.not_found('No such file or folder in this bucket');
    return f;
  }
  const path = cleanDrivePath(t.path ?? '');
  const f = await driveAt(d, path);
  if (!f) throw errors.not_found(`Nothing at ${path} in this bucket`, { path });
  return f;
}

function cleanDrivePath(input: string, field = 'path'): string {
  const p = normalizeBucketPath(input);
  if (p === null) throw errors.invalid('Not a valid path in a bucket', { field, path: input });
  if (p === '') throw errors.invalid('Name a file or folder, not the root', { field });
  return p;
}

export async function driveRead(
  d: DriveBucket,
  id: string,
  range?: { start: number; end: number },
): Promise<Readable> {
  return d.api.download(id, range);
}

// ─── writes ──────────────────────────────────────────────────────────────────

const props = (actor: PrincipalId, created = false): Record<string, string> => ({
  [BY]: actor,
  ...(created ? { [CREATED_BY]: actor } : {}),
});

/** mkdir -p: the id of the folder at `path` ('' = the bucket's folder); a FILE in the way is a 409. */
export async function driveMkdirp(
  d: DriveBucket,
  path: string,
  actor: PrincipalId,
): Promise<string> {
  const segs = splitBucketPath(path);
  if (segs === null) throw errors.invalid('Not a valid path in a bucket', { field: 'path', path });
  let parent = d.rootId;
  let at = '';
  for (const s of segs) {
    at = joinBucketPath(at, s);
    const hit = named(await d.api.children([parent])).find((k) => k.seg === s);
    if (hit) {
      if (!isFolder(hit.item)) throw errors.conflict(`${at} is a file, not a folder`, { path: at });
      parent = hit.item.id;
      continue;
    }
    parent = (await d.api.createFolder(parent, s, props(actor, true))).id;
  }
  return parent;
}

/** A free name in a folder: `name`, else 'name (2)', 'name (3)' … (attach.ts never replaces). */
export async function driveFreeName(
  d: DriveBucket,
  folderId: string,
  name: string,
): Promise<string> {
  const taken = new Set(named(await d.api.children([folderId])).map((k) => k.seg));
  if (!taken.has(name)) return name;
  for (let n = 2; n <= 500; n++) if (!taken.has(numbered(name, n))) return numbered(name, n);
  throw errors.conflict(`Too many files named like ${name}`);
}

/**
 * Create or replace a file (bucketFileWrite / bucketFilePut / the raw PUT):
 * an existing nodeId gets a new version; a path is replaced when it is a file,
 * created (with its folders) when it names nothing. `expectedFileId` as in
 * putVersion: the current revision must match (null = must not exist yet).
 */
export async function drivePut(
  d: DriveBucket,
  t: { path?: string | undefined; nodeId?: string | undefined },
  source: ByteSource,
  mimeIn: string | null | undefined,
  actor: PrincipalId,
  expectedFileId?: string | null,
): Promise<{ nodeId: string; fileId: string; path: string }> {
  let existing: Found | null;
  let path: string;
  if (t.nodeId) {
    existing = await driveTarget(d, t);
    path = existing.node.path;
  } else {
    path = cleanDrivePath(t.path ?? '');
    existing = await driveAt(d, path);
  }
  if (existing && existing.node.kind !== 'file')
    throw errors.conflict(`${path} is a folder`, { path });
  const current = existing?.node.file?.fileId ?? null;
  if (expectedFileId !== undefined && expectedFileId !== current)
    throw errors.conflict('This file changed since you opened it', {
      reason: 'stale',
      currentFileId: current,
    });
  const name = bucketBaseName(path);
  const mime = (mimeIn && mimeIn.trim()) || fileInfo(null, name).mime || 'application/octet-stream';
  if (existing) {
    const f = await d.api.replace(existing.id, mime, source, props(actor));
    const out = toFound(d, f, path, existing.node.parentId);
    return { nodeId: f.id, fileId: out.node.file!.fileId, path };
  }
  const parentId = await driveMkdirp(d, bucketParentPath(path), actor);
  const f = await d.api.create({ parentId, name, mime, source, props: props(actor, true) });
  const out = toFound(d, f, path, parentId === d.rootId ? null : parentId);
  return { nodeId: f.id, fileId: out.node.file!.fileId, path };
}

/** A folder (and its parents); an existing folder is not an error. */
export async function driveFolderCreate(
  d: DriveBucket,
  path: string,
  actor: PrincipalId,
): Promise<{ nodeId: string; path: string }> {
  const clean = cleanDrivePath(path);
  return { nodeId: await driveMkdirp(d, clean, actor), path: clean };
}

/** Rename and/or move one node to `toPath` (its new full path). */
export async function driveMove(
  d: DriveBucket,
  t: { path?: string | undefined; nodeId?: string | undefined },
  toPathIn: string,
  actor: PrincipalId,
): Promise<{ nodeId: string; path: string }> {
  const toPath = cleanDrivePath(toPathIn, 'toPath');
  const node = await driveTarget(d, t);
  const from = node.node.path;
  if (from === toPath) return { nodeId: node.id, path: toPath };
  if (node.node.kind === 'folder' && bucketPathWithin(toPath, from))
    throw errors.conflict('A folder cannot move inside itself', { path: toPath });
  if (await driveAt(d, toPath))
    throw errors.conflict(`Something is already at ${toPath}`, { path: toPath });
  const newParent = await driveMkdirp(d, bucketParentPath(toPath), actor);
  const oldParent = node.node.parentId ?? d.rootId;
  await d.api.update(node.id, {
    name: bucketBaseName(toPath),
    ...(newParent !== oldParent ? { addParent: newParent, removeParent: oldParent } : {}),
    props: props(actor),
  });
  return { nodeId: node.id, path: toPath };
}

/** To Drive's trash (a folder with everything in it). Answers how many nodes went. */
export async function driveDelete(d: DriveBucket, targets: Found[]): Promise<number> {
  let count = 0;
  const done = new Set<string>();
  for (const t of targets) {
    if (done.has(t.id)) continue;
    done.add(t.id);
    count += 1;
    if (t.node.kind === 'folder') count += (await driveTree(d, t.node.path)).rows.length;
    await d.api.trash(t.id);
  }
  return count;
}

// ─── the bucket's folder, at create ──────────────────────────────────────────

/**
 * The folder a new Drive bucket will be: a folder the person picked (it must
 * be one the app may use, and a folder), else `folderPath` under their Drive's
 * top level, made when missing (default 'TaskManager/{name}').
 */
export async function driveBucketFolder(
  api: DriveApi,
  input: { folderId?: string | undefined; folderPath?: string | undefined },
  bucketName: string,
  actor: PrincipalId,
): Promise<{ folderId: string; folderName: string }> {
  if (input.folderId) {
    const f = await api.get(input.folderId).catch(() => null);
    if (!f || f.trashed)
      throw errors.invalid('That Drive folder cannot be used — pick it again', {
        field: 'storage',
      });
    if (!isFolder(f)) throw errors.invalid('Pick a folder, not a file', { field: 'storage' });
    return { folderId: f.id, folderName: f.name };
  }
  const raw = input.folderPath?.trim() || `${DRIVE_DEFAULT_PARENT}/${segmentOf(bucketName)}`;
  const segs = splitBucketPath(normalizeBucketPath(raw) ?? '');
  if (!segs || !segs.length)
    throw errors.invalid('Not a valid Drive folder path', { field: 'storage', path: raw });
  // The top level of "My Drive": with drive.file, only the folders this app
  // made there are visible — so an existing one is reused, a new one made.
  let parent: string | null = null;
  let last: DriveItem | null = null;
  for (const s of segs) {
    const kids: DriveItem[] = parent ? await api.children([parent]) : await api.children(['root']);
    const hit = kids.find((k) => isFolder(k) && segmentOf(k.name) === s);
    last = hit ?? (await api.createFolder(parent, s, props(actor, true)));
    parent = last.id;
  }
  return { folderId: last!.id, folderName: last!.name };
}

// ─── uploads straight from the browser (§K4) ─────────────────────────────────

/**
 * Files on their way into a ticket (§J) wait here, in the bucket's own folder,
 * until the command that posts them commits — then they move to their path.
 * Hidden from the tree. Made on first use.
 */
export const INCOMING = '.tm-incoming';

export async function driveIncoming(d: DriveBucket): Promise<string> {
  const hit = (await d.api.children([d.rootId])).find((k) => k.name === INCOMING && isFolder(k));
  if (hit) return hit.id;
  return (await d.api.createFolder(d.rootId, INCOMING, { [BY]: d.storage.uid })).id;
}

/**
 * Open a Drive upload the browser completes (no copy in our store):
 *   'put'     a bucket file at `path` / `nodeId` — a new version of an existing
 *             file, else a new file (its folders made now, the id reserved)
 *   'attach'  a ticket file (§J): a new file in the staging folder, placed at
 *             its path by the command that posts it
 * Answers the session URL, the Drive id and the file's storagePath.
 */
export async function driveOpenUpload(
  d: DriveBucket,
  o: {
    purpose: 'put' | 'attach';
    path?: string | undefined;
    nodeId?: string | undefined;
    name: string;
    mime: string;
    size: number;
    expectedFileId?: string | null | undefined;
    origin?: string | undefined;
    actor: PrincipalId;
  },
): Promise<{ uploadUrl: string; driveId: string; path: string; storagePath: string }> {
  const mime = o.mime || fileInfo(null, o.name).mime || 'application/octet-stream';
  if (o.purpose === 'attach') {
    const parentId = await driveIncoming(d);
    const [driveId] = await d.api.generateIds(1);
    if (!driveId) throw errors.unavailable('Google Drive did not reserve a file id');
    const name = segmentOf(o.name);
    const uploadUrl = await d.api.openUpload({
      create: { id: driveId, parentId, name },
      mime,
      size: o.size,
      props: props(o.actor, true),
      origin: o.origin,
    });
    return {
      uploadUrl,
      driveId,
      path: '',
      storagePath: driveStoragePath(d.bucketId, driveId, encodeURIComponent(name)),
    };
  }
  let existing: Found | null;
  let path: string;
  if (o.nodeId) {
    existing = await driveTarget(d, { nodeId: o.nodeId });
    path = existing.node.path;
  } else {
    path = cleanDrivePath(o.path ?? '');
    existing = await driveAt(d, path);
  }
  if (existing && existing.node.kind !== 'file')
    throw errors.conflict(`${path} is a folder`, { path });
  const current = existing?.node.file?.fileId ?? null;
  if (o.expectedFileId !== undefined && o.expectedFileId !== current)
    throw errors.conflict('This file changed since you opened it', {
      reason: 'stale',
      currentFileId: current,
    });
  const name = bucketBaseName(path);
  if (existing) {
    const uploadUrl = await d.api.openUpload({
      replaceId: existing.id,
      mime,
      size: o.size,
      props: props(o.actor),
      origin: o.origin,
    });
    return {
      uploadUrl,
      driveId: existing.id,
      path,
      storagePath: driveStoragePath(d.bucketId, existing.id, encodeURIComponent(name)),
    };
  }
  const parentId = await driveMkdirp(d, bucketParentPath(path), o.actor);
  const [driveId] = await d.api.generateIds(1);
  if (!driveId) throw errors.unavailable('Google Drive did not reserve a file id');
  const uploadUrl = await d.api.openUpload({
    create: { id: driveId, parentId, name },
    mime,
    size: o.size,
    props: props(o.actor, true),
    origin: o.origin,
  });
  return {
    uploadUrl,
    driveId,
    path,
    storagePath: driveStoragePath(d.bucketId, driveId, encodeURIComponent(name)),
  };
}

/** A staged ticket file (§K4) moved to its final folder and name. */
export async function drivePlace(
  d: DriveBucket,
  driveId: string,
  path: string,
  actor: PrincipalId,
): Promise<void> {
  const item = await d.api.get(driveId);
  if (!item || item.trashed) throw errors.not_found('The upload is not in Drive');
  const parent = await driveMkdirp(d, bucketParentPath(path), actor);
  const name = await driveFreeName(d, parent, bucketBaseName(path));
  const from = item.parents[0];
  await d.api.update(driveId, {
    name,
    ...(from !== parent ? { addParent: parent, ...(from ? { removeParent: from } : {}) } : {}),
    props: { [BY]: actor },
  });
}

/** Bytes the SERVER holds (REST / MCP / intake / e-mail) → a staged ticket file in Drive. */
export async function driveStageBytes(
  d: DriveBucket,
  name: string,
  mime: string,
  source: ByteSource,
  actor: PrincipalId,
): Promise<string> {
  const parentId = await driveIncoming(d);
  const f = await d.api.create({
    parentId,
    name: segmentOf(name),
    mime,
    source,
    props: props(actor, true),
  });
  return driveStoragePath(d.bucketId, f.id, encodeURIComponent(segmentOf(name)));
}
