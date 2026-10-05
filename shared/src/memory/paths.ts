/**
 * MEMORY (docs/plan/memory.html) — where the bytes are, and the virtual path
 * a ticket's reference carries (§E).
 */

/** Storage: memories/{memoryId}/{fileId}/{fileName} — one object per VERSION (D-M2). */
export const memoryStoragePath = (memoryId: string, fileId: string, fileName: string): string =>
  `memories/${memoryId}/${fileId}/${fileName}`;

/** Everything a memory owns in Storage (the delete job's prefix). Ends with '/'. */
export const memoryStoragePrefix = (memoryId: string): string => `memories/${memoryId}/`;

const STORAGE_OBJECT = /^memories\/([A-Za-z0-9_-]{6,64})\/([A-Za-z0-9_-]{6,64})\/([^/]+)$/;

/** memories/{m}/{fileId}/{name} → its parts, or null. */
export function parseMemoryStoragePath(
  path: string,
): { memoryId: string; fileId: string; fileName: string } | null {
  const m = STORAGE_OBJECT.exec(path);
  return m ? { memoryId: m[1]!, fileId: m[2]!, fileName: m[3]! } : null;
}

/**
 * §E: the path a ticket's memory reference carries in `ticket.files[].path`.
 * There is NO object there: the file door resolves it to the node's CURRENT
 * version, so every ticket pointing at a node sees its latest bytes.
 */
export const memoryRefPath = (memoryId: string, nodeId: string): string =>
  `memories/${memoryId}/nodes/${nodeId}`;

const REF = /^memories\/([A-Za-z0-9_-]{6,64})\/nodes\/([A-Za-z0-9_-]{6,64})$/;

export function parseMemoryRefPath(path: string): { memoryId: string; nodeId: string } | null {
  const m = REF.exec(path);
  return m ? { memoryId: m[1]!, nodeId: m[2]! } : null;
}

/** The app's routes for a memory (frontend lib/layout/routes mirrors these). */
export const memoryAppPath = (memoryId: string, path?: string | null): string =>
  `/m/${memoryId}${path ? `?path=${encodeURIComponent(path)}` : ''}`;
