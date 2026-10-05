<!--
  The agent's page › Subscriptions (agents.html §AA2, §AA3, §AA5; lib/access):
  everything this agent may use, and with what —
    boards     a role: View · Comment · Edit · Admin (the highest ticked IS
               the role); a commenter also gets its stage restriction.
               boardAgentSet: adding needs me admin there (and I own the
               agent); changing or removing needs any admin.
    artifacts  Build · Read data · Write data → { build, data }.
               artifactShare: the artifact's owner only.
  "What may this agent do?" has one answer, and it is here.

  WHERE THE LISTS COME FROM: what I already read — my boards (their access
  maps hold agents too) and my artifacts (their `agents` map). The rules give
  a person no "by agent" query; see ./access.
-->
<script lang="ts">
  import type { ArtifactAgentAccess } from '@tm/shared';
  import { command } from '$lib/api';
  import {
    artifactView,
    boardView,
    type Candidate,
    type SubscriptionRow,
  } from '$lib/access/entities';
  import { AGENT_ARTIFACT, AGENT_BOARD, can, type Perms } from '$lib/access/relations';
  import SubscriptionList from '$lib/access/SubscriptionList.svelte';
  import { myArtifacts } from '$lib/artifacts/store';
  import { auth } from '$lib/firebase/auth.svelte';
  import { myBoards } from '$lib/stores';
  import { toast } from '$lib/ui';
  import { agentRoleOf, artifactAgentRemove, artifactAgentShare, artifactsOfAgent } from './access';
  import { addAgentToBoard, removeAgentFromBoard, setAgentGrant } from './actions';
  import { boardsOfAgent } from './agents';

  interface Props {
    agentId: string;
    name: string;
    archived: boolean;
  }
  let { agentId, name, archived }: Props = $props();

  const me = $derived(auth.uid ?? '');
  const boardsQ = $derived(myBoards(me));
  const artifactsQ = $derived(myArtifacts(me || null));
  const RESTORE = 'Restore the agent to change this';

  const rows = $derived.by((): SubscriptionRow[] => [
    ...boardsOfAgent($boardsQ.data, agentId).map((r): SubscriptionRow => {
      const admin = can.changeAgentOnBoard({ boardAdmin: r.board.access[me] === 'admin' });
      return {
        entity: boardView(r.board),
        relation: AGENT_BOARD,
        perms: AGENT_BOARD.toPerms({
          role: agentRoleOf(r.role),
          stageGrant: r.board.stageGrants?.[agentId] ?? null,
        }),
        edit: archived ? RESTORE : admin,
        remove: admin,
      };
    }),
    ...artifactsOfAgent($artifactsQ.data, agentId).map((r): SubscriptionRow => {
      const owner = can.agentOnArtifact({ ownsArtifact: r.artifact.ownerUid === me });
      return {
        entity: artifactView(r.artifact),
        relation: AGENT_ARTIFACT,
        perms: AGENT_ARTIFACT.toPerms(r.access),
        edit: archived ? RESTORE : owner,
        remove: owner,
      };
    }),
  ]);

  const on = $derived(new Set(rows.map((r) => `${r.entity.kind}:${r.entity.id}`)));
  const candidates = $derived<Candidate[]>([
    ...$boardsQ.data
      .filter((b) => b.archivedAt == null && !on.has(`board:${b.id}`))
      .sort((x, y) => x.name.localeCompare(y.name))
      .map((b) => {
        const ok = can.addAgentToBoard({ ownsAgent: true, boardAdmin: b.access?.[me] === 'admin' });
        return {
          entity: boardView(b),
          relation: AGENT_BOARD,
          ...(ok === true ? {} : { disabled: ok }),
        };
      }),
    ...$artifactsQ.data
      .filter((a) => a.archivedAt == null && !on.has(`artifact:${a.id}`))
      .sort((x, y) => x.name.localeCompare(y.name))
      .map((a) => {
        const ok = can.agentOnArtifact({ ownsArtifact: a.ownerUid === me });
        return {
          entity: artifactView(a),
          relation: AGENT_ARTIFACT,
          ...(ok === true ? {} : { disabled: ok }),
        };
      }),
  ]);

  async function share(artifactId: string, access: ArtifactAgentAccess | null, headline: string) {
    try {
      await command(
        'artifactShare',
        access
          ? artifactAgentShare(artifactId, agentId, access)
          : artifactAgentRemove(artifactId, agentId),
        { toast: headline },
      );
      return true;
    } catch {
      return false; // toasted
    }
  }

  async function onsave(c: Candidate, p: Perms, isNew: boolean): Promise<boolean> {
    if (c.entity.kind === 'artifact') {
      const v = AGENT_ARTIFACT.fromPerms(p);
      if (!v) return false;
      const ok = await share(
        c.entity.id,
        v,
        isNew ? 'Could not add the agent' : 'Could not change the access',
      );
      if (ok && isNew) toast.success(`${name} added to ${c.entity.name}`);
      return ok;
    }
    const v = AGENT_BOARD.fromPerms(p);
    if (!v) return false;
    const ok = isNew
      ? await addAgentToBoard(c.entity.id, agentId, v.role, v.stageGrant)
      : await setAgentGrant(c.entity.id, agentId, v.role, v.stageGrant);
    if (ok && isNew) toast.success(`${name} added to ${c.entity.name}`);
    return ok;
  }

  async function onremove(r: SubscriptionRow): Promise<boolean> {
    if (r.entity.kind === 'artifact') return share(r.entity.id, null, 'Could not remove the agent');
    const ok = await removeAgentFromBoard(r.entity.id, agentId);
    if (ok) toast.success(`${name} removed from ${r.entity.name}`);
    return ok;
  }
</script>

<SubscriptionList
  name="agent"
  {rows}
  {candidates}
  canAdd={archived ? 'Restore the agent to add it anywhere' : true}
  showKind
  loading={$boardsQ.loading || $artifactsQ.loading}
  addTitle="Add {name} to a board or artifact"
  empty="It uses nothing yet. Add it to a board so it can be assigned tickets and reach the board with its token, or to an artifact to build it or use its data."
  nothingToAdd="It is already on every board and artifact you have."
  removeMessage={(r) =>
    r.entity.kind === 'board'
      ? `${name} is unassigned from its tickets there and its token stops reaching that board at once. Its messages stay.`
      : `Its token stops reaching ${r.entity.name ?? 'that artifact'} at once.`}
  {onsave}
  {onremove}
/>
