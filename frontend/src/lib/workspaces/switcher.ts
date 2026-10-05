/**
 * The title dropdown on a board (BoardBar) and on an artifact (ArtifactHost):
 * one list, built here so the two never drift (agents.html §AB3).
 *
 *   in a workspace that holds the open item → its boards, then its artifacts,
 *                                              then "Show all …" (leaves it)
 *   otherwise                               → every board (on a board) or
 *                                              every artifact (on an artifact)
 *
 * Archived ones are left out; the open one is marked (disabled).
 */
import type { Artifact, Board, Workspace } from '@tm/shared';
import { artifactGlyph } from '$lib/artifacts/store';
import { routes } from '$lib/layout/routes';
import type { WithId } from '$lib/stores';
import type { MenuItem } from '$lib/ui/types';

export type Current = { boardId: string } | { artifactId: string };

/** The workspace I am in, when it holds what is open — else null. */
export function activeWorkspace(
  list: readonly WithId<Workspace>[],
  contextId: string | null,
  current: Current,
): WithId<Workspace> | null {
  return (
    list.find(
      (w) =>
        w.id === contextId &&
        ('boardId' in current
          ? w.boardIds.includes(current.boardId)
          : w.artifactIds.includes(current.artifactId)),
    ) ?? null
  );
}

export function switcherItems(o: {
  boards: readonly WithId<Board>[];
  artifacts: readonly WithId<Artifact>[];
  workspace: WithId<Workspace> | null;
  current: Current;
  leave: () => void;
}): MenuItem[] {
  const boards = o.boards.filter((b) => b.archivedAt == null);
  const artifacts = o.artifacts.filter((a) => a.archivedAt == null);
  const boardItem = (b: WithId<Board>): MenuItem => ({
    label: `${b.key} · ${b.name}`,
    href: routes.board(b.key),
    disabled: 'boardId' in o.current && b.id === o.current.boardId,
  });
  const artifactItem = (a: WithId<Artifact>, separator = false): MenuItem => ({
    label: `${artifactGlyph(a)}  ${a.name}`,
    href: routes.artifact(a.id),
    disabled: 'artifactId' in o.current && a.id === o.current.artifactId,
    separator,
  });
  const byName = <T extends { name: string }>(xs: readonly T[]) =>
    [...xs].sort((a, b) => a.name.localeCompare(b.name));

  if (!o.workspace)
    return 'boardId' in o.current
      ? byName(boards).map(boardItem)
      : byName(artifacts).map((a) => artifactItem(a));

  const b = new Map(boards.map((x) => [x.id, x]));
  const a = new Map(artifacts.map((x) => [x.id, x]));
  const inBoards = o.workspace.boardIds.flatMap((id) => b.get(id) ?? []);
  const inArtifacts = o.workspace.artifactIds.flatMap((id) => a.get(id) ?? []);
  return [
    ...inBoards.map(boardItem),
    ...inArtifacts.map((x, i) => artifactItem(x, i === 0 && inBoards.length > 0)),
    {
      label: 'boardId' in o.current ? 'Show all boards' : 'Show all artifacts',
      onSelect: o.leave,
      separator: true,
    },
  ];
}
