<!--
  Artifact settings › People (owner only; docs/plan/artifacts.html §B).
  An artifact's people are its own — being on a board gives nothing here.

    Add by email · Role ▾            → artifactShare { email, role }
      has an account → the role at once ('granted'); no account → an invite
      that waits for their first sign-in ('invited')
    Person · Role · Remove           owner fixed; editor ⇄ viewer; remove = role null
    Agents                           one of MY agents, with two permissions set
                                     SEPARATELY (agents.html §AA3): a Build
                                     checkbox and a Data select (None / Read /
                                     Read & write) → artifactShare { agentId,
                                     agentAccess }. Read with agentAccessOf, so
                                     a pre-§AA 'editor' row shows as Build +
                                     Read & write. Turning off the last one is
                                     a removal, and asks first.
    Pending invites                  invites/ where artifactId == this (the rules
                                     let the owner list them); remove = role null
-->
<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- agentRoutes; the SPA has no base path */
  import { Bot, Clock, Mail, Plus, Send, UserMinus, X } from 'lucide-svelte';
  import {
    agentAccessOf,
    paths,
    type ArtifactAgentAccess,
    type ArtifactShareRole,
    type Invite,
  } from '@tm/shared';
  import { command } from '$lib/api';
  import {
    agentAccessLabel,
    artifactAgentRemove,
    artifactAgentShare,
    changeAccess,
    NEW_AGENT_ACCESS,
  } from '$lib/agents/access';
  import { myAgents, sortAgents } from '$lib/agents/agents';
  import { agentRoutes } from '$lib/agents/routes';
  import Section from '$lib/board/settings/Section.svelte';
  import { Principal, PrincipalAvatar } from '$lib/people';
  import { queryStore } from '$lib/stores';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import IconButton from '$lib/ui/IconButton.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import AgentAccessControls from '../AgentAccessControls.svelte';
  import { accessRows } from '../store';
  import { useArtifactSettings } from './context.svelte';
  import PersonRow from './PersonRow.svelte';

  const s = useArtifactSettings();
  const a = $derived(s.artifact);
  // Sharing an archived artifact would hand people something they cannot use.
  const editable = $derived(s.isOwner && a.archivedAt == null);
  const people = $derived(accessRows(a));
  // §AA3: either stored form → { build, data }. A row that normalises to
  // nothing is not on the artifact, so it is not listed.
  const agentRows = $derived(
    Object.keys(a.agents ?? {})
      .sort()
      .map((id) => ({ id, access: agentAccessOf(a.agents[id]) }))
      .filter((r) => r.access.build || r.access.data !== 'none'),
  );

  const ROLE_LABEL: Record<ArtifactShareRole, string> = { editor: 'Editor', viewer: 'Viewer' };
  const ROLE_HINT: Record<ArtifactShareRole, string> = {
    editor: 'Opens it, reads and writes its data, publishes builds and rolls back',
    viewer: 'Opens it and reads its data; writes too unless it is read-only for viewers',
  };

  /** The one call every PERSON row makes. Returns the outcome, or null when it failed (toasted). */
  let working = $state<string | null>(null);
  async function share(who: { email: string }, role: ArtifactShareRole | null, headline: string) {
    working = who.email;
    try {
      const r = await command(
        'artifactShare',
        { artifactId: a.id, ...who, role },
        { toast: headline },
      );
      return r.outcome;
    } catch {
      return null;
    } finally {
      working = null;
    }
  }

  // ── add by email ──
  let email = $state('');
  let role = $state<ArtifactShareRole>('viewer');
  const clean = $derived(email.trim().toLowerCase());
  const valid = $derived(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean));

  async function add(e: SubmitEvent) {
    e.preventDefault();
    if (!valid) return;
    const outcome = await share({ email: clean }, role, 'Could not share the artifact');
    if (!outcome) return;
    toast.success(
      outcome === 'invited' ? `Invited ${clean}` : `Shared with ${clean}`,
      outcome === 'invited'
        ? 'They have no account yet — the invite waits for their first sign-in.'
        : `They can open it now as ${ROLE_LABEL[role].toLowerCase()}.`,
    );
    email = '';
  }
  async function setRole(personEmail: string, r: ArtifactShareRole) {
    if (await share({ email: personEmail }, r, 'Could not change the role'))
      toast.success(`${personEmail} is now ${ROLE_LABEL[r].toLowerCase()}`);
  }
  async function remove(personEmail: string, name: string) {
    if (!confirm(`Remove ${name} from ${a.name}? They lose access to it and its data at once.`))
      return;
    if (await share({ email: personEmail }, null, 'Could not remove them'))
      toast.success(`Removed ${name}`);
  }

  // ── agents: mine, not yet on it ──
  const agentsQ = $derived(myAgents(s.isOwner ? s.me : null));
  const available = $derived(
    sortAgents($agentsQ.data).filter((g) => g.archivedAt == null && !(g.id in (a.agents ?? {}))),
  );
  let agentId = $state('');
  $effect(() => {
    if (!available.some((g) => g.id === agentId)) agentId = available[0]?.id ?? '';
  });
  const picked = $derived(available.find((g) => g.id === agentId) ?? null);
  /** … and the one every AGENT row makes (§AA3): always the { build, data } form. */
  async function shareAgent(id: string, access: ArtifactAgentAccess | null, headline: string) {
    working = id;
    try {
      await command(
        'artifactShare',
        access ? artifactAgentShare(a.id, id, access) : artifactAgentRemove(a.id, id),
        { toast: headline },
      );
      return true;
    } catch {
      return false; // toasted
    } finally {
      working = null;
    }
  }
  let addAccess = $state<ArtifactAgentAccess>({ ...NEW_AGENT_ACCESS });
  // With neither ticked there is nothing to add ({ false, 'none' } means "remove").
  const addNothing = $derived(!addAccess.build && addAccess.data === 'none');
  async function addAgent(e: SubmitEvent) {
    e.preventDefault();
    if (!picked || addNothing) return;
    const name = picked.name;
    if (await shareAgent(picked.id, addAccess, 'Could not add the agent')) {
      toast.success(`${name} added`, agentAccessLabel(addAccess));
      addAccess = { ...NEW_AGENT_ACCESS };
    }
  }
  // Removing — from the Remove button, or because the last permission was turned off.
  let removingAgent = $state<string | null>(null);
  let removeAgentOpen = $state(false);
  function askRemoveAgent(id: string) {
    removingAgent = id;
    removeAgentOpen = true;
  }
  async function changeAgent(
    id: string,
    current: ArtifactAgentAccess,
    patch: Partial<ArtifactAgentAccess>,
  ) {
    const c = changeAccess(current, patch);
    if (c.same) return;
    // A checkbox never removes anyone by itself: ask, and leave the row alone on "no".
    if (c.removes) return askRemoveAgent(id);
    if (await shareAgent(id, c.next, 'Could not change the access'))
      toast.success(`Access changed: ${agentAccessLabel(c.next)}`);
  }
  async function removeAgent() {
    if (!removingAgent) return;
    if (await shareAgent(removingAgent, null, 'Could not remove the agent')) {
      toast.success('Agent removed');
      removeAgentOpen = false;
    }
  }

  // ── pending invites (people with no account yet) ──
  const invitesQ = $derived(
    queryStore<Invite>(
      s.isOwner
        ? {
            path: paths.invites(),
            where: [
              ['artifactId', '==', a.id],
              ['status', '==', 'pending'],
            ],
          }
        : null,
    ),
  );
  const invites = $derived([...$invitesQ.data].sort((x, y) => y.createdAt - x.createdAt));
  async function revoke(inv: Invite) {
    if (await share({ email: inv.email }, null, 'Could not remove the invite'))
      toast.success(`Removed the invite for ${inv.email}`);
  }
  const fmt = (ms: number) =>
    new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(ms);
