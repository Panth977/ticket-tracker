<!--
  New workspace / Edit workspace (agents.html §AB): a name, a colour, and
  which of my boards and artifacts are in it. Boards and artifacts are still
  created where they always were; this only gathers them. Archived ones are
  not offered (they live on the All pages).
-->
<script lang="ts">
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import { WORKSPACE_COLORS, WORKSPACE_NAME_MAX, type Workspace } from '@tm/shared';
  import { command } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { artifactGlyph, myArtifacts, splitArtifacts } from '$lib/artifacts/store';
  import { myBoards, type WithId } from '$lib/stores';
  import Button from '$lib/ui/Button.svelte';
  import Checkbox from '$lib/ui/Checkbox.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Input from '$lib/ui/Input.svelte';

  let {
    open = $bindable(false),
    workspace = null,
  }: { open: boolean; workspace?: WithId<Workspace> | null } = $props();

  const boardsQ = $derived(myBoards(auth.uid));
  const boards = $derived(
    $boardsQ.data.filter((b) => b.archivedAt == null).sort((a, b) => a.name.localeCompare(b.name)),
  );
  const artifactsQ = $derived(myArtifacts(auth.uid));
  const artifacts = $derived(splitArtifacts($artifactsQ.data).active);

  let name = $state('');
  let color = $state<string>(WORKSPACE_COLORS[0]);
  let boardIds = $state<string[]>([]);
  let artifactIds = $state<string[]>([]);
  let busy = $state(false);

  // A fresh form each time it opens: empty, or the workspace being edited.
  $effect(() => {
    if (!open) return;
    name = workspace?.name ?? '';
    color = workspace?.color ?? WORKSPACE_COLORS[0];
    boardIds = [...(workspace?.boardIds ?? [])];
    artifactIds = [...(workspace?.artifactIds ?? [])];
  });

  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((x) => x !== id);

  async function save() {
    const n = name.trim();
    if (!n || busy) return;
    busy = true;
    try {
      if (workspace) {
        await command(
          'workspaceUpdate',
          { workspaceId: workspace.id, name: n, color, boardIds, artifactIds },
          { toast: 'Could not save the workspace' },
        );
        open = false;
      } else {
        const { workspaceId } = await command(
          'workspaceCreate',
          { name: n, color, boardIds, artifactIds },
          { toast: 'Could not create the workspace' },
        );
        open = false;
        await goto(routes.workspace(workspaceId));
      }
    } catch {
      /* toasted */
    } finally {
      busy = false;
    }
  }
</script>

<Dialog
  bind:open
  title={workspace ? 'Edit workspace' : 'New workspace'}
  size="md"
  description="Group boards and artifacts you already have. Nothing moves and nobody gains access; it is only how your sidebar shows them."
>
  <form
    id="workspace-form"
    class="flex flex-col gap-4"
    onsubmit={(e) => (e.preventDefault(), save())}
  >
    <Input
      label="Name"
      bind:value={name}
      maxlength={WORKSPACE_NAME_MAX}
      required
      placeholder="Freelance"
      autocomplete="off"
    />
    <fieldset class="flex flex-col gap-1.5">
      <legend class="mb-1 text-sm font-medium">Colour</legend>
      <div class="flex flex-wrap gap-2">
        {#each WORKSPACE_COLORS as c (c)}
          <button
            type="button"
            class="size-7 rounded-full border-2 {color === c
              ? 'border-text'
              : 'border-transparent'}"
            style="background: {c}"
            aria-label={c}
            aria-pressed={color === c}
            onclick={() => (color = c)}
          ></button>
        {/each}
      </div>
    </fieldset>
    <div class="grid gap-4 sm:grid-cols-2">
      <fieldset class="flex min-w-0 flex-col gap-1">
        <legend class="mb-1 text-sm font-medium">Boards</legend>
        <div class="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
          {#each boards as b (b.id)}
            <Checkbox
              checked={boardIds.includes(b.id)}
              label="{b.key} · {b.name}"
              onchange={(e) =>
                (boardIds = toggle(boardIds, b.id, (e.currentTarget as HTMLInputElement).checked))}
            />
          {:else}
            <p class="text-xs text-muted">No boards yet.</p>
          {/each}
        </div>
      </fieldset>
      <fieldset class="flex min-w-0 flex-col gap-1">
        <legend class="mb-1 text-sm font-medium">Artifacts</legend>
        <div class="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
          {#each artifacts as a (a.id)}
            <Checkbox
              checked={artifactIds.includes(a.id)}
              label="{artifactGlyph(a)} {a.name}"
              onchange={(e) =>
                (artifactIds = toggle(
                  artifactIds,
                  a.id,
                  (e.currentTarget as HTMLInputElement).checked,
                ))}
            />
          {:else}
            <p class="text-xs text-muted">No artifacts yet.</p>
          {/each}
        </div>
      </fieldset>
    </div>
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button
      variant="primary"
      type="submit"
      form="workspace-form"
      disabled={!name.trim()}
      loading={busy}>{workspace ? 'Save' : 'Create'}</Button
    >
  {/snippet}
</Dialog>
