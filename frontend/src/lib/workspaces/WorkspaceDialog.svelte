<!--
  New workspace / Edit workspace (agents.html §AB): a name, a description, an
  indicator (indicators.html), and
  which of my boards, artifacts and memories (memory.html §F) are in it —
  picked with the same list and Add dialog as every Subscriptions (lib/access). Boards and artifacts are still
  created where they always were; this only gathers them. Archived ones are
  not offered (they live on the All pages).
-->
<script lang="ts">
  // goto() targets come from lib/layout/routes (the SPA has no base path).
  /* eslint-disable svelte/no-navigation-without-resolve */
  import { goto } from '$app/navigation';
  import {
    DESCRIPTION_MAX,
    WORKSPACE_COLORS,
    WORKSPACE_NAME_MAX,
    indicatorColor,
    indicatorOf,
    type Indicator as IndicatorT,
    type Workspace,
  } from '@tm/shared';
  import { command } from '$lib/api';
  import { auth } from '$lib/firebase/auth.svelte';
  import { routes } from '$lib/layout/routes';
  import { myArtifacts } from '$lib/artifacts/store';
  import { myMemories } from '$lib/memory/store';
  import { myBoards, type WithId } from '$lib/stores';
  import {
    artifactView,
    boardView,
    hiddenView,
    memoryView,
    type Candidate,
    type EntityView,
    type SubscriptionRow,
  } from '$lib/access/entities';
  import { WORKSPACE } from '$lib/access/relations';
  import SubscriptionList from '$lib/access/SubscriptionList.svelte';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import IndicatorField from '$lib/ui/IndicatorField.svelte';
  import Input from '$lib/ui/Input.svelte';
  import Textarea from '$lib/ui/Textarea.svelte';

  let {
    open = $bindable(false),
    workspace = null,
  }: { open: boolean; workspace?: WithId<Workspace> | null } = $props();

  const boardsQ = $derived(myBoards(auth.uid));
  const artifactsQ = $derived(myArtifacts(auth.uid));
  const memoriesQ = $derived(myMemories(auth.uid));

  let name = $state('');
  let description = $state('');
  let indicator = $state<IndicatorT>({ kind: 'color', color: WORKSPACE_COLORS[0] });
  let boardIds = $state<string[]>([]);
  let artifactIds = $state<string[]>([]);
  let memoryIds = $state<string[]>([]);
  let busy = $state(false);

  // A fresh form each time it opens: empty, or the workspace being edited.
  $effect(() => {
    if (!open) return;
    name = workspace?.name ?? '';
    description = workspace?.description ?? '';
    indicator = workspace
      ? indicatorOf(workspace, workspace.id)
      : { kind: 'color', color: WORKSPACE_COLORS[0] };
    boardIds = [...(workspace?.boardIds ?? [])];
    artifactIds = [...(workspace?.artifactIds ?? [])];
    memoryIds = [...(workspace?.memoryIds ?? [])];
  });

  // ── what it includes: the same list + Add dialog as every Subscriptions (lib/access) ──
  type Kind = 'board' | 'artifact' | 'memory';
  const views = $derived({
    board: new Map($boardsQ.data.map((b) => [b.id, boardView(b)])),
    artifact: new Map($artifactsQ.data.map((a) => [a.id, artifactView(a)])),
    memory: new Map($memoriesQ.data.map((m) => [m.id, memoryView(m)])),
  });
  const ids = (k: Kind) => (k === 'board' ? boardIds : k === 'artifact' ? artifactIds : memoryIds);
  function add(kind: string, id: string) {
    if (kind === 'board') boardIds = [...new Set([...boardIds, id])];
    else if (kind === 'artifact') artifactIds = [...new Set([...artifactIds, id])];
    else if (kind === 'memory') memoryIds = [...new Set([...memoryIds, id])];
  }
  function drop(kind: string, id: string) {
    if (kind === 'board') boardIds = boardIds.filter((x) => x !== id);
    else if (kind === 'artifact') artifactIds = artifactIds.filter((x) => x !== id);
    else if (kind === 'memory') memoryIds = memoryIds.filter((x) => x !== id);
  }
  const KINDS: Kind[] = ['board', 'artifact', 'memory'];
  const rows = $derived(
    KINDS.flatMap((k) =>
      ids(k).map((id): SubscriptionRow => ({
        // One archived or no longer shared stays listed (by its kind) until removed.
        entity: views[k].get(id) ?? hiddenView(k, id),
        relation: WORKSPACE,
        perms: { checks: [] },
        edit: true,
        remove: true,
      })),
    ),
  );
  const candidates = $derived<Candidate[]>(
    KINDS.flatMap((k) =>
      [...views[k].values()]
        // Archived ones are not offered (they live on the All pages).
        .filter((e: EntityView) => e.note !== 'archived' && !ids(k).includes(e.id))
        .sort((x, y) => (x.name ?? '').localeCompare(y.name ?? ''))
        .map((e) => ({ entity: e, relation: WORKSPACE })),
    ),
  );

  async function save() {
    const n = name.trim();
    if (!n || busy) return;
    busy = true;
    // The legacy `color` stays coherent: older readers draw the dot from it.
    const color = indicatorColor(indicator);
    const desc = description.trim() || null;
    try {
      if (workspace) {
        await command(
          'workspaceUpdate',
          {
            workspaceId: workspace.id,
            name: n,
            description: desc,
            color,
            indicator,
            boardIds,
            artifactIds,
            memoryIds,
          },
          { toast: 'Could not save the workspace' },
        );
        open = false;
      } else {
        const { workspaceId } = await command(
          'workspaceCreate',
          { name: n, description: desc, color, indicator, boardIds, artifactIds, memoryIds },
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
  size="lg"
  description="Group boards, artifacts and memories you already have. Nothing moves and nobody gains access; it is only how your sidebar shows them."
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
    <Textarea
      label="Description"
      bind:value={description}
      maxlength={DESCRIPTION_MAX}
      rows={2}
      placeholder="What this workspace is for (optional)"
    />
    <div class="flex flex-col gap-1.5">
      <span class="text-sm font-medium">Indicator</span>
      <IndicatorField
        value={indicator}
        seed={workspace?.id ?? name}
        label="Workspace indicator"
        onchange={(i) => (indicator = i)}
      />
    </div>
  </form>
  <!-- Outside the form: the Add dialog is a dialog of its own. -->
  <section class="mt-4 flex flex-col gap-2" aria-label="Includes">
    <h3 class="text-sm font-medium">Includes</h3>
    <SubscriptionList
      name="workspace"
      {rows}
      {candidates}
      canAdd={true}
      showKind
      addTitle="Add to the workspace"
      empty="Nothing yet: add boards, artifacts and memories you already have."
      nothingToAdd="Everything you have is already in it."
      removeMessage={null}
      onsave={async (c) => (add(c.entity.kind, c.entity.id), true)}
      onremove={async (r) => (drop(r.entity.kind, r.entity.id), true)}
    />
  </section>
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