</script>

<Section
  title="People"
  description="Who can open this artifact. Only signed-in people listed here can reach it — there is no public link."
>
  <div class="flex flex-col gap-6">
    {#if editable}
      <form
        class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5"
        onsubmit={add}
        aria-label="Share with someone"
      >
        <div>
          <h3 class="flex items-center gap-1.5 font-medium"><Mail size={15} /> Add by email</h3>
          <p class="text-sm text-muted">
            Someone with an account gets it at once. Anyone else gets an invite that waits for their
            first sign-in.
          </p>
        </div>
        <div class="flex flex-wrap items-start gap-2">
          <label class="min-w-56 flex-1">
            <span class="sr-only">Email address</span>
            <input
              type="email"
              bind:value={email}
              placeholder="ana@example.com"
              autocomplete="off"
              class="h-9 w-full rounded-md border border-line bg-bg px-2.5 text-sm outline-none focus:border-accent"
            />
          </label>
          <label>
            <span class="sr-only">Role</span>
            <select
              bind:value={role}
              class="h-9 rounded-md border border-line bg-surface px-2 text-sm"
              title={ROLE_HINT[role]}
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
          </label>
          <Button
            type="submit"
            variant="primary"
            icon={Send}
            loading={working === clean && !!clean}
            disabled={!valid}>Share</Button
          >
        </div>
        <p class="text-xs text-muted">{ROLE_LABEL[role]}: {ROLE_HINT[role]}.</p>
      </form>
    {/if}

    <div class="overflow-x-auto rounded-xl border border-line bg-surface">
      <table class="w-full min-w-[28rem] text-sm">
        <thead class="border-b border-line text-left text-xs text-muted">
          <tr>
            <th class="px-4 py-2 font-medium">Person</th>
            <th class="px-2 py-2 font-medium">Role</th>
            <th class="w-10 px-2 py-2"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-line">
          {#each people as p (p.uid)}
            <PersonRow
              uid={p.uid}
              role={p.role}
              self={p.uid === s.me}
              {editable}
              busy={working != null}
              onrole={(em, r) => void setRole(em, r)}
              onremove={(em, name) => void remove(em, name)}
            />
          {/each}
        </tbody>
      </table>
    </div>

    <section class="flex flex-col gap-3" aria-label="Agents">
      <div>
        <h3 class="flex items-center gap-1.5 font-medium">
          <Bot size={15} /> Agents
          <span class="text-sm font-normal text-muted">{agentRows.length}</span>
        </h3>
        <p class="text-sm text-muted">
          What an agent’s token may do here, set separately. <strong>Build</strong>: publish, roll
          back, download the source. <strong>Data</strong>: read, or read and write, this artifact’s
          database and files through the API. An agent never owns, shares, renames or deletes it.
        </p>
      </div>
      {#if agentRows.length}
        <ul class="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
          {#each agentRows as r (r.id)}
            <li class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
              <span class="min-w-0 flex-1 basis-40"><Principal id={r.id} layout="stacked" /></span>
              {#if editable}
                <AgentAccessControls
                  access={r.access}
                  name="this agent"
                  disabled={working != null}
                  onchange={(patch) => void changeAgent(r.id, r.access, patch)}
                />
                <IconButton
                  icon={UserMinus}
                  label="Remove agent"
                  size="sm"
                  disabled={working != null}
                  onclick={() => askRemoveAgent(r.id)}
                />
              {:else}
                <span class="text-sm text-muted">{agentAccessLabel(r.access)}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if editable}
        <form class="flex flex-wrap items-end gap-2" onsubmit={addAgent} aria-label="Add agent">
          {#if $agentsQ.loading}
            <p class="text-sm text-muted">Loading your agents…</p>
          {:else if !available.length}
            <p class="text-sm text-muted">
              {#if $agentsQ.data.some((g) => g.archivedAt == null)}All your agents are already on
                this artifact.{:else}You have no agents yet.{/if}
              <a href={agentRoutes.list()} class="text-accent hover:underline">Manage agents</a>
            </p>
          {:else}
            <label class="flex min-w-56 flex-1 flex-col gap-1 text-sm">
              <span class="text-xs text-muted">Add one of your agents</span>
              <span class="flex items-center gap-2">
                {#if picked}<PrincipalAvatar id={picked.id} size={28} />{/if}
                <select
                  bind:value={agentId}
                  class="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm"
                  aria-label="Agent"
                >
                  {#each available as g (g.id)}<option value={g.id}
                      >{g.name}{g.description ? ` — ${g.description}` : ''}</option
                    >{/each}
                </select>
              </span>
            </label>
            <AgentAccessControls
              class="min-h-9"
              access={addAccess}
              name={picked?.name ?? 'the agent'}
              onchange={(patch) => (addAccess = { ...addAccess, ...patch })}
            />
            <Button
              type="submit"
              icon={Plus}
              loading={!!picked && working === picked.id}
              disabled={!picked || addNothing}>Add agent</Button
            >
          {/if}
        </form>
      {/if}
    </section>

    {#if s.isOwner && (invites.length || $invitesQ.error)}
      <section class="flex flex-col gap-2" aria-label="Pending invites">
        <h3 class="flex items-center gap-1.5 font-medium">
          <Clock size={15} /> Pending invites
          <span class="text-sm font-normal text-muted">{invites.length}</span>
        </h3>
        {#if $invitesQ.error}
          <p class="text-sm text-danger">Couldn't load invites: {$invitesQ.error.message}</p>
        {:else}
          <ul class="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
            {#each invites as inv (inv.id)}
              {@const expired = inv.expiresAt < Date.now()}
              <li class="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                <span class="min-w-0 flex-1">
                  <span class="font-medium">{inv.email}</span>
                  <span class="text-muted">
                    · {inv.role === 'editor' ? 'Editor' : 'Viewer'} · {expired
                      ? 'expired'
                      : `expires ${fmt(inv.expiresAt)}`}</span
                  >
                </span>
                {#if editable}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={X}
                    disabled={working != null}
                    onclick={() => revoke(inv)}>Remove</Button
                  >
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  </div>
</Section>

<Dialog bind:open={removeAgentOpen} title="Remove the agent from this artifact?" size="sm">
  <p class="text-sm">
    With neither Build nor Data it has nothing left here: its token stops reaching {a.name} at once. You
    can add it back at any time.
  </p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (removeAgentOpen = false)}>Cancel</Button>
    <Button variant="danger" loading={working != null} onclick={() => removeAgent()}
      >Remove agent</Button
    >
  {/snippet}
</Dialog>
