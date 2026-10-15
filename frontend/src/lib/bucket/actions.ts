/**
 * What the node menu, the toolbar and the keyboard do (bucket.html §F) — each
 * one a command. The Firestore listener redraws the tree when it lands, so
 * there is no local bookkeeping beyond the toast.
 */
import { command } from '$lib/api';
import { toast } from '$lib/ui';

export async function createFolder(bucketId: string, path: string): Promise<boolean> {
  try {
    await command(
      'bucketFolderCreate',
      { bucketId, path },
      { toast: 'Could not create the folder' },
    );
    return true;
  } catch {
    return false;
  }
}

/** A new, empty text file (Code mode opens on it). */
export async function createFile(bucketId: string, path: string): Promise<boolean> {
  try {
    await command(
      'bucketFileWrite',
      { bucketId, path, text: '', expectedFileId: null },
      { toast: 'Could not create the file' },
    );
    return true;
  } catch {
    return false;
  }
}

export async function moveNode(
  bucketId: string,
  node: { id: string; path: string },
  toPath: string,
): Promise<string | null> {
  if (toPath === node.path) return node.path;
  try {
    const r = await command(
      'bucketMove',
      { bucketId, nodeId: node.id, toPath },
      { toast: 'Could not move it' },
    );
    return r.path;
  } catch {
    return null;
  }
}

export async function deleteNodes(bucketId: string, nodeIds: string[]): Promise<number> {
  if (!nodeIds.length) return 0;
  try {
    const r = await command(
      'bucketNodeDelete',
      { bucketId, nodeIds },
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
