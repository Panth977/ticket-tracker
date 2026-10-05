<!--
  Artifact settings › Subscriptions (owner only; lib/access): what this
  artifact's page uses —
    boards    through BackendDriver.tickets (artifacts.html §K): Read / Write;
              write only where I am an editor or admin
    memories  through BackendDriver.memory (memory.html §D, §H): Read / Write;
              memories I own
  Each grant is a ceiling, never a key: the page works as whoever is looking.
-->
<script lang="ts">
  import { roleOf, type ArtifactBoardAccess, type MemoryGrant } from '@tm/shared';
  import { command } from '$lib/api';
  import {
    boardView,
    hiddenView,
    memoryView,
    type Candidate,
    type SubscriptionRow,
  } from '$lib/access/entities';
  import {
    ARTIFACT_BOARD,
    ARTIFACT_MEMORY,
    can,
    type Perms,
    type PermLocks,
  } from '$lib/access/relations';
  import SubscriptionList from '$lib/access/SubscriptionList.svelte';
  import Section from '$lib/board/settings/Section.svelte';
  import { auth } from '$lib/firebase/auth.svelte';
  import { grantOf, ownedMemories } from '$lib/memoryRefs/owned';
  import { myBoards, type WithId } from '$lib/stores';
  import type { Board } from '@tm/shared';
  import { useArtifactSettings } from './context.svelte';

  const s = useArtifactSettings();
  const a = $derived(s.artifact);
  const archived = $derived(a.archivedAt != null);
  const target = $derived({ artifactId: a.id });

  const boardsQ = $derived(myBoards(auth.uid));
  const boardById = $derived(new Map($boardsQ.data.map((b) => [b.id, b])));
  const memoriesQ = $derived(ownedMemories(auth.uid));

  const myRole = (b: WithId<Board> | undefined) => (b && auth.uid ? roleOf(b, auth.uid) : null);
  /** Write needs me to be able to edit there (the command refuses otherwise). */
  const locksFor = (b: WithId<Board> | undefined): PermLocks => {
    const r = myRole(b);
    return r === 'admin' || r === 'editor'
      ? {}
      : { write: 'Needs you to be an editor or admin on this board' };
  };

  const rows = $derived.by((): SubscriptionRow[] => {
    const boards = Object.entries(a.boards ?? {}).map(([id, access]): SubscriptionRow => {
      const b = boardById.get(id);
      return {
        entity: b ? boardView(b) : hiddenView('board', id),
        relation: ARTIFACT_BOARD,
        perms: ARTIFACT_BOARD.toPerms(access),
        locks: locksFor(b),
        edit: archived
          ? 'Restore the artifact to change this'
          : can.grantBoardToArtifact({ ownsArtifact: s.isOwner, onBoard: !!b }),
        remove: can.revokeBoardFromArtifact({
          ownsArtifact: s.isOwner,
          boardAdmin: myRole(b) === 'admin',
        }),
      };
    });
    const memories = $memoriesQ.data
      .map((m) => ({ m, grant: grantOf(m, target) }))
      .filter((x) => x.grant)
      .map(({ m, grant }): SubscriptionRow => ({
        entity: memoryView(m),
        relation: ARTIFACT_MEMORY,
        perms: ARTIFACT_MEMORY.toPerms(grant),
        edit: archived
          ? 'Restore the artifact to change this'
          : can.grantMemoryToArtifact({ ownsMemory: true, ownsArtifact: s.isOwner }),
        remove: can.revokeMemoryFromArtifact({ ownsMemory: true, ownsArtifact: s.isOwner }),
      }));
    const byName = (x: SubscriptionRow, y: SubscriptionRow) =>
      (x.entity.name ?? '￿').localeCompare(y.entity.name ?? '￿');
    return [...boards.sort(byName), ...memories.sort(byName)];
  });

  const candidates = $derived<Candidate[]>([
    ...$boardsQ.data
      .filter((b) => b.archivedAt == null && !(b.id in (a.boards ?? {})))
      .sort((x, y) => x.name.localeCompare(y.name))
      .map((b) => ({ entity: boardView(b), relation: ARTIFACT_BOARD, locks: locksFor(b) })),
    ...$memoriesQ.data
      .filter((m) => m.archivedAt == null && !grantOf(m, target))
      .map((m) => ({ entity: memoryView(m), relation: ARTIFACT_MEMORY })),
  ]);
  const canAdd = $derived(
    !s.isOwner
      ? 'Only the artifact’s owner chooses what it uses'
      : archived
        ? 'Restore the artifact to change this'
        : true,
  );

  async function setBoard(boardId: string, access: ArtifactBoardAccess | null, headline: string) {
    try {
      await command(
        'artifactBoardAccessSet',
        { artifactId: a.id, boardId, access },
        { toast: headline },
      );
      return true;
    } catch {
      return false; // toasted; the list shows the live document
    }
  }
  async function setMemory(memoryId: string, access: MemoryGrant | null, headline: string) {
    try {
      await command('memoryGrantSet', { memoryId, artifactId: a.id, access }, { toast: headline });
      return true;
    } catch {
      return false;
    }
  }
  const onsave = (c: Candidate, p: Perms) =>
    c.entity.kind === 'board'
      ? setBoard(c.entity.id, ARTIFACT_BOARD.fromPerms(p), 'Could not change board access')
      : setMemory(c.entity.id, ARTIFACT_MEMORY.fromPerms(p), 'Could not change memory access');
  const onremove = (r: SubscriptionRow) =>
    r.entity.kind === 'board'
      ? setBoard(r.entity.id, null, 'Could not remove the board')
      : setMemory(r.entity.id, null, 'Could not remove the memory');
</script>

<Section
  title="Subscriptions"
  description="What this artifact's page may use: the tickets of boards you are on (BackendDriver.tickets) and files in memories you own (BackendDriver.memory) — read, or also write. Anyone you share it with still sees and changes only what they already can there."
>
  <SubscriptionList
    name="artifact"
    {rows}
    {candidates}
    {canAdd}
    showKind
    loading={$boardsQ.loading || $memoriesQ.loading}
    addTitle="Add a board or memory"
    empty="It uses nothing yet: BackendDriver.tickets and BackendDriver.memory see nothing."
    nothingToAdd="Every board you are on and every memory you own is already here."
    removeMessage={() => 'The page stops reaching it at once. You can add it again.'}
    {onsave}
    {onremove}
  />
</Section>
