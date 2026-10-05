/**
 * The title dropdown on a board (BoardBar), an artifact (ArtifactHost) and a
 * memory (memory.html §F): one list, built here so the three never drift
 * (agents.html §AB3).
 *
 *   in a workspace that holds the open item → its boards, then its artifacts,
 *                                              then its memories, then
 *                                              "Show all …" (leaves it)
 *   otherwise                               → every board (on a board), every
 *                                              artifact (on an artifact) or
 *                                              every memory (on a memory)
 *
 * Archived ones are left out; the open one is marked (disabled). Every row
 * carries its entity's indicator (indicators.html), drawn by Menu.
 */
import {
  MEMORY_DEFAULT_INDICATOR,
  type Artifact,
  type Board,
  type Memory,
  type Workspace,
} from '@tm/shared';
import { routes } from '$lib/layout/routes';
import type { WithId } from '$lib/stores';
import type { MenuItem } from '$lib/ui/types';

export type Current = { boardId: string } | { artifactId: string } | { memoryId: string };

/** Does this workspace hold the open item? */
export function workspaceHolds(w: Workspace, current: Current): boolean {
  if ('boardId' in current) return w.boardIds.includes(current.boardId);
  if ('artifactId' in current) return w.artifactIds.includes(current.artifactId);
  return (w.memoryIds ?? []).includes(current.memoryId);
}

/** The workspace I am in, when it holds what is open — else null. */
export function activeWorkspace(
  list: readonly WithId<Workspace>[],
  contextId: string | null,
  current: Current,
): WithId<Workspace> | null {
  return list.find((w) => w.id === contextId && workspaceHolds(w, current)) ?? null;
}

export function switcherItems(o: {
  boards: readonly WithId<Board>[];
  artifacts: readonly WithId<Artifact>[];
  memories?: readonly WithId<Memory>[];
  workspace: WithId<Workspace> | null;
  current: Current;
  leave: () => void;
}): MenuItem[] {
  const boards = o.boards.filter((b) => b.archivedAt == null);
  const artifacts = o.artifacts.filter((a) => a.archivedAt == null);
  const memories = (o.memories ?? []).filter((m) => m.archivedAt == null);
  const boardItem = (b: WithId<Board>, separator = false): MenuItem => ({
    label: `${b.key} · ${b.name}`,
    indicator: { of: b, seed: b.id },
    href: routes.board(b.key),
    disabled: 'boardId' in o.current && b.id === o.current.boardId,
    separator,
  });
  const artifactItem = (a: WithId<Artifact>, separator = false): MenuItem => ({
    label: a.name,
    indicator: { of: a, seed: a.id },
    href: routes.artifact(a.id),
    disabled: 'artifactId' in o.current && a.id === o.current.artifactId,
    separator,
  });
  const memoryItem = (m: WithId<Memory>, separator = false): MenuItem => ({
    label: m.name,
    indicator: { of: m, seed: m.id, fallback: MEMORY_DEFAULT_INDICATOR },
    href: routes.memory(m.id),
    disabled: 'memoryId' in o.current && m.id === o.current.memoryId,
    separator,
  });
  const byName = <T extends { name: string }>(xs: readonly T[]) =>
    [...xs].sort((a, b) => a.name.localeCompare(b.name));

  if (!o.workspace) {
    if ('boardId' in o.current) return byName(boards).map((b) => boardItem(b));
    if ('artifactId' in o.current) return byName(artifacts).map((a) => artifactItem(a));
    return byName(memories).map((m) => memoryItem(m));
  }

  const b = new Map(boards.map((x) => [x.id, x]));
  const a = new Map(artifacts.map((x) => [x.id, x]));
  const m = new Map(memories.map((x) => [x.id, x]));
  const inBoards = o.workspace.boardIds.flatMap((id) => b.get(id) ?? []);
  const inArtifacts = o.workspace.artifactIds.flatMap((id) => a.get(id) ?? []);
  const inMemories = (o.workspace.memoryIds ?? []).flatMap((id) => m.get(id) ?? []);
  return [
    ...inBoards.map((x) => boardItem(x)),
    ...inArtifacts.map((x, i) => artifactItem(x, i === 0 && inBoards.length > 0)),
    ...inMemories.map((x, i) => memoryItem(x, i === 0 && inBoards.length + inArtifacts.length > 0)),
    {
      label:
        'boardId' in o.current
          ? 'Show all boards'
          : 'artifactId' in o.current
            ? 'Show all artifacts'
            : 'Show all memory',
      onSelect: o.leave,
      separator: true,
    },
  ];
}
