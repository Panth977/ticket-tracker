<!--
  New agent: a name, a one-line description and (optionally) an icon, then
  its page opens for the picture and system prompt (agents.html §B). The
  prompt starts from a template the owner can keep or replace.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import type { AgentIconId } from '@tm/shared';
  import { command } from '$lib/api';
  import { Avatar, Button, Dialog, Input } from '$lib/ui';
  import AgentIconPicker from './AgentIconPicker.svelte';
  import {
    AGENT_DESCRIPTION_MAX,
    AGENT_NAME_MAX,
    draftErrors,
    freshAgentId,
    STARTER_PROMPT,
  } from './agents';
  import { agentRoutes } from './routes';

  let { open = $bindable(false) }: { open: boolean } = $props();

  let name = $state('');
  let description = $state('');
  let icon = $state<AgentIconId | null>(null);
  let busy = $state(false);
  let touched = $state(false);
  // $state: the avatar preview's colour seed follows the id a reopened dialog mints.
  let agentId = $state(freshAgentId());
  const errors = $derived(draftErrors({ name, description, systemPrompt: '' }));

  $effect(() => {
    if (open) {
      name = '';
      description = '';
      icon = null;
      touched = false;
      agentId = freshAgentId();
    }
  });

  async function create(e: SubmitEvent) {
    e.preventDefault();
    touched = true;
    if (Object.keys(errors).length) return;
    busy = true;
    try {
      const r = await command(
        'agentCreate',
        {
          agentId,
          name: name.trim(),
          description: description.trim() || null,
          systemPrompt: STARTER_PROMPT.replace('{name}', name.trim()),
          icon,
        },
        { toast: 'Could not create the agent', clientId: agentId },
      );
      open = false;
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- built by agentRoutes; the SPA has no base path
      await goto(agentRoutes.agent(r.agentId));
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
</script>

<Dialog
  bind:open
  title="New agent"
  description="An agent is a profile your orchestrator acts as: a name, a picture and a system prompt."
>
  <form id="new-agent" class="flex flex-col gap-4" onsubmit={create} novalidate>
    <div class="flex items-center gap-3">
      <Avatar {icon} name={name || 'Agent'} seed={agentId} size={48} decorative />
      <div class="flex flex-col gap-1">
        <AgentIconPicker
          value={icon}
          name={name || 'Agent'}
          seed={agentId}
          onpick={(id) => (icon = id)}
        />
        <span class="text-xs text-muted">A picture can be added on its page.</span>
      </div>
    </div>
    <Input
      label="Name"
      placeholder="Builder"
      maxlength={AGENT_NAME_MAX}
      bind:value={name}
      error={touched ? errors.name : null}
      required
    />
    <Input
      label="Description"
      hint="One line, shown in pickers."
      placeholder="Implements tickets in the Build stage"
      maxlength={AGENT_DESCRIPTION_MAX}
      bind:value={description}
      error={touched ? errors.description : null}
    />
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button type="submit" form="new-agent" variant="primary" loading={busy}>Create agent</Button>
  {/snippet}
</Dialog>
