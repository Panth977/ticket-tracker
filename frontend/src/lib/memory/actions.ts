/**
 * What the node menu, the toolbar and the keyboard do (memory.html §F) — each
 * one a command. The Firestore listener redraws the tree when it lands, so
 * there is no local bookkeeping beyond the toast.
 */
import { command } from '$lib/api';
import { toast } from '$lib/ui';
import { joinMemoryPath, memoryParentPath } from '@tm/shared';

export async function createFolder(memoryId: string, path: string): Promise<boolean> {
  try {
    await command(
      'memoryFolderCreate',
      { memoryId, path },
      { toast: 'Could not create the folder' },
    );
    return true;
  } catch {
    return false;
  }
}

/** A new, empty text file (Code mode opens on it). */
export async function createFile(memoryId: string, path: string): Promise<boolean> {
  try {
    await command(
      'memoryFileWrite',
      { memoryId, path, text: '', expectedFileId: null },
      { toast: 'Could not create the file' },
    );
    return true;
  } catch {
    return false;
  }
}

/** Rename in place: same folder, new name. Returns the new path. */
export async function renameNode(
  memoryId: string,
  node: { id: string; path: string },
  name: string,
): Promise<string | null> {
  return moveNode(memoryId, node, joinMemoryPath(memoryParentPath(node.path), name.trim()));
}

export async function moveNode(
  memoryId: string,
  node: { id: string; path: string },
  toPath: string,
): Promise<string | null> {
  if (toPath === node.path) return node.path;
  try {
    const r = await command(
      'memoryMove',
      { memoryId, nodeId: node.id, toPath },
      { toast: 'Could not move it' },
    );
    return r.path;
  } catch {
    return null;
  }
}

export async function deleteNodes(memoryId: string, nodeIds: string[]): Promise<number> {
  if (!nodeIds.length) return 0;
  try {
    const r = await command(
      'memoryNodeDelete',
      { memoryId, nodeIds },
      { toast: 'Could not delete' },
    );
    return r.deleted;
  } catch {
    return 0;
  }
}

export async function copyPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    toast.success('Path copied', path);
  } catch {
    toast.error('Could not copy');
  }
}
