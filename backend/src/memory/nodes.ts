/**
 * MEMORY NODES (docs/plan/memory.html §A) — paths inside one memory.
 *
 * A node is found by its full `path` (unique in the memory) or by its id. A
 * transaction READS FIRST and writes after, so every operation here comes in
 * two halves: `read…` (queries in the transaction — Firestore's server
 * transactions lock what a query read, so two writers racing for the same
 * path cannot both see it free) and `write…`.
 *
 * Folders a path needs are created on the way ("mkdir -p"); a FILE in the
 * way is a 409.
 */
import {
  errors,
  memoryParentPath,
  MEMORY_NODES_MAX,
  normalizeMemoryPath,
  splitMemoryPath,
  type Memory,
  type MemoryNode,
  type PrincipalId,
} from '@tm/shared';
import { FieldValue } from 'firebase-admin/firestore';
import type { ServerCtx } from '../runtime/context.js';
import { txGet, type Tx } from '../runtime/tx.js';
import { nodeRef, nodesCol, rawMemoryRef } from './shared.js';

export interface Found {
  id: string;
  node: MemoryNode;
}

/** A path a caller typed → canonical, or a 400 naming the field. */
export function cleanPath(input: string, field = 'path', allowRoot = false): string {
  const p = normalizeMemoryPath(input);
  if (p === null) throw errors.invalid('Not a valid path in a memory', { field, path: input });
  if (p === '' && !allowRoot)
    throw errors.invalid('Name a file or folder, not the root', { field });
  return p;
}

/** The node at `path` (read in `tx` when given), or null. */
export async function nodeAt(memoryId: string, path: string, tx?: Tx): Promise<Found | null> {
  const q = nodesCol(memoryId).where('path', '==', path).limit(2);
  const snap = tx ? await tx.get(q) : await q.get();
  const d = snap.docs[0];
  return d ? { id: d.id, node: d.data() } : null;
}

/** A node by id or by path — exactly one is given (the request schema says so). */
export async function readTarget(
  tx: Tx | null,
  memoryId: string,
  t: { path?: string | undefined; nodeId?: string | undefined },
): Promise<Found> {
  if (t.nodeId) {
    const ref = nodeRef(memoryId, t.nodeId);
    const node = tx ? await txGet(tx, ref) : (await ref.get()).data();
    if (!node) throw errors.not_found('No such file or folder in this memory');
    return { id: t.nodeId, node };
  }
  const path = cleanPath(t.path ?? '');
  const found = await nodeAt(memoryId, path, tx ?? undefined);
  if (!found) throw errors.not_found(`Nothing at ${path} in this memory`, { path });
  return found;
}

/** Every node strictly under a folder path ('' = the whole memory). */
export async function readSubtree(
  memoryId: string,
  folderPath: string,
  tx?: Tx,
  limit = MEMORY_NODES_MAX + 1,
): Promise<Found[]> {
  const col = nodesCol(memoryId);
  const q =
    folderPath === ''
      ? col.limit(limit)
      : col
          .where('path', '>', folderPath + '/')
          .where('path', '<', folderPath + '/')
          .limit(limit);
  const snap = tx ? await tx.get(q) : await q.get();
  return snap.docs.map((d) => ({ id: d.id, node: d.data() }));
}

/**
 * The read half of "make sure the folders above `path` exist": the node (or
 * null) at every PARENT prefix of `path`, root first.
 */
export async function readParents(
  tx: Tx,
  memoryId: string,
  path: string,
): Promise<(Found | null)[]> {
  const segs = splitMemoryPath(path) ?? [];
  const prefixes = segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join('/'));
  return Promise.all(prefixes.map((p) => nodeAt(memoryId, p, tx)));
}

export interface ParentPlan {
  /** Folder id the node goes in (null = the root). */
  parentId: string | null;
  /** Folders to create, in order, root first. */
  create: { id: string; node: MemoryNode }[];
}

/**
 * Plan the parents of `path` from what readParents found. Pure: no writes yet,
 * so the caller can still refuse (node limit, a conflict) before writing.
 */
export function planParents(
  ctx: Pick<ServerCtx, 'ids' | 'now' | 'actor'>,
  path: string,
  found: (Found | null)[],
): ParentPlan {
  const segs = splitMemoryPath(path) ?? [];
  let parentId: string | null = null;
  const create: ParentPlan['create'] = [];
  found.forEach((f, i) => {
    const p = segs.slice(0, i + 1).join('/');
    if (f) {
      if (f.node.kind !== 'folder')
        throw errors.conflict(`${p} is a file, not a folder`, { path: p });
      parentId = f.id;
      return;
    }
    const id = ctx.ids.id();
    create.push({ id, node: folderNode(ctx.actor, ctx.now, parentId, segs[i]!, p) });
    parentId = id;
  });
  return { parentId, create };
}

export const folderNode = (
  by: PrincipalId,
  now: number,
  parentId: string | null,
  name: string,
  path: string,
): MemoryNode => ({
  kind: 'folder',
  parentId,
  name,
  path,
  file: null,
  createdAt: now,
  createdBy: by,
  updatedAt: now,
  updatedBy: by,
});

/** Refuse when `adding` more nodes would pass MEMORY_NODES_MAX. */
export function assertRoom(memory: Pick<Memory, 'stats'>, adding: number): void {
  if (adding <= 0) return;
  const now = memory.stats.files + memory.stats.folders;
  if (now + adding > MEMORY_NODES_MAX)
    throw errors.conflict(
      `A memory holds at most ${MEMORY_NODES_MAX.toLocaleString('en')} files and folders`,
    );
}

/** Write the planned folders. */
export function writeParents(tx: Tx, memoryId: string, plan: ParentPlan): void {
  for (const f of plan.create) tx.create(nodeRef(memoryId, f.id), f.node);
}

/** Bump the memory's counters (and updatedAt) in the same transaction / batch. */
export function bumpStats(
  w: {
    update: (ref: FirebaseFirestore.DocumentReference, data: Record<string, unknown>) => unknown;
  },
  memoryId: string,
  d: { files?: number; folders?: number; bytes?: number },
  now: number,
): void {
  const patch: Record<string, unknown> = { updatedAt: now };
  if (d.files) patch['stats.files'] = FieldValue.increment(d.files);
  if (d.folders) patch['stats.folders'] = FieldValue.increment(d.folders);
  if (d.bytes) patch['stats.bytes'] = FieldValue.increment(d.bytes);
  w.update(rawMemoryRef(memoryId), patch);
}

export { memoryParentPath };
