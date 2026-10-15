<!--
  Share a workspace (one-shot, workspaceShare): the people typed here are
  invited to every board in it and given the role on every artifact and
  bucket you own, and get a copy of the workspace in their sidebar. Each item
  is shared exactly as it would be on its own, so nothing new grants access;
  what you add to the workspace later is not shared. The result says what
  went out and what was skipped (a board you may not invite to, an item you
  do not own).
-->
<script lang="ts">
  import {
    WORKSPACE_SHARE_MAX_EMAILS,
    type CommandRes,
    type Workspace,
    type WorkspaceShareRole,
  } from '@tm/shared';
  import { command } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { isEmail, splitEmails } from '$lib/account/inviteDraft';
  import type { WithId } from '$lib/stores';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Select from '$lib/ui/Select.svelte';
  import Textarea from '$lib/ui/Textarea.svelte';

  let {
    open = $bindable(false),
    workspace,
    names = {},
  }: {
    open: boolean;
    workspace: WithId<Workspace>;
    /** id → name of what the page shows, to name what was skipped. */
    names?: Record<string, string>;
  } = $props();

  const ROLES: { value: WorkspaceShareRole; label: string }[] = [
    { value: 'viewer', label: 'Viewer — can look' },
    { value: 'editor', label: 'Editor — can work on it' },
    { value: 'admin', label: 'Admin — can manage the boards' },
  ];

  let emailsText = $state('');
  let role = $state<WorkspaceShareRole>('editor');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let result = $state<CommandRes<'workspaceShare'> | null>(null);

  const items = $derived(
    workspace.boardIds.length + workspace.artifactIds.length + (workspace.bucketIds?.length ?? 0),
  );

  $effect(() => {
    if (open) {
      emailsText = '';
      role = 'editor';
      error = null;
      result = null;
    }
  });

  async function share(e: Event) {
    e.preventDefault();
    const self = auth.user?.email?.toLowerCase();
    const emails = [...new Set(splitEmails(emailsText).map((x) => x.toLowerCase()))].filter(
      (x) => x !== self,
    );
    const bad = emails.filter((x) => !isEmail(x));
    if (!emails.length) return void (error = 'Type at least one address.');
    if (bad.length) return void (error = `Not an address: ${bad.join(', ')}`);
    if (emails.length > WORKSPACE_SHARE_MAX_EMAILS)
      return void (error = `At most ${WORKSPACE_SHARE_MAX_EMAILS} people at once.`);
    busy = true;
    error = null;
    try {
      result = await command(
        'workspaceShare',
        { workspaceId: workspace.id, emails, role },
        { toast: 'Could not share the workspace' },
      );
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }

  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const kindName = { board: 'Board', artifact: 'Artifact', bucket: 'Bucket' } as const;
</script>

<Dialog
  bind:open
  title={`Share “${workspace.name}”`}
  description="Invite people to everything in this workspace at once. Each board, artifact and bucket is shared as it would be on its own; things you add later are not."
>
  {#if result}
    <div class="flex flex-col gap-3 text-sm" data-share-result>
      <ul class="flex flex-col gap-1">
        {#each result.shared as s (s.email)}
          <li data-share-email={s.email}>
            <span class="font-medium">{s.email}</span>
            <span class="text-muted">
              — {plural(s.boards, 'board')}, {plural(s.artifacts, 'artifact')}, {plural(
                s.buckets,
                'bucket',
                'buckets',
              )}
              {#if s.workspace === 'pending'}· gets the workspace when they sign up{:else if s.workspace === 'full'}·
                their sidebar is full (50 workspaces){/if}
            </span>
          </li>
        {/each}
      </ul>
      <p class="text-muted">
        Board invitations wait for them to accept (they get an e-mail). Artifacts and buckets are
        theirs to open now.
      </p>
      {#if result.skipped.length}
        <div data-share-skipped>
          <p class="font-medium">Not shared</p>
          <ul class="list-disc pl-5 text-muted">
            {#each result.skipped as k (k.kind + k.id)}
              <li>{kindName[k.kind]} “{names[k.id] ?? k.id}”: {k.reason}</li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  {:else}
    <form id="workspace-share-form" class="flex flex-col gap-4" onsubmit={share}>
      <Textarea
        label="People"
        placeholder="asha@example.com, priya@example.com"
        bind:value={emailsText}
        rows={3}
        autosize
        hint="E-mail addresses, separated by commas or new lines. They need no account yet."
        {error}
      />
      <Select label="Role" options={ROLES} bind:value={role} />
      <p class="text-sm text-muted">
        {plural(items, 'item')} in this workspace. Admin applies to boards; on artifacts and buckets
        it is Editor.
      </p>
    </form>
  {/if}
  {#snippet footer()}
    {#if result}
      <Button variant="primary" onclick={() => (open = false)}>Done</Button>
    {:else}
      <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
      <Button
        variant="primary"
        type="submit"
        form="workspace-share-form"
        disabled={!emailsText.trim() || !items}
        loading={busy}>Share</Button
      >
    {/if}
  {/snippet}
</Dialog>
