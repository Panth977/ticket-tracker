/**
 * Immutable edits on a view's filter tree (FilterNode from @tm/shared).
 *
 * The Filter builder always edits a ROOT GROUP — `{ op, children }` — and
 * addresses nodes by their index path from the root ([] = the root, [2, 0] =
 * the first child of the root's third child). Every function returns a new tree;
 * the saved View's filter is never mutated in place (the unsaved-changes dot
 * compares the draft against it).
 */
import { isFilterGroup, type FilterGroup, type FilterLeaf, type FilterNode } from '@tm/shared';

export type NodePath = readonly number[];

export const emptyRoot = (): FilterGroup => ({ op: 'and', children: [] });

/** Whatever is stored (null, a bare leaf, a group) as a root group the builder can edit. */
export function asRoot(filter: FilterNode | null | undefined): FilterGroup {
  if (!filter) return emptyRoot();
  return isFilterGroup(filter) ? filter : { op: 'and', children: [filter] };
}

/** What gets saved: an empty tree is `null` (no filter), empty sub-groups are dropped. */
export function normalize(filter: FilterNode | null | undefined): FilterNode | null {
  if (!filter) return null;
  if (!isFilterGroup(filter)) return filter;
  const children = filter.children.map(normalize).filter((c): c is FilterNode => c != null);
  if (children.length === 0) return null;
  return { op: filter.op, children };
}

export function getAt(root: FilterGroup, path: NodePath): FilterNode | undefined {
  let cur: FilterNode = root;
  for (const i of path) {
    if (!isFilterGroup(cur)) return undefined;
    const next: FilterNode | undefined = cur.children[i];
    if (!next) return undefined;
    cur = next;
  }
  return cur;
}

/** Replace the node at `path` (the root when path is empty) with `fn(node)`. */
export function updateAt(
  root: FilterGroup,
  path: NodePath,
  fn: (n: FilterNode) => FilterNode,
): FilterGroup {
  if (path.length === 0) {
    const out = fn(root);
    return isFilterGroup(out) ? out : { op: 'and', children: [out] };
  }
  const [head, ...rest] = path;
  return {
    ...root,
    children: root.children.map((c, i) => {
      if (i !== head) return c;
      if (rest.length === 0) return fn(c);
      return isFilterGroup(c) ? updateAt(c, rest, fn) : c;
    }),
  };
}

/** Append a child to the group at `groupPath`. */
export function addChild(root: FilterGroup, groupPath: NodePath, child: FilterNode): FilterGroup {
  return updateAt(root, groupPath, (g) =>
    isFilterGroup(g) ? { ...g, children: [...g.children, child] } : g,
  );
}

/** Remove the node at `path` (not the root). */
export function removeAt(root: FilterGroup, path: NodePath): FilterGroup {
  if (path.length === 0) return emptyRoot();
  const parent = path.slice(0, -1);
  const idx = path[path.length - 1]!;
  return updateAt(root, parent, (g) =>
    isFilterGroup(g) ? { ...g, children: g.children.filter((_, i) => i !== idx) } : g,
  );
}

export function setOp(root: FilterGroup, groupPath: NodePath, op: 'and' | 'or'): FilterGroup {
  return updateAt(root, groupPath, (g) => (isFilterGroup(g) ? { ...g, op } : g));
}

export function setLeaf(
  root: FilterGroup,
  path: NodePath,
  patch: Partial<FilterLeaf>,
): FilterGroup {
  return updateAt(root, path, (n) => (isFilterGroup(n) ? n : { ...n, ...patch }));
}

/** How many conditions (leaves) the tree has — the '2' in 'Filter 2'. */
export function countConditions(filter: FilterNode | null | undefined): number {
  if (!filter) return 0;
  if (!isFilterGroup(filter)) return 1;
  return filter.children.reduce((n, c) => n + countConditions(c), 0);
}

/** True when the tree mentions `field` anywhere (e.g. a removed custom field). */
export function mentionsField(filter: FilterNode | null | undefined, field: string): boolean {
  if (!filter) return false;
  if (!isFilterGroup(filter)) return filter.field === field;
  return filter.children.some((c) => mentionsField(c, field));
}

/** AND an extra condition onto a (possibly empty) filter — the board search box does this. */
export function andWith(
  filter: FilterNode | null | undefined,
  extra: FilterNode | null,
): FilterNode | null {
  if (!extra) return filter ?? null;
  if (!filter) return extra;
  return { op: 'and', children: [filter, extra] };
}
