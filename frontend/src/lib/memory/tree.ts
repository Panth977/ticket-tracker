/**
 * MEMORY TREES (docs/plan/memory.html §A, §F) — pure. The node listener hands
 * over a flat list (every node carries its full `path`); the tree view, the
 * folders view, the breadcrumb and the move dialog are all derived here.
 */
import {
  joinMemoryPath,
  memoryBaseName,
  memoryParentPath,
  memoryPathWithin,
  normalizeMemoryPath,
  type MemoryNode,
} from '@tm/shared';

export type Node = MemoryNode & { id: string };

export interface TreeNode {
  node: Node;
  children: TreeNode[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders first, then by name (natural: 'file2' before 'file10'). */
export function compareNodes(
  a: Pick<Node, 'kind' | 'name'>,
  b: Pick<Node, 'kind' | 'name'>,
): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  return collator.compare(a.name, b.name);
}

/**
 * The tree, from the flat list. Parents are found by PATH (not parentId), so
 * a node whose folder row is missing (a write in flight) still lands under
 * the right folder once it appears, and never disappears meanwhile: until
 * then it sits at the root.
 */
export function buildTree(nodes: readonly Node[]): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  for (const n of nodes) byPath.set(n.path, { node: n, children: [] });
  const roots: TreeNode[] = [];
  for (const t of byPath.values()) {
    const parent = byPath.get(memoryParentPath(t.node.path));
    if (parent && parent.node.kind === 'folder' && parent !== t) parent.children.push(t);
    else roots.push(t);
  }
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => compareNodes(a.node, b.node));
    for (const t of list) sort(t.children);
  };
  sort(roots);
  return roots;
}

/** The direct children of the folder at `path` ('' = the root), sorted. */
export function childrenOf(nodes: readonly Node[], path: string): Node[] {
  return nodes
    .filter((n) => memoryParentPath(n.path) === path && n.path !== path)
    .sort(compareNodes);
}

export const findByPath = (nodes: readonly Node[], path: string): Node | null =>
  nodes.find((n) => n.path === path) ?? null;

/** 'a/b/c' → [{ name: 'a', path: 'a' }, { name: 'b', path: 'a/b' }, { name: 'c', path: 'a/b/c' }]. */
export function crumbs(path: string): { name: string; path: string }[] {
  if (!path) return [];
  const parts = path.split('/');
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
}

/** Every folder path that must be open for `path` to be visible in the tree. */
export function ancestorsOf(path: string): string[] {
  return crumbs(memoryParentPath(path)).map((c) => c.path);
}

/** Every folder, for the move dialog: '' (the root) first, then by path. */
export function folderPaths(nodes: readonly Node[], exclude?: string | null): string[] {
  const out = nodes
    .filter((n) => n.kind === 'folder' && !(exclude && memoryPathWithin(n.path, exclude)))
    .map((n) => n.path)
    .sort((a, b) => collator.compare(a, b));
  return ['', ...out];
}

/**
 * A name not taken in `folder`: 'untitled.md' → 'untitled 2.md' → … (the
 * extension kept). Case-sensitive, like the paths themselves.
 */
export function freeName(nodes: readonly Node[], folder: string, wanted: string): string {
  const taken = new Set(childrenOf(nodes, folder).map((n) => n.name));
  if (!taken.has(wanted)) return wanted;
  const dot = wanted.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [wanted.slice(0, dot), wanted.slice(dot)] : [wanted, ''];
  for (let i = 2; ; i++) {
    const n = `${stem} ${i}${ext}`;
    if (!taken.has(n)) return n;
  }
}

/** Why `name` cannot be a node name, or null. */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Give it a name';
  if (n.includes('/')) return "A name cannot contain '/'";
  if (n === '.' || n === '..') return "That name isn't allowed";
  if (n.length > 255) return 'At most 255 characters';
  return null;
}

/**
 * Where a dropped / picked file goes: `folder` + its relative path inside the
 * dropped folder (webkitRelativePath, or the drag's fullPath), normalised.
 * null when the result is not a valid path.
 */
export function uploadTarget(folder: string, relative: string): string | null {
  const p = normalizeMemoryPath(relative);
  if (!p) return null;
  return normalizeMemoryPath(joinMemoryPath(folder, p));
}

/** Bytes in the subtree under a folder (or the file itself), for confirmations. */
export function subtreeStats(
  nodes: readonly Node[],
  path: string,
): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const n of nodes)
    if (n.kind === 'file' && memoryPathWithin(n.path, path)) {
      files++;
      bytes += n.file?.size ?? 0;
    }
  return { files, bytes };
}

/** The path a node would have if moved into `folder` (keeping its name). */
export const movedPath = (node: Pick<Node, 'path'>, folder: string): string =>
  joinMemoryPath(folder, memoryBaseName(node.path));

export { joinMemoryPath, memoryBaseName, memoryParentPath, memoryPathWithin };
