<!--
  The agent's page › ACCESS › Artifacts (agents.html §AA3, §AA5): every
  artifact the agent is on, with its two permissions SEPARATELY — a Build
  checkbox (publish, roll back, download the source) and a Data select
  (None / Read / Read & write, through the data API of §AA4) — Remove, and
  "Add to an artifact" for the artifacts I OWN that it is not on yet.

  artifactShare { artifactId, agentId, agentAccess } is owner-only, so on an
  artifact I merely edit or view the controls are disabled with a tooltip.

  { build: false, data: 'none' } MEANS "remove the agent". A checkbox never
  does that by itself: turning off the last permission asks "Remove the agent
  from this artifact?" first (changeAccess().removes), and saying no leaves the
  row exactly as it was.

  WHERE THE LIST COMES FROM: the artifacts I have a role on (memberUids has
  me), filtered by their `agents` map — the rules give a person no "artifacts
  by agent" query; see ./access. Values are read with agentAccessOf, so a
  pre-§AA 'editor' row shows as Build + Read & write.
-->
<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- hrefs from lib/layout/routes; no base path */
  import { AppWindow, Plus, UserMinus } from 'lucide-svelte';
  import type { Artifact, ArtifactAgentAccess } from '@tm/shared';
  import { command } from '$lib/api';
  import AgentAccessControls from '$lib/artifacts/AgentAccessControls.svelte';
  import { artifactGlyph, myArtifacts } from '$lib/artifacts/store';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import type { WithId } from '$lib/stores';
  import { Button, Dialog, EmptyState, Skeleton, toast } from '$lib/ui';
  import {
    agentAccessLabel,
    artifactAgentRemove,
    artifactAgentShare,
    artifactsOfAgent,
    artifactsToAddAgent,
    changeAccess,
    NEW_AGENT_ACCESS,
  } from './access';

  interface Props {
    agentId: string;
    name: string;
    archived: boolean;
  }
  let { agentId, name, archived }: Props = $props();

  const me = $derived(auth.uid ?? '');
  const artifactsQ = $derived(myArtifacts(me || null));
  const rows = $derived(artifactsOfAgent($artifactsQ.data, agentId));
  const addable = $derived(artifactsToAddAgent($artifactsQ.data, me, agentId));

  let busy = $state<string | null>(null);

  /** The one call everything here makes. */
  async function share(
    input: ReturnType<typeof artifactAgentShare>,
    headline: string,
  ): Promise<boolean> {
    busy = input.artifactId;
    try {
      await command('artifactShare', input, { toast: headline });
      return true;
    } catch {
      return false; // toasted
    } finally {
      busy = null;
    }
  }

  // ── change one control ──
  let removing = $state<WithId<Artifact> | null>(null);
  let removeOpen = $state(false);
  function askRemove(a: WithId<Artifact>) {
    removing = a;
    removeOpen = true;
  }
  async function change(
    a: WithId<Artifact>,
    current: ArtifactAgentAccess,
    patch: Partial<ArtifactAgentAccess>,
  ) {
    const c = changeAccess(current, patch);
    if (c.same) return;
    // The last permission went off: that is a removal, so ask — never just send it.
    if (c.removes) return askRemove(a);
    if (await share(artifactAgentShare(a.id, agentId, c.next), 'Could not change the access'))
      toast.success(`${name} on ${a.name}: ${agentAccessLabel(c.next)}`);
  }
  async function remove() {
    const a = removing;
    if (!a) return;
    if (await share(artifactAgentRemove(a.id, agentId), 'Could not remove the agent')) {
      toast.success(`${name} removed from ${a.name}`);
      removeOpen = false;
    }
  }

  // ── add to an artifact I own ──
  let addId = $state('');
  let addAccess = $state<ArtifactAgentAccess>({ ...NEW_AGENT_ACCESS });
  $effect(() => {
    if (!addable.some((a) => a.id === addId)) addId = addable[0]?.id ?? '';
  });
  const addTarget = $derived(addable.find((a) => a.id === addId) ?? null);
  // Adding with nothing ticked would be "remove" — there is nothing to add.
  const addNothing = $derived(!addAccess.build && addAccess.data === 'none');

  async function add(e: SubmitEvent) {
    e.preventDefault();
    const a = addTarget;
    if (!a || addNothing) return;
    if (await share(artifactAgentShare(a.id, agentId, addAccess), 'Could not add the agent')) {
      toast.success(`${name} added to ${a.name}`, agentAccessLabel(addAccess));
      addAccess = { ...NEW_AGENT_ACCESS };
    }
  }
