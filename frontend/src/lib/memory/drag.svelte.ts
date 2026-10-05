/**
 * DRAG AND DROP on a memory page (memory.html §F): one state for the tree, the
 * folder tiles, the breadcrumb and the page itself, so they all agree on the
 * one thing a drag is about — WHICH FOLDER a drop would land in. That folder
 * is highlighted wherever it shows (its whole subtree in the tree, its tile,
 * its crumb, the folder view when it is the one open), and a pill by the
 * pointer says "Move into …" / "Upload into …".
 *
 * A row or tile hands over the folder IT means: a folder means itself, a file
 * its own folder. A place that cannot take the drop (a folder into itself,
 * a node into the folder it is already in) highlights nothing and refuses.
 */
import { memoryParentPath, memoryPathWithin } from '@tm/shared';
import type { Node } from './tree';

export const NODE_MIME = 'application/x-memory-node';

class MemoryDrag {
  /** The node being dragged; null while files come from the desktop (or nothing). */
  node = $state<Node | null>(null);
  /** The folder a drop here would land in ('' = the top level); null = nowhere. */
  over = $state<string | null>(null);
  x = $state(0);
  y = $state(0);

  start(e: DragEvent, n: Node): void {
    e.stopPropagation();
    this.node = n;
    e.dataTransfer?.setData(NODE_MIME, n.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  end(): void {
    this.node = null;
    this.over = null;
  }

  /** Can what is being dragged land in `folder`? */
  accepts(folder: string): boolean {
    const n = this.node;
    if (!n) return true;
    if (memoryParentPath(n.path) === folder) return false;
    return !(n.kind === 'folder' && memoryPathWithin(folder, n.path));
  }

  /** A dragover on something that means `folder`. Claims the event either way. */
  hover(e: DragEvent, folder: string, writable: boolean): void {
    e.stopPropagation();
    if (!writable || !e.dataTransfer) return;
    // From outside the page, only files are droppable (not text or links).
    if (!this.node && !e.dataTransfer.types.includes('Files')) return;
    this.x = e.clientX;
    this.y = e.clientY;
    if (!this.accepts(folder)) {
      e.dataTransfer.dropEffect = 'none';
      this.over = null;
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = this.node ? 'move' : 'copy';
    this.over = folder;
  }

  /**
   * A drop on something that means `folder`: the node id when a node was
   * dropped, else the files. null when nothing should happen.
   */
  take(
    e: DragEvent,
    folder: string,
    writable: boolean,
  ): { nodeId: string } | { files: DataTransfer } | null {
    e.preventDefault();
    e.stopPropagation();
    const ok = writable && this.accepts(folder) && !!e.dataTransfer;
    const nodeId = e.dataTransfer?.getData(NODE_MIME) || this.node?.id;
    this.end();
    if (!ok || !e.dataTransfer) return null;
    if (nodeId) return { nodeId };
    return e.dataTransfer.types.includes('Files') ? { files: e.dataTransfer } : null;
  }

  /** The pointer left the page: nothing is highlighted until it is back. */
  leave(e: DragEvent): void {
    const to = e.relatedTarget as globalThis.Node | null;
    if (!to || !(e.currentTarget as HTMLElement).contains(to)) this.over = null;
  }
}

export const memoryDrag = new MemoryDrag();
