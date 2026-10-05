<!--
  Board settings › Subscribers (lib/access): everything that uses this board —
  artifacts whose page reads (or writes) its tickets (artifacts.html §K) and
  agents with a role here (agents.html §AA2) — with what each was given.
  Nothing is added here: an artifact's owner adds the board in the artifact's
  Subscriptions, an agent's owner in the agent's. A board admin may remove
  any of them (artifactBoardAccessSet / boardAgentSet with null).
-->
<script lang="ts">
  import { paths, type BoardMember } from '@tm/shared';
  import { command } from '$lib/api';
  import { agentView, artifactView, hiddenView, type SubscriberRow } from '$lib/access/entities';
  import { AGENT_BOARD, ARTIFACT_BOARD, can } from '$lib/access/relations';
  import SubscriberList from '$lib/access/SubscriberList.svelte';
  import { removeAgentFromBoard } from '$lib/agents/actions';
  import { agentRoleOf } from '$lib/agents/access';
  import { auth } from '$lib/firebase/auth.svelte';
  import { isAgentId, noteBoardMembers } from '$lib/people';
  import { queryStore } from '$lib/stores';
  import { toast } from '$lib/ui/toast.svelte';
  import Section from './Section.svelte';
  import { useSettings } from './draft.svelte';

  const s = useSettings();
  const board = $derived(s.board);
  const me = $derived(auth.uid ?? '');

  // ── artifacts: the server answers (a person cannot query other people's artifacts) ──
  type Listed = Awaited<ReturnType<typeof load>>;
  let artifacts = $state<Listed | null>(null);
  let version = $state(0);
  const load = (boardId: string) =>
    command('boardArtifactList', { boardId }, { toast: false }).then((r) => r.artifacts);
  $effect(() => {
    void version;
    load(board.id)
      .then((a) => (artifacts = a))
      .catch(() => (artifacts = artifacts ?? []));
  });

  // ── agents: the board's own member docs (name, owner) ──
  const membersQ = $derived(queryStore<BoardMember>({ path: paths.members(board.id) }));
  $effect(() => noteBoardMembers(board.id, $membersQ.data));
  const agents = $derived(
    $membersQ.data
      .filter((m) => (m.kind === 'agent' || isAgentId(m.uid)) && board.access[m.uid] != null)
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  const rows = $derived.by((): SubscriberRow[] => [
    ...(artifacts ?? []).map((a): SubscriberRow => ({
      entity: a.name
        ? artifactView({ id: a.artifactId, name: a.name, indicator: a.indicator })
        : hiddenView('artifact', a.artifactId),
      chips: ARTIFACT_BOARD.chips(ARTIFACT_BOARD.toPerms(a.access)),
      remove: can.revokeBoardFromArtifact({
        ownsArtifact: a.ownerUid === me,
        boardAdmin: s.isAdmin,
      }),
    })),
    ...agents.map((m): SubscriberRow => ({
      entity: agentView({ id: m.uid, name: m.name, mine: m.ownerUid === me }),
      chips: AGENT_BOARD.chips(
        AGENT_BOARD.toPerms({
          role: agentRoleOf(board.access[m.uid]),
          stageGrant: board.stageGrants?.[m.uid] ?? m.stageGrant ?? null,
        }),
        { stages: board.stages },
      ),
      remove: can.changeAgentOnBoard({ boardAdmin: s.isAdmin }),
    })),
  ]);

  async function onremove(r: SubscriberRow): Promise<boolean> {
    if (r.entity.kind === 'agent') {
      const ok = await removeAgentFromBoard(board.id, r.entity.id);
      if (ok) toast.success(`Removed ${r.entity.name ?? 'the agent'}`);
      return ok;
    }
    try {
      await command(
        'artifactBoardAccessSet',
        { artifactId: r.entity.id, boardId: board.id, access: null },
        { toast: 'Could not remove the artifact' },
      );
      version++;
      return true;
    } catch {
      return false; // toasted
    }
  }
</script>

<Section
  title="Subscribers"
  description="Everything that uses this board: artifacts whose page reads or changes its tickets, and agents with a role here. They are added from their own Subscriptions; any board admin can remove them."
>
  <SubscriberList
    name="board"
    {rows}
    loading={artifacts === null || $membersQ.loading}
    empty="Nothing uses this board yet."
    removeMessage={(r) =>
      r.entity.kind === 'agent'
        ? 'It is unassigned from its tickets here and its token stops reaching this board at once. Its messages stay.'
        : 'Its page stops seeing this board’s tickets at once. Its owner can add the board again.'}
    {onremove}
  />
</Section>
