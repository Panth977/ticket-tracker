<!--
  Artifact settings › Subscribers (owner only; lib/access): the agents that
  may build this artifact or use its data (agents.html §AA3), with what each
  was given. An agent is added — and its permissions changed — from its own
  page's Subscriptions; here the owner sees them all and can remove one
  (artifactShare with { build: false, data: 'none' }). People are in People.
-->
<script lang="ts">
  import { agentAccessOf } from '@tm/shared';
  import { command } from '$lib/api';
  import { agentView, type SubscriberRow } from '$lib/access/entities';
  import { AGENT_ARTIFACT, can } from '$lib/access/relations';
  import SubscriberList from '$lib/access/SubscriberList.svelte';
  import { artifactAgentRemove } from '$lib/agents/access';
  import { myAgents } from '$lib/agents/agents';
  import Section from '$lib/board/settings/Section.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import { useArtifactSettings } from './context.svelte';

  const s = useArtifactSettings();
  const a = $derived(s.artifact);
  const agentsQ = $derived(myAgents(s.me));
  const names = $derived(new Map($agentsQ.data.map((g) => [g.id, g.name])));

  // §AA3: either stored form → { build, data }; a row that reads as nothing is not on it.
  const rows = $derived(
    Object.keys(a.agents ?? {})
      .map((id) => ({ id, access: agentAccessOf(a.agents[id]) }))
      .filter((r) => r.access.build || r.access.data !== 'none')
      .map((r): SubscriberRow => ({
        entity: agentView({ id: r.id, name: names.get(r.id) ?? null, mine: names.has(r.id) }),
        chips: AGENT_ARTIFACT.chips(AGENT_ARTIFACT.toPerms(r.access)),
        remove: can.agentOnArtifact({ ownsArtifact: s.isOwner }),
      }))
      .sort((x, y) => (x.entity.name ?? '').localeCompare(y.entity.name ?? '')),
  );

  async function onremove(r: SubscriberRow): Promise<boolean> {
    try {
      await command('artifactShare', artifactAgentRemove(a.id, r.entity.id), {
        toast: 'Could not remove the agent',
      });
      toast.success(`Removed ${r.entity.name ?? 'the agent'}`);
      return true;
    } catch {
      return false; // toasted
    }
  }
</script>

<Section
  title="Subscribers"
  description="The agents that may use this artifact: Build (publish, roll back, download the source) and its data (read, or also write) through the API. Add an agent, or change what it may do, from the agent's page › Subscriptions."
>
  <SubscriberList
    name="artifact"
    {rows}
    loading={$agentsQ.loading}
    empty="No agent uses this artifact."
    removeMessage={() =>
      'Its token stops reaching this artifact at once. You can add it again from the agent’s page.'}
    {onremove}
  />
</Section>
