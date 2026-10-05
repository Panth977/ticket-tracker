/**
 * The "Attach from memory" picker's logic (memory.html §E), kept pure so it
 * can be tested without a dialog: memoryTree's flat node list → the rows the
 * picker draws (folders first, then files, by name, indented by depth, under
 * the open folders only), and the chosen files → what the composer sends.
 */
import { memoryRefPath, type MemoryNodeOut, type MemoryOut, type MemoryRef } from '@tm/shared';

/** One chosen memory file, as the composer carries it until Send. */
export interface MemoryPick {
  memoryId: string;
  nodeId: string;
  memoryName: string;
  /** The file's name (its last path segment) and full path in the memory. */
  name: string;
  path: string;
  mime: string;
  size: number;
}

export interface PickerRow {
  node: MemoryNodeOut;
  depth: number;
  /** Folders: is it unfolded? */
  open: boolean;
}

const byKindThenName = (a: MemoryNodeOut, b: MemoryNodeOut) =>
  a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1;

/**
 * The rows to draw. `open` holds the unfolded folders' ids; a folder's
 * children show only when it and every folder above it are open. With a
 * `filter`, every file whose path contains it shows, with its folders, open.
 */
export function pickerRows(
  nodes: readonly MemoryNodeOut[],
  open: ReadonlySet<string>,
  filter = '',
): PickerRow[] {
  const q = filter.trim().toLowerCase();
  const children = new Map<string | null, MemoryNodeOut[]>();
  for (const n of nodes) {
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  for (const list of children.values()) list.sort(byKindThenName);

  // With a filter: the matching files and every folder on their way.
  let keep: Set<string> | null = null;
  if (q) {
    keep = new Set();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      if (n.kind !== 'file' || !n.path.toLowerCase().includes(q)) continue;
      for (
        let cur: MemoryNodeOut | undefined = n;
        cur;
        cur = cur.parentId ? byId.get(cur.parentId) : undefined
      )
        keep.add(cur.id);
    }
  }

  const rows: PickerRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const n of children.get(parentId) ?? []) {
      if (keep && !keep.has(n.id)) continue;
      const isOpen = n.kind === 'folder' && (keep !== null || open.has(n.id));
      rows.push({ node: n, depth, open: isOpen });
      if (isOpen) walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** Toggle one file in the selection (folders are not attachable). */
export function toggleNode(
  selected: ReadonlySet<string>,
  node: MemoryNodeOut,
  max: number,
): Set<string> {
  const next = new Set(selected);
  if (node.kind !== 'file') return next;
  if (next.has(node.id)) next.delete(node.id);
  else if (next.size < max) next.add(node.id);
  return next;
}

/** The selected files of one memory → picks, in tree order. */
export function toPicks(
  memory: Pick<MemoryOut, 'id' | 'name'>,
  nodes: readonly MemoryNodeOut[],
  selected: ReadonlySet<string>,
): MemoryPick[] {
  return nodes
    .filter((n) => n.kind === 'file' && n.file && selected.has(n.id))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((n) => ({
      memoryId: memory.id,
      nodeId: n.id,
      memoryName: memory.name,
      name: n.name,
      path: n.path,
      mime: n.file!.mime,
      size: n.file!.size,
    }));
}

/** Add picks to what the composer holds: no duplicates, at most `max` files in all. */
export function mergePicks(
  have: readonly MemoryPick[],
  add: readonly MemoryPick[],
  max: number,
): MemoryPick[] {
  const out = [...have];
  for (const p of add) {
    if (out.length >= max) break;
    if (!out.some((x) => x.memoryId === p.memoryId && x.nodeId === p.nodeId)) out.push(p);
  }
  return out;
}

/** What messagePost / ticketCreate take. */
export const toMemoryRefs = (picks: readonly MemoryPick[]): MemoryRef[] =>
  picks.map(({ memoryId, nodeId }) => ({ memoryId, nodeId }));

/**
 * The optimistic attachment rows a pick becomes — the same shape the server
 * writes (memory.html §E): the virtual path, which the file door resolves.
 */
export const pickAttachment = (p: MemoryPick) => ({
  path: memoryRefPath(p.memoryId, p.nodeId),
  name: p.name,
  size: p.size,
  mime: p.mime,
});
