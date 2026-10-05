/**
 * THE BROKER'S mem.* OPERATIONS (docs/plan/memory.html §H) — memories the
 * artifact's owner granted it, as the signed-in viewer.
 *
 * Two fences, both applied here before anything is read or written:
 *   · the GRANT (memories/{m}.artifacts[artifactId]): a memory that is not
 *     granted does not exist for the artifact, and a 'read' grant never writes;
 *   · the VIEWER: every operation is a memory command in their name, so the
 *     server's memoryReach() bounds them (memoryArtifactReach: the grant is the
 *     ceiling, the viewer's own reach the floor).
 *
 * The commands take no artifact context, so the CEILING is the broker's to
 * keep: when the grant cannot be read (the viewer reaches the memory only
 * through a board and may not read its document) the page gets 'read' — the
 * safe answer, never a guess upward.
 *
 * Pure: the command client arrives as `MemoryBackend`.
 */
import {
  memoryArtifactReach,
  normalizeMemoryPath,
  type DriverMemory,
  type DriverMemoryNode,
  type DriverOp,
  type MemoryGrant,
  type MemoryNodeOut,
  type MemoryOut,
} from '@tm/shared';

/** The viewer's memory commands. */
export interface MemoryBackend {
  /**
   * memoryList({ artifactId }) — the granted memories this viewer reaches,
   * each with the grant to THIS artifact when the viewer may read it (null:
   * unknown, treated as 'read').
   */
  list(): Promise<{ memory: MemoryOut; grant: MemoryGrant | null }[]>;
  tree(memoryId: string, path: string): Promise<MemoryNodeOut[]>;
  read(
    memoryId: string,
    path: string,
    asText: boolean,
  ): Promise<{ text: string | null; truncated: boolean; url: string; expiresAt: number }>;
  write(
    memoryId: string,
    path: string,
    content: { text: string } | { content_base64: string },
    mime: string | null,
  ): Promise<void>;
  mkdir(memoryId: string, path: string): Promise<void>;
  remove(memoryId: string, path: string): Promise<void>;
}

export type MemoryOp = Extract<DriverOp, `mem.${string}`>;
export const isMemoryOp = (op: DriverOp): op is MemoryOp => op.startsWith('mem.');

/** One write through the driver (memory.html §C: inline writes). */
export const DRIVER_MEMORY_WRITE_MAX = 10 * 1024 * 1024;
/** A list answer is reused this long (one op = one check, not one round trip each). */
const LIST_TTL_MS = 5_000;

export interface MemoryOpsOptions {
  artifactId: string;
  backend: MemoryBackend;
  fail: (
    code: 'permission-denied' | 'invalid-argument' | 'not-found' | 'quota',
    message: string,
  ) => never;
  now?: () => number;
}

/** What the page sees of one granted memory. */
export function toDriverMemory(
  artifactId: string,
  m: MemoryOut,
  grant: MemoryGrant | null,
): DriverMemory | null {
  const access = memoryArtifactReach(
    { artifacts: { [artifactId]: grant ?? 'read' } },
    artifactId,
    m.reach,
  );
  if (!access) return null;
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    icon: m.icon,
    access: m.archived ? 'read' : access,
    files: m.stats.files,
    bytes: m.stats.bytes,
  };
}

export function toDriverMemoryNode(n: MemoryNodeOut): DriverMemoryNode {
  return {
    id: n.id,
    kind: n.kind,
    path: n.path,
    name: n.name,
    mime: n.file?.mime ?? null,
    size: n.file?.size ?? null,
    updatedAt: n.updatedAt,
  };
}

/** Blob → base64, in chunks (String.fromCharCode on a 10 MB array would blow the stack). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function createMemoryOps(o: MemoryOpsOptions) {
  const { backend: mem, fail } = o;
  const now = o.now ?? Date.now;
  let cache: { at: number; list: Promise<DriverMemory[]> } | null = null;

  function granted(): Promise<DriverMemory[]> {
    if (cache && now() - cache.at < LIST_TTL_MS) return cache.list;
    const list = mem.list().then((rows) =>
      rows.flatMap(({ memory, grant }) => {
        const d = toDriverMemory(o.artifactId, memory, grant);
        return d ? [d] : [];
      }),
    );
    cache = { at: now(), list };
    list.catch(() => (cache = null));
    return list;
  }

  async function memoryFor(ref: unknown, write: boolean): Promise<DriverMemory> {
    if (typeof ref !== 'string' || !ref.trim())
      return fail('invalid-argument', 'memory must be a memory id (from memory.list())');
    const m = (await granted()).find((x) => x.id === ref.trim());
    if (!m) return fail('permission-denied', `This artifact has no access to memory ${ref}`);
    if (write && m.access !== 'write')
      return fail('permission-denied', `This artifact may only read memory ${m.name}`);
    return m;
  }

  function pathOf(p: unknown, allowRoot = false): string {
    if (typeof p !== 'string') return fail('invalid-argument', 'path must be a string');
    const n = normalizeMemoryPath(p);
    if (n === null) return fail('invalid-argument', `"${p}" is not a valid path`);
    if (!n && !allowRoot) return fail('invalid-argument', 'path is required');
    return n;
  }

  async function run(op: MemoryOp, a: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'mem.list':
        return granted();
      case 'mem.tree': {
        const m = await memoryFor(a.memory, false);
        const path = a.path === undefined ? '' : pathOf(a.path, true);
        return (await mem.tree(m.id, path)).map(toDriverMemoryNode);
      }
      case 'mem.read': {
        const m = await memoryFor(a.memory, false);
        const r = await mem.read(m.id, pathOf(a.path), true);
        if (r.text === null) return fail('invalid-argument', 'Not a text file — use memory.url()');
        return { text: r.text, truncated: r.truncated };
      }
      case 'mem.url': {
        const m = await memoryFor(a.memory, false);
        const r = await mem.read(m.id, pathOf(a.path), false);
        return { url: r.url, expiresAt: r.expiresAt };
      }
      case 'mem.write': {
        const m = await memoryFor(a.memory, true);
        const path = pathOf(a.path);
        const mime = typeof a.contentType === 'string' && a.contentType ? a.contentType : null;
        if (typeof a.text === 'string') {
          if (new TextEncoder().encode(a.text).length > DRIVER_MEMORY_WRITE_MAX)
            return fail('quota', 'A file written through the driver may be at most 10 MB');
          await mem.write(m.id, path, { text: a.text }, mime);
        } else {
          const blob = a.blob as Blob | undefined;
          if (!blob || typeof blob !== 'object' || typeof blob.arrayBuffer !== 'function')
            return fail('invalid-argument', 'write needs a string or a Blob');
          if (blob.size > DRIVER_MEMORY_WRITE_MAX)
            return fail('quota', 'A file written through the driver may be at most 10 MB');
          await mem.write(
            m.id,
            path,
            { content_base64: await blobToBase64(blob) },
            mime || blob.type || null,
          );
        }
        cache = null; // stats moved
        return { path };
      }
      case 'mem.mkdir': {
        const m = await memoryFor(a.memory, true);
        const path = pathOf(a.path);
        await mem.mkdir(m.id, path);
        return { path };
      }
      case 'mem.remove': {
        const m = await memoryFor(a.memory, true);
        await mem.remove(m.id, pathOf(a.path));
        cache = null;
        return { ok: true };
      }
    }
  }

  return { run, granted };
}