</script>

{#if $artifactsQ.loading}
  <Skeleton lines={2} height="2.5rem" />
{:else if $artifactsQ.error}
  <p class="text-sm text-danger" role="alert">Couldn’t load your artifacts.</p>
{:else}
  {#if rows.length}
    <ul class="divide-y divide-line rounded-lg border border-line" data-agent-artifacts>
      {#each rows as r (r.artifact.id)}
        {@const owner = r.artifact.ownerUid === me}
        {@const can = owner && !archived}
        {@const why = archived
          ? 'Restore the agent to change this'
          : `Only the owner of ${r.artifact.name} can change this`}
        <li class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
          <a
            href={owner
              ? routes.artifactSettings(r.artifact.id, 'people')
              : routes.artifact(r.artifact.id)}
            class="flex min-w-0 flex-1 basis-40 items-center gap-2 hover:underline"
          >
            <span aria-hidden="true">{artifactGlyph(r.artifact)}</span>
            <span class="truncate font-medium">{r.artifact.name}</span>
          </a>
          <AgentAccessControls
            access={r.access}
            name="{name} on {r.artifact.name}"
            disabled={!can || busy === r.artifact.id}
            reason={can ? undefined : why}
            onchange={(patch) => void change(r.artifact, r.access, patch)}
          />
          <span title={owner ? undefined : why}>
            <Button
              size="sm"
              variant="ghost"
              class="text-danger"
              icon={UserMinus}
              disabled={!owner || busy === r.artifact.id}
              onclick={() => askRemove(r.artifact)}
            >
              Remove
            </Button>
          </span>
        </li>
      {/each}
    </ul>
  {:else}
    <EmptyState
      icon={AppWindow}
      title="Not on any artifact"
      description="Add it to an artifact so its token can publish builds there, or read and write its data."
    />
  {/if}

  {#if !archived}
    {#if addable.length}
      <form
        class="flex flex-col gap-2 rounded-lg border border-dashed border-line p-3"
        onsubmit={add}
        aria-label="Add {name} to an artifact"
      >
        <div class="flex flex-wrap items-end gap-x-3 gap-y-2">
          <label class="flex min-w-0 flex-1 basis-44 flex-col gap-1 text-sm">
            <span class="text-xs text-muted">Add to an artifact</span>
            <select
              bind:value={addId}
              class="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm"
            >
              {#each addable as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
            </select>
          </label>
          <AgentAccessControls
            class="min-h-9"
            access={addAccess}
            name="{name} on {addTarget?.name ?? 'the artifact'}"
            onchange={(patch) => (addAccess = { ...addAccess, ...patch })}
          />
          <Button
            type="submit"
            variant="primary"
            icon={Plus}
            loading={!!addTarget && busy === addTarget.id}
            disabled={!addTarget || addNothing}>Add to artifact</Button
          >
        </div>
        <p class="text-xs text-muted">
          {#if addNothing}
            Pick Build, Data, or both — with neither there is nothing to add.
          {:else}
            Build: publish, roll back, download the source. Data: the artifact’s database and files,
            through the API. An agent never owns, shares, renames or deletes an artifact.
          {/if}
        </p>
      </form>
    {:else}
      <p class="text-xs text-muted">
        {#if $artifactsQ.data.some((a) => a.archivedAt == null && a.ownerUid === me)}
          It is already on every artifact you own.
        {:else}
          You can add it to artifacts you own.
        {/if}
      </p>
    {/if}
  {/if}
{/if}

<Dialog
  bind:open={removeOpen}
  title="Remove {name} from {removing?.name ?? 'this artifact'}?"
  size="sm"
>
  <p class="text-sm">
    Remove the agent from this artifact? With neither Build nor Data it has nothing left there: its
    token stops reaching {removing?.name ?? 'the artifact'} at once. You can add it back at any time.
  </p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (removeOpen = false)}>Cancel</Button>
    <Button variant="danger" loading={!!removing && busy === removing.id} onclick={() => remove()}
      >Remove agent</Button
    >
  {/snippet}
</Dialog>
